/** Read-only live integration probe. Never publishes orders or broadcasts transactions. */
import assert from "node:assert/strict";
import { isAddress, type Address } from "viem";
import { DAO_ADDRESSES } from "../src/lib/config";
import {
  getOpenSeaCancellation,
  parseOpenSeaListingFees,
} from "../src/lib/marketplace/opensea-listing";
import { SEAPORT_ADDRESS } from "../src/lib/marketplace/seaport";
import type { MarketplaceFulfillment, MarketplacePage } from "../src/types/marketplace";

const origin = new URL(process.argv[2] ?? "http://localhost:3100");
const buyer = process.argv[3] ?? DAO_ADDRESSES.treasury;

async function main() {
  assert(
    ["localhost", "127.0.0.1", "www.gnars.com", "gnars.com"].includes(origin.hostname),
    "Unrecognized app host",
  );
  assert(isAddress(buyer), "Invalid simulation buyer");
  process.loadEnvFile(".env.local");
  assert(process.env.OPENSEA_API_KEY, "OPENSEA_API_KEY required");
  const collectionResponse = await fetch("https://api.opensea.io/api/v2/collections/gnars-dao", {
    headers: { "x-api-key": process.env.OPENSEA_API_KEY },
    signal: AbortSignal.timeout(15000),
  });
  assert(collectionResponse.ok, `OpenSea collection HTTP ${collectionResponse.status}`);
  const fees = parseOpenSeaListingFees(await collectionResponse.json());
  console.log("PASS real OpenSea collection identity and fee policy", JSON.stringify(fees));

  // Only these two POSTs are allowed: both prepare/read data and cannot publish or transact.
  async function app(path: string, body?: unknown) {
    assert(
      !body || ["/opensea/quote", "/fulfillment"].includes(path),
      "Mutation endpoint prohibited",
    );
    const response = await fetch(new URL(`/api/marketplace${path}`, origin), {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45000),
    });
    const result = await response.json();
    assert(
      response.ok,
      `App ${path.split("?")[0]} HTTP ${response.status} code=${result.code ?? "unknown"}`,
    );
    return result;
  }
  const readiness = await app("/readiness");
  assert(readiness.capabilities.openseaSell, "OpenSea selling is not configured");
  const quote = await app("/opensea/quote", { tokenId: "5423", priceWei: "20000000000000000" });
  assert(
    BigInt(quote.quote.sellerWei) +
      quote.quote.fees.reduce(
        (sum: bigint, fee: { amountWei: string }) => sum + BigInt(fee.amountWei),
        0n,
      ) ===
      20000000000000000n,
  );
  console.log("PASS app quote exact seller/fee accounting");
  const page = (await app("?view=listings")) as MarketplacePage;
  assert(page.sources.opensea.available, "Live OpenSea listing source unavailable");
  const item = page.items.find((nft) =>
    nft.offers.some(
      (offer) => offer.source === "opensea" && offer.seller.toLowerCase() !== buyer.toLowerCase(),
    ),
  );
  assert(item, "No live supported listing available to verify");
  const detail = (await app(`/nfts/${item.tokenId}`)) as MarketplacePage;
  assert(detail.ownershipVerified, "Ownership was not verified onchain");
  const offer = detail.items[0]?.offers.find((entry) => entry.source === "opensea");
  assert(offer, "Listing changed while probing; rerun with a fresh listing");
  const order = await app(`/opensea/orders/${offer.orderHash}`);
  const cancellation = getOpenSeaCancellation(order, {
    orderHash: offer.orderHash,
    seller: offer.seller as Address,
    tokenId: item.tokenId,
  });
  assert(cancellation.to.toLowerCase() === SEAPORT_ADDRESS.toLowerCase());
  assert(cancellation.value === 0n);
  console.log(
    "PASS real OpenSea canonical order and exact cancellation encoding",
    item.tokenId,
    offer.orderHash,
  );
  const fulfillment = (await app("/fulfillment", {
    source: "opensea",
    orderHash: offer.orderHash,
    tokenId: item.tokenId,
    buyer,
    expectedPriceWei: offer.priceWei,
  })) as MarketplaceFulfillment;
  assert(fulfillment.transaction.chainId === 8453);
  assert(fulfillment.transaction.to.toLowerCase() === SEAPORT_ADDRESS.toLowerCase());
  assert(fulfillment.transaction.value === offer.priceWei);
  console.log("PASS real OpenSea fulfillment, app validation and read-only onchain simulation");
  console.log(
    "NOT TESTED: real order publication, wallet broadcast or funded trade. No orders or funds changed.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Probe failed";
  console.error(
    message
      .replaceAll(process.env.OPENSEA_API_KEY ?? "__unset__", "[redacted]")
      .replace(/https?:\/\/\S+/g, "[endpoint]"),
  );
  process.exitCode = 1;
});
