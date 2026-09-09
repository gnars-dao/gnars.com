/** Local Anvil fork only. Replaces DAO token with a test fixture; never touches mainnet state. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
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
import { generateMarketplaceSalt } from "../src/lib/marketplace/attribution";
import { GNARS_MARKETPLACE_FEE_POLICY } from "../src/lib/marketplace/community-policy";
import {
  getListingCancellation,
  getListingTypedData,
  validateListingOnchain,
  type SignedListing,
} from "../src/lib/marketplace/seaport";
import { getSweepFulfillment, getSweepResults, sweepAbi } from "../src/lib/marketplace/sweep";

const MARKET = "0xC35813d40961151c11C97cB9d67D0D25CD4Cc86e" as const;
const FORK_BLOCK = 51086095n;
const url = "http://127.0.0.1:18562";
const client = createPublicClient({ chain: base, transport: http(url, { retryCount: 0 }) });
const rpc = (method: string, params: unknown[] = []) =>
  client.request({ method, params } as never) as Promise<unknown>;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  assert.equal(new URL(url).hostname, "127.0.0.1");
  let occupied = false;
  try {
    await client.getChainId();
    occupied = true;
  } catch {
    /* An unused local port is required. */
  }
  assert(!occupied, "Fork port already occupied");
  const compiled = spawnSync(
    join(homedir(), ".foundry/bin/forge"),
    [
      "inspect",
      "test/SweepERC721Fixture.sol:SweepERC721Fixture",
      "deployedBytecode",
      "--root",
      "contracts/gnars-marketplace",
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(compiled.status, 0, "Fixture compile failed");
  const bytecode = compiled.stdout.trim();
  assert(/^0x[0-9a-f]+$/i.test(bytecode));
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
      "18562",
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
      assert(!spawnError && anvil.exitCode === null, "Anvil startup failed");
      try {
        ready = /anvil/i.test(String(await rpc("web3_clientVersion")));
      } catch {
        /* Starting. */
      }
      if (ready) break;
      await delay(1000);
    }
    assert(ready, "Anvil startup timeout");
    assert.equal((await client.getBlock()).number, FORK_BLOCK);
    assert((await client.getCode({ address: MARKET }))!.length > 1000);
    process.env.NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS = MARKET;
    await rpc("anvil_setCode", [DAO_ADDRESSES.token, bytecode]);
    await rpc("evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]);
    const seller = privateKeyToAccount(generatePrivateKey()),
      buyer = privateKeyToAccount(generatePrivateKey());
    const sellerWallet = createWalletClient({ account: seller, chain: base, transport: http(url) });
    const buyerWallet = createWalletClient({ account: buyer, chain: base, transport: http(url) });
    for (const account of [seller, buyer])
      await rpc("anvil_setBalance", [account.address, `0x${parseEther("10").toString(16)}`]);
    const send = async (to: Address, data: Hex, value = 0n, wallet = buyerWallet) => {
      const hash = await wallet.sendTransaction({
        to,
        data: concatHex([data, BUILDER_CODE_SUFFIX]),
        value,
        gas: 1500000n,
      });
      assert((await client.getTransaction({ hash })).input.endsWith(BUILDER_CODE_SUFFIX.slice(2)));
      return client.waitForTransactionReceipt({ hash });
    };
    const price = parseEther("0.01"),
      fee = price / 100n;
    const orders: SignedListing[] = [];
    for (const tokenId of [9000001n, 9000002n, 9000003n, 9000004n, 9000005n]) {
      assert.equal(
        (
          await send(
            DAO_ADDRESSES.token,
            encodeFunctionData({
              abi: parseAbi(["function mint(address owner,uint256 tokenId)"]),
              functionName: "mint",
              args: [seller.address, tokenId],
            }),
            0n,
            sellerWallet,
          )
        ).status,
        "success",
      );
      assert.equal(
        (
          await send(
            DAO_ADDRESSES.token,
            encodeFunctionData({
              abi: erc721Abi,
              functionName: "approve",
              args: [MARKET, tokenId],
            }),
            0n,
            sellerWallet,
          )
        ).status,
        "success",
      );
      const now = (await client.getBlock()).timestamp;
      const payment = (amount: bigint, recipient: Address) => ({
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: amount.toString(),
        endAmount: amount.toString(),
        recipient,
      });
      const parameters: SignedListing["parameters"] = {
        offerer: seller.address,
        zone: zeroAddress,
        offer: [
          {
            itemType: 2,
            token: DAO_ADDRESSES.token,
            identifierOrCriteria: tokenId.toString(),
            startAmount: "1",
            endAmount: "1",
          },
        ],
        consideration: [
          payment(price - fee, seller.address),
          payment(fee, GNARS_MARKETPLACE_FEE_POLICY.recipient),
        ],
        orderType: 0,
        startTime: String(now - 10n),
        endTime: String(now + 86400n),
        zoneHash: zeroHash,
        salt: generateMarketplaceSalt(),
        conduitKey: zeroHash,
        counter: "0",
      };
      const order = {
        parameters,
        signature: await seller.signTypedData(
          getListingTypedData(parameters, { source: "gnars-contract" }),
        ),
      };
      await validateListingOnchain(client, order, {
        source: "gnars-contract",
        requireApproval: true,
      });
      orders.push(order);
    }
    const execute = async (listings: SignedListing[], expectedAvailable: boolean[]) => {
      const tx = getSweepFulfillment(listings);
      const simulated = await client.call({ account: buyer.address, ...tx });
      assert(simulated.data);
      assert.deepEqual(
        decodeFunctionResult({
          abi: sweepAbi,
          functionName: "fulfillAvailableOrders",
          data: simulated.data,
        })[0],
        expectedAvailable,
      );
      const beforeSeller = await client.getBalance({ address: seller.address });
      const beforeSplit = await client.getBalance({
        address: GNARS_MARKETPLACE_FEE_POLICY.recipient,
      });
      const beforeMarket = await client.getBalance({ address: MARKET });
      const receipt = await send(tx.to, tx.data, tx.value);
      assert.equal(receipt.status, "success");
      const result = getSweepResults(listings, buyer.address, receipt.logs);
      const count = BigInt(expectedAvailable.filter(Boolean).length);
      assert.equal(result.spentWei, (count * price).toString());
      assert.equal(result.purchasedTokenIds.length, Number(count));
      assert.equal(result.skippedTokenIds.length, listings.length - Number(count));
      assert.equal(
        (await client.getBalance({ address: seller.address })) - beforeSeller,
        count * (price - fee),
      );
      assert.equal(
        (await client.getBalance({ address: GNARS_MARKETPLACE_FEE_POLICY.recipient })) -
          beforeSplit,
        count * fee,
      );
      assert.equal(
        await client.getBalance({ address: MARKET }),
        beforeMarket,
        "Unspent ETH retained by marketplace",
      );
      type CallTrace = { from: string; to?: string; value?: Hex; calls?: CallTrace[] };
      const trace = (await rpc("debug_traceTransaction", [
        receipt.transactionHash,
        { tracer: "callTracer" },
      ])) as CallTrace;
      const refund = (call: CallTrace): bigint =>
        (call.from.toLowerCase() === MARKET.toLowerCase() &&
        call.to?.toLowerCase() === buyer.address.toLowerCase()
          ? BigInt(call.value ?? "0x0")
          : 0n) + (call.calls ?? []).reduce((total, child) => total + refund(child), 0n);
      // Trace the actual refund independently of Base's additional L1/operator gas fees.
      assert.equal(
        refund(trace),
        tx.value - count * price,
        "Buyer did not receive exact unused ETH refund",
      );
      for (let index = 0; index < listings.length; index++)
        assert.equal(
          (
            await client.readContract({
              address: DAO_ADDRESSES.token,
              abi: erc721Abi,
              functionName: "ownerOf",
              args: [BigInt(listings[index].parameters.offer[0].identifierOrCriteria)],
            })
          ).toLowerCase(),
          (expectedAvailable[index] ? buyer.address : seller.address).toLowerCase(),
        );
      console.log(
        `PASS local fork: ${count}/${listings.length} fills, ${result.spentWei} wei spent, exact split/seller/refund, builder-tagged; gas ${receipt.gasUsed}`,
      );
    };
    await execute(orders.slice(0, 2), [true, true]);
    const cancellation = getListingCancellation(orders[3], { source: "gnars-contract" });
    assert.equal(
      (await send(cancellation.to, cancellation.data, 0n, sellerWallet)).status,
      "success",
    );
    await execute(orders.slice(2), [true, false, true]);
    const replay = getSweepFulfillment(orders.slice(2));
    assert.equal(
      (await send(replay.to, replay.data, replay.value)).status,
      "reverted",
      "Already fulfilled batch replayed",
    );
    console.log(
      `PASS fork block ${FORK_BLOCK}: real deployed marketplace runtime, test-only DAO token override, no mainnet writes`,
    );
  } finally {
    anvil.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => anvil.once("exit", resolve)), delay(3000)]);
    if (anvil.exitCode === null) anvil.kill("SIGKILL");
  }
}
main().catch((error: unknown) => {
  console.error(
    "FAIL local sweep fork",
    error instanceof Error ? error.message : "Unknown failure",
  );
  process.exitCode = 1;
});
