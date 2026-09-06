/** Fork-only integration test. Never uses a real wallet or submits upstream writes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc721Abi,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BUILDER_CODE_SUFFIX, DAO_ADDRESSES } from "../src/lib/config";
import { encodeOpenSeaFulfillment } from "../src/lib/marketplace/opensea-fulfillment";
import {
  getListingCancellation,
  getListingFulfillment,
  getListingOrderHash,
  getListingRoyalty,
  getListingStatus,
  getListingTypedData,
  orderValues,
  SEAPORT_ADDRESS,
  seaportAbi,
  validateListingOnchain,
  type SignedListing,
} from "../src/lib/marketplace/seaport";
import type { MarketplaceOffer } from "../src/types/marketplace";

const rpcUrl = "http://127.0.0.1:18549";
const client = createPublicClient({ chain: base, transport: http(rpcUrl, { retryCount: 0 }) });
const rpc = (method: string, params: unknown[] = []) =>
  client.request({ method, params } as never) as Promise<unknown>;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const infoAbi = parseAbi([
  "function information() view returns(string version,bytes32 domainSeparator,address conduitController)",
]);

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const key = process.env.ALCHEMY_API_KEY;
  assert(key, "ALCHEMY_API_KEY required for read-only fork source");
  assert.equal(new URL(rpcUrl).hostname, "127.0.0.1");
  // Do not attach to an existing node or reset someone else's fork.
  let occupied = false;
  try {
    await client.getChainId();
    occupied = true;
  } catch {
    /* Expected before startup. */
  }
  assert(!occupied, "Fork port already occupied");
  const anvil = spawn(
    process.env.ANVIL_BIN ?? join(homedir(), ".foundry/bin/anvil"),
    [
      "--fork-url",
      `https://base-mainnet.g.alchemy.com/v2/${key}`,
      "--host",
      "127.0.0.1",
      "--port",
      "18549",
      "--chain-id",
      "8453",
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let startupError = "";
  anvil.stderr.on("data", (data: Buffer) => {
    startupError = (startupError + String(data)).slice(-2000);
  });
  let spawnError = false;
  anvil.on("error", () => {
    spawnError = true;
  });
  try {
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (spawnError || anvil.exitCode !== null)
        throw new Error(`Anvil failed to start: ${startupError}`);
      try {
        ready = /anvil/i.test(String(await rpc("web3_clientVersion")));
      } catch {
        /* Starting. */
      }
      if (ready) break;
      await delay(1000);
    }
    assert(ready, "Anvil startup timeout");
    assert.equal(await client.getChainId(), 8453);
    await rpc("anvil_nodeInfo");
    const block = await client.getBlock();
    const [version] = await client.readContract({
      address: SEAPORT_ADDRESS,
      abi: infoAbi,
      functionName: "information",
    });
    assert.equal(version, "1.6", "Seaport domain/address mismatch");
    console.log(
      `PASS [fork] Base block ${block.number}, Seaport ${SEAPORT_ADDRESS} version ${version}`,
    );

    const seller = privateKeyToAccount(generatePrivateKey());
    const buyer = privateKeyToAccount(generatePrivateKey());
    const sellerWallet = createWalletClient({
      account: seller,
      chain: base,
      transport: http(rpcUrl),
    });
    const buyerWallet = createWalletClient({
      account: buyer,
      chain: base,
      transport: http(rpcUrl),
    });
    for (const address of [seller.address, buyer.address])
      await rpc("anvil_setBalance", [address, `0x${parseEther("10").toString(16)}`]);
    const tokenId = 4735n;
    const owner = await client.readContract({
      address: DAO_ADDRESSES.token,
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [tokenId],
    });
    const price = parseEther("0.01");
    const royalty = await getListingRoyalty(client, tokenId, price);
    console.log(
      `PASS [fork read] Gnars royalty at 0.01 ETH: ${royalty.amount} wei, recipient ${royalty.recipient}`,
    );
    await rpc("anvil_setBalance", [owner, `0x${parseEther("1").toString(16)}`]);
    await rpc("anvil_impersonateAccount", [owner]);
    try {
      const donor = createWalletClient({ account: owner, chain: base, transport: http(rpcUrl) });
      const hash = await donor.writeContract({
        address: DAO_ADDRESSES.token,
        abi: erc721Abi,
        functionName: "transferFrom",
        args: [owner, seller.address, tokenId],
      });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    } finally {
      await rpc("anvil_stopImpersonatingAccount", [owner]);
    }
    const approve = async () => {
      const hash = await sellerWallet.writeContract({
        address: DAO_ADDRESSES.token,
        abi: erc721Abi,
        functionName: "approve",
        args: [SEAPORT_ADDRESS, tokenId],
      });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    };
    const build = async (salt: string): Promise<SignedListing> => {
      const now = (await client.getBlock()).timestamp;
      const counter = await client.readContract({
        address: SEAPORT_ADDRESS,
        abi: seaportAbi,
        functionName: "getCounter",
        args: [seller.address],
      });
      const payment = (amount: bigint, recipient: Address) => ({
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: String(amount),
        endAmount: String(amount),
        recipient,
      });
      const parameters: SignedListing["parameters"] = {
        offerer: seller.address,
        zone: zeroAddress,
        offer: [
          {
            itemType: 2,
            token: DAO_ADDRESSES.token,
            identifierOrCriteria: String(tokenId),
            startAmount: "1",
            endAmount: "1",
          },
        ],
        consideration: [
          payment(price - royalty.amount, seller.address),
          ...(royalty.amount ? [payment(royalty.amount, royalty.recipient)] : []),
        ],
        orderType: 0,
        startTime: String(now - 10n),
        endTime: String(now + 86400n),
        zoneHash: zeroHash,
        salt,
        conduitKey: zeroHash,
        counter: String(counter),
      };
      return { parameters, signature: await seller.signTypedData(getListingTypedData(parameters)) };
    };
    await approve();
    const listing = await build("1001");
    await validateListingOnchain(client, listing);
    assert.equal(
      await client.readContract({
        address: SEAPORT_ADDRESS,
        abi: seaportAbi,
        functionName: "getOrderHash",
        args: [orderValues(listing.parameters)],
      }),
      getListingOrderHash(listing.parameters),
    );
    console.log("PASS [fork] approval, signature, on-chain order hash matches helper");
    const send = async (call: { to: Address; data: Hex; value: bigint }, wallet = buyerWallet) => {
      const data = concatHex([call.data, BUILDER_CODE_SUFFIX]);
      const hash = await wallet.sendTransaction({ ...call, data, gas: 700000n });
      assert((await client.getTransaction({ hash })).input.endsWith(BUILDER_CODE_SUFFIX.slice(2)));
      return client.waitForTransactionReceipt({ hash });
    };
    const executeBuy = async (call: { to: Address; data: Hex; value: bigint }) => {
      const beforeSeller = await client.getBalance({ address: seller.address });
      const beforeBuyer = await client.getBalance({ address: buyer.address });
      const beforeRoyalty = await client.getBalance({ address: royalty.recipient });
      const receipt = await send(call);
      assert.equal(receipt.status, "success");
      assert.equal(
        (
          await client.readContract({
            address: DAO_ADDRESSES.token,
            abi: erc721Abi,
            functionName: "ownerOf",
            args: [tokenId],
          })
        ).toLowerCase(),
        buyer.address.toLowerCase(),
      );
      assert.equal(
        (await client.getBalance({ address: seller.address })) - beforeSeller,
        price - royalty.amount,
      );
      if (royalty.amount)
        assert.equal(
          (await client.getBalance({ address: royalty.recipient })) - beforeRoyalty,
          royalty.amount,
        );
      assert(
        beforeBuyer - (await client.getBalance({ address: buyer.address })) >= price,
        "Buyer must pay sale price plus gas",
      );
    };
    await executeBuy(getListingFulfillment(listing));
    assert.equal(await getListingStatus(client, listing), "filled");
    assert.equal((await send(getListingFulfillment(listing))).status, "reverted");
    console.log("PASS [fork] local buy transfers NFT/ETH/royalty; duplicate fill reverts");

    const returnToken = async () => {
      const hash = await buyerWallet.writeContract({
        address: DAO_ADDRESSES.token,
        abi: erc721Abi,
        functionName: "transferFrom",
        args: [buyer.address, seller.address, tokenId],
      });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
      await approve();
    };
    await returnToken();
    const cancelled = await build("1002");
    assert.equal((await send(getListingCancellation(cancelled), sellerWallet)).status, "success");
    assert.equal(await getListingStatus(client, cancelled), "cancelled");
    assert.equal((await send(getListingFulfillment(cancelled))).status, "reverted");
    console.log("PASS [fork] on-chain cancellation invalidates order");

    for (const mode of ["basic", "advanced"] as const) {
      const order = await build(mode === "basic" ? "1003" : "1004");
      const p = orderValues(order.parameters);
      const parameters = { ...p, totalOriginalConsiderationItems: BigInt(p.consideration.length) };
      const input =
        mode === "basic"
          ? {
              parameters: {
                considerationToken: zeroAddress,
                considerationIdentifier: 0n,
                considerationAmount: p.consideration[0].startAmount,
                offerer: seller.address,
                zone: zeroAddress,
                offerToken: DAO_ADDRESSES.token,
                offerIdentifier: tokenId,
                offerAmount: 1n,
                basicOrderType: 0,
                startTime: p.startTime,
                endTime: p.endTime,
                zoneHash: zeroHash,
                salt: p.salt,
                offererConduitKey: zeroHash,
                fulfillerConduitKey: zeroHash,
                totalOriginalAdditionalRecipients: BigInt(p.consideration.length - 1),
                additionalRecipients: p.consideration
                  .slice(1)
                  .map((c) => ({ amount: c.startAmount, recipient: c.recipient })),
                signature: order.signature,
              },
            }
          : {
              advancedOrder: {
                parameters,
                signature: order.signature,
                numerator: 1,
                denominator: 1,
                extraData: "0x",
              },
              criteriaResolvers: [],
              fulfillerConduitKey: zeroHash,
              recipient: buyer.address,
            };
      const offer = {
        source: "opensea",
        orderHash: getListingOrderHash(order.parameters),
        protocolAddress: SEAPORT_ADDRESS,
        seller: seller.address,
        priceWei: String(price),
      } as MarketplaceOffer;
      const call = encodeOpenSeaFulfillment(
        {
          protocol: "seaport",
          fulfillment_data: {
            orders: [{ parameters, signature: order.signature }],
            transaction: {
              chain: 8453,
              to: SEAPORT_ADDRESS,
              value: String(price),
              function: mode === "basic" ? "fulfillBasicOrder" : "fulfillAdvancedOrder",
              input_data: input,
            },
          },
        },
        { offer, tokenId: String(tokenId), buyer: buyer.address },
      );
      await executeBuy(call);
      const staleOwner = await build(mode === "basic" ? "2003" : "2004");
      assert.equal(await getListingStatus(client, staleOwner), "invalid-owner");
      console.log(
        `PASS [fork] generated OpenSea ${mode} encoder executes; owner mismatch detected`,
      );
      await returnToken();
    }
    console.log(
      "PASS [fork] all marketplace smoke checks; no upstream writes or user credentials used",
    );
  } finally {
    anvil.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => anvil.once("exit", resolve)), delay(3000)]);
    if (anvil.exitCode === null) anvil.kill("SIGKILL");
  }
}
main().catch((error: unknown) => {
  // RPC errors may contain the upstream credential. Never print error objects.
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(
    "FAIL [fork]",
    message
      .replaceAll(process.env.ALCHEMY_API_KEY ?? "SECRET_NOT_SET", "[REDACTED]")
      .replace(/https?:\/\/[^\s]+/g, "[RPC URL]"),
  );
  process.exitCode = 1;
});
