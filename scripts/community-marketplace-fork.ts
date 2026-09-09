/** Isolated localhost fork only: random test signers, no env files, no live broadcasts. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
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
import { BUILDER_CODE, BUILDER_CODE_SUFFIX } from "../src/lib/config";
import { generateMarketplaceSalt } from "../src/lib/marketplace/attribution";
import { COMMUNITY_FEE_RECIPIENT } from "../src/lib/marketplace/community-policy";
import { buildCommunityListingQuote } from "../src/lib/marketplace/listing-intent";
import {
  getListingCancellation,
  getListingFulfillment,
  getListingOrderHash,
  getListingRoyalty,
  getListingTypedData,
  SEAPORT_ADDRESS,
  seaportAbi,
  validateListingOnchain,
  validateListingStructure,
  type SignedListing,
} from "../src/lib/marketplace/seaport";

const MARKET = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e" as const;
const FORK_BLOCK = 51086095n;
const rpcUrl = "http://127.0.0.1:18561";
const client = createPublicClient({ chain: base, transport: http(rpcUrl, { retryCount: 0 }) });
const rpc = (method: string, params: unknown[] = []) =>
  client.request({ method, params } as never) as Promise<unknown>;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  assert.equal(new URL(rpcUrl).hostname, "127.0.0.1");
  let occupied = false;
  try {
    await client.getChainId();
    occupied = true;
  } catch {
    /* Port must be unused. */
  }
  assert(!occupied, "Fork port already occupied");
  const compile = spawnSync(
    join(homedir(), ".foundry/bin/forge"),
    [
      "inspect",
      "test/CommunityERC721Fixture.sol:CommunityERC721Fixture",
      "bytecode",
      "--root",
      "contracts/gnars-marketplace",
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(compile.status, 0, "Test fixture compilation failed");
  const bytecode = compile.stdout.trim();
  assert(/^0x[0-9a-f]+$/i.test(bytecode), "Unexpected fixture creation bytecode");
  const anvil = spawn(
    join(homedir(), ".foundry/bin/anvil"),
    [
      "--fork-url",
      "https://mainnet.base.org",
      "--fork-block-number",
      FORK_BLOCK.toString(),
      "--host",
      "127.0.0.1",
      "--port",
      "18561",
      "--chain-id",
      "8453",
      "--silent",
    ],
    { stdio: "ignore" },
  );
  let spawnError = false;
  anvil.on("error", () => {
    spawnError = true;
  });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      assert(!spawnError && anvil.exitCode === null, "Anvil failed to start");
      try {
        ready = /anvil/i.test(String(await rpc("web3_clientVersion")));
      } catch {
        /* Starting. */
      }
      if (ready) break;
      await delay(1000);
    }
    assert(ready, "Anvil startup timeout");
    await rpc("anvil_nodeInfo");
    assert.equal(await client.getChainId(), 8453);
    assert.equal((await client.getBlock()).number, FORK_BLOCK);
    assert(
      (await client.getCode({ address: MARKET }))?.length! > 1000,
      "Live marketplace missing from fork",
    );
    assert(
      (await client.getCode({ address: COMMUNITY_FEE_RECIPIENT }))?.length! > 10,
      "Split missing from fork",
    );
    // Override only this isolated process; no local/prod environment files are loaded or changed.
    process.env.NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS = MARKET;
    const seller = privateKeyToAccount(generatePrivateKey());
    const buyer = privateKeyToAccount(generatePrivateKey());
    const creator = privateKeyToAccount(generatePrivateKey());
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
    const creation = concatHex([
      encodeDeployData({
        abi: parseAbi(["constructor(address initialOwner,address royalty)"]),
        bytecode: bytecode as Hex,
        args: [seller.address, creator.address],
      }),
      BUILDER_CODE_SUFFIX,
    ]);
    const hash = await sellerWallet.sendTransaction({ data: creation });
    const deployed = await client.waitForTransactionReceipt({ hash });
    assert.equal(deployed.status, "success");
    assert(deployed.contractAddress);
    assert((await client.getTransaction({ hash })).input.endsWith(BUILDER_CODE_SUFFIX.slice(2)));
    const collection = deployed.contractAddress;
    const feePolicy = { basisPoints: 250, recipient: COMMUNITY_FEE_RECIPIENT }; // Explicit test rate, not production policy.
    const options = { source: "gnars-contract" as const, collectionAddress: collection, feePolicy };
    const price = parseEther("0.01");
    const royalty = await getListingRoyalty(client, 1n, price, collection);
    const quote = buildCommunityListingQuote(price.toString(), royalty, feePolicy);
    const send = async (to: Address, data: Hex, value = 0n, wallet = buyerWallet) => {
      const hash = await wallet.sendTransaction({
        to,
        data: concatHex([data, BUILDER_CODE_SUFFIX]),
        value,
        gas: 800000n,
      });
      assert((await client.getTransaction({ hash })).input.endsWith(BUILDER_CODE_SUFFIX.slice(2)));
      return client.waitForTransactionReceipt({ hash });
    };
    const approve = async (operator: Address) =>
      assert.equal(
        (
          await send(
            collection,
            encodeFunctionData({ abi: erc721Abi, functionName: "approve", args: [operator, 1n] }),
            0n,
            sellerWallet,
          )
        ).status,
        "success",
      );
    const build = async (): Promise<SignedListing> => {
      const now = (await client.getBlock()).timestamp;
      const payment = (amount: string, recipient: Address) => ({
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: amount,
        endAmount: amount,
        recipient,
      });
      const parameters: SignedListing["parameters"] = {
        offerer: seller.address,
        zone: zeroAddress,
        offer: [
          {
            itemType: 2,
            token: collection,
            identifierOrCriteria: "1",
            startAmount: "1",
            endAmount: "1",
          },
        ],
        consideration: [
          payment(quote.sellerWei, seller.address),
          ...quote.fees.map((fee) => payment(fee.amountWei, fee.recipient)),
          payment(quote.royaltyWei, creator.address),
        ],
        orderType: 0,
        startTime: String(now - 10n),
        endTime: String(now + 86400n),
        zoneHash: zeroHash,
        salt: generateMarketplaceSalt(),
        conduitKey: zeroHash,
        counter: String(
          await client.readContract({
            address: MARKET,
            abi: seaportAbi,
            functionName: "getCounter",
            args: [seller.address],
          }),
        ),
      };
      assert(
        BigInt(parameters.salt)
          .toString(16)
          .padStart(64, "0")
          .startsWith(Buffer.from(BUILDER_CODE).toString("hex")),
      );
      const listing = {
        parameters,
        signature: await seller.signTypedData(getListingTypedData(parameters, options)),
      };
      validateListingStructure(listing, options);
      return listing;
    };
    const listing = await build();
    const call = getListingFulfillment(listing, options);
    await approve(SEAPORT_ADDRESS);
    assert.equal(
      (await send(SEAPORT_ADDRESS, call.data, price)).status,
      "reverted",
      "Custom signature replayed on canonical domain",
    );
    assert.equal(
      (await send(MARKET, call.data, price)).status,
      "reverted",
      "Canonical approval authorized custom deployment",
    );
    await approve(MARKET);
    await validateListingOnchain(client, listing, options);
    const beforeSeller = await client.getBalance({ address: seller.address });
    const beforeSplit = await client.getBalance({ address: COMMUNITY_FEE_RECIPIENT });
    const beforeCreator = await client.getBalance({ address: creator.address });
    const beforeMarket = await client.getBalance({ address: MARKET });
    const filled = await send(MARKET, call.data, price);
    assert.equal(filled.status, "success");
    assert.equal(
      (await client.getBalance({ address: seller.address })) - beforeSeller,
      BigInt(quote.sellerWei),
    );
    assert.equal(
      (await client.getBalance({ address: COMMUNITY_FEE_RECIPIENT })) - beforeSplit,
      BigInt(quote.fees[0].amountWei),
    );
    assert.equal(
      (await client.getBalance({ address: creator.address })) - beforeCreator,
      royalty.amount,
    );
    assert.equal(
      await client.getBalance({ address: MARKET }),
      beforeMarket,
      "Marketplace retained funds",
    );
    assert.equal(
      (
        await client.readContract({
          address: collection,
          abi: erc721Abi,
          functionName: "ownerOf",
          args: [1n],
        })
      ).toLowerCase(),
      buyer.address.toLowerCase(),
    );
    assert.equal(
      (await send(MARKET, call.data, price)).status,
      "reverted",
      "Duplicate sale succeeded",
    );
    console.log(
      `PASS [local fork ${FORK_BLOCK}] community sale: seller ${quote.sellerWei} wei, split ${quote.fees[0].amountWei} wei, creator ${royalty.amount} wei; 0 retained; buy gas ${filled.gasUsed}`,
    );
    assert.equal(
      (
        await send(
          collection,
          encodeFunctionData({
            abi: erc721Abi,
            functionName: "transferFrom",
            args: [buyer.address, seller.address, 1n],
          }),
        )
      ).status,
      "success",
    );
    await approve(MARKET);
    const cancelled = await build();
    const cancel = getListingCancellation(cancelled, options);
    assert.equal((await send(cancel.to, cancel.data, 0n, sellerWallet)).status, "success");
    const status = await client.readContract({
      address: MARKET,
      abi: seaportAbi,
      functionName: "getOrderStatus",
      args: [getListingOrderHash(cancelled.parameters)],
    });
    assert.equal(status[1], true);
    assert.equal(
      (await send(MARKET, getListingFulfillment(cancelled, options).data, price)).status,
      "reverted",
      "Cancelled order filled",
    );
    console.log(
      "PASS [local fork] builder-tagged deployment/approval/buy/cancel, signed fee+royalty, cross-domain and duplicate replay rejection; no mainnet writes",
    );
  } finally {
    anvil.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => anvil.once("exit", resolve)), delay(3000)]);
    if (anvil.exitCode === null) anvil.kill("SIGKILL");
  }
}
main().catch((error: unknown) => {
  console.error(
    "FAIL [local fork]",
    error instanceof assert.AssertionError
      ? error.message
      : "Community fork check failed; inspect local Anvil and public RPC availability.",
  );
  process.exitCode = 1;
});
