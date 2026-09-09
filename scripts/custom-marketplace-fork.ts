/** All writes go to an isolated local Anvil fork. No env files or existing wallets are loaded. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BUILDER_CODE, BUILDER_CODE_SUFFIX, DAO_ADDRESSES } from "../src/lib/config";
import { generateMarketplaceSalt } from "../src/lib/marketplace/attribution";
import {
  getListingOrderHash,
  getListingTypedData,
  orderValues,
  SEAPORT_ADDRESS,
  seaportAbi,
  type SignedListing,
} from "../src/lib/marketplace/seaport";

const rpcUrl = "http://127.0.0.1:18559";
const client = createPublicClient({ chain: base, transport: http(rpcUrl, { retryCount: 0 }) });
const rpc = (method: string, params: unknown[] = []) =>
  client.request({ method, params } as never) as Promise<unknown>;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const infoAbi = parseAbi([
  "function information() view returns(string version,bytes32 domainSeparator,address conduitController)",
]);
type Artifact = {
  abi: Abi;
  creationBytecode: Hex;
  deployedBytecode: Hex;
  conduitController: Address;
  immutableReferences: Record<string, { start: number; length: number }[]>;
};

async function main() {
  const artifact: Artifact = JSON.parse(
    await readFile("contracts/gnars-marketplace/artifacts/Seaport.json", "utf8"),
  );
  assert.equal(new URL(rpcUrl).hostname, "127.0.0.1");
  let occupied = false;
  try {
    await client.getChainId();
    occupied = true;
  } catch {
    // Expected before startup. Never reset or attach to somebody else's fork.
  }
  assert(!occupied, "Fork port already occupied");
  const anvil = spawn(
    process.env.ANVIL_BIN ?? join(homedir(), ".foundry/bin/anvil"),
    [
      "--fork-url",
      process.env.CUSTOM_MARKETPLACE_FORK_URL ?? "https://mainnet.base.org",
      "--fork-block-number",
      "51021116",
      "--host",
      "127.0.0.1",
      "--port",
      "18559",
      "--chain-id",
      "8453",
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  let spawnError = false;
  anvil.on("error", () => {
    spawnError = true;
  });
  try {
    let ready = false;
    for (let i = 0; i < 90; i++) {
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
    assert.equal(await client.getChainId(), 8453);
    await rpc("anvil_nodeInfo");
    assert.equal((await client.getBlock()).number, 51021116n);

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
    const deploymentData = concatHex([
      encodeDeployData({
        abi: artifact.abi,
        bytecode: artifact.creationBytecode,
        args: [artifact.conduitController],
      }),
      BUILDER_CODE_SUFFIX,
    ]);
    const estimatedGas = await client.estimateGas({
      account: seller.address,
      data: deploymentData,
    });
    const deployHash = await sellerWallet.sendTransaction({
      data: deploymentData,
      gas: estimatedGas,
    });
    const deployed = await client.waitForTransactionReceipt({ hash: deployHash });
    assert.equal(deployed.status, "success");
    assert(deployed.contractAddress);
    const market = deployed.contractAddress;
    assert(
      (await client.getTransaction({ hash: deployHash })).input.endsWith(
        BUILDER_CODE_SUFFIX.slice(2),
      ),
    );
    const [version, domain, controller] = await client.readContract({
      address: market,
      abi: infoAbi,
      functionName: "information",
    });
    const [, canonicalDomain, canonicalController] = await client.readContract({
      address: SEAPORT_ADDRESS,
      abi: infoAbi,
      functionName: "information",
    });
    assert.equal(version, "1.6");
    assert.equal(controller.toLowerCase(), artifact.conduitController.toLowerCase());
    assert.equal(controller.toLowerCase(), canonicalController.toLowerCase());
    assert.notEqual(domain, canonicalDomain, "Own deployment must have its own signing domain");

    const maskImmutables = (code: Hex) => {
      const bytes = Buffer.from(code.slice(2), "hex");
      for (const references of Object.values(artifact.immutableReferences))
        for (const { start, length } of references) bytes.fill(0, start, start + length);
      return bytes.toString("hex");
    };
    const deployedCode = await client.getCode({ address: market });
    const canonicalCode = await client.getCode({ address: SEAPORT_ADDRESS });
    assert(deployedCode && canonicalCode);
    assert.equal(
      maskImmutables(deployedCode),
      maskImmutables(artifact.deployedBytecode),
      "Runtime does not match artifact",
    );
    assert.equal(
      maskImmutables(deployedCode),
      maskImmutables(canonicalCode),
      "Runtime does not match canonical Base Seaport after immutable masking",
    );
    console.log(
      `PASS [local fork] deployment gas estimate ${estimatedGas}; used ${deployed.gasUsed}; runtime ${(deployedCode.length - 2) / 2} bytes; canonical runtime match except immutables`,
    );
    const verification = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/custom-marketplace-verify.ts", market, deployHash],
      { env: { ...process.env, CUSTOM_MARKETPLACE_VERIFY_RPC: rpcUrl }, stdio: "inherit" },
    );
    assert.equal(verification.status, 0, "Read-only deployment verification failed");

    const tokenId = 4735n;
    const price = parseEther("0.01");
    const owner = await client.readContract({
      address: DAO_ADDRESSES.token,
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [tokenId],
    });
    await rpc("anvil_setBalance", [owner, `0x${parseEther("1").toString(16)}`]);
    await rpc("anvil_impersonateAccount", [owner]);
    try {
      const donor = createWalletClient({ account: owner, chain: base, transport: http(rpcUrl) });
      const hash = await donor.sendTransaction({
        to: DAO_ADDRESSES.token,
        data: concatHex([
          encodeFunctionData({
            abi: erc721Abi,
            functionName: "transferFrom",
            args: [owner, seller.address, tokenId],
          }),
          BUILDER_CODE_SUFFIX,
        ]),
      });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    } finally {
      await rpc("anvil_stopImpersonatingAccount", [owner]);
    }

    const send = async (to: Address, data: Hex, value = 0n, wallet = buyerWallet) => {
      const hash = await wallet.sendTransaction({
        to,
        data: concatHex([data, BUILDER_CODE_SUFFIX]),
        value,
        gas: 700000n,
      });
      assert((await client.getTransaction({ hash })).input.endsWith(BUILDER_CODE_SUFFIX.slice(2)));
      return client.waitForTransactionReceipt({ hash });
    };
    const approve = async (operator: Address) =>
      assert.equal(
        (
          await send(
            DAO_ADDRESSES.token,
            encodeFunctionData({
              abi: erc721Abi,
              functionName: "approve",
              args: [operator, tokenId],
            }),
            0n,
            sellerWallet,
          )
        ).status,
        "success",
      );
    const build = async (verifyingContract: Address = market): Promise<SignedListing> => {
      const now = (await client.getBlock()).timestamp;
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
        // Explicit zero-fee fixture, demonstrating the engine imposes no platform deduction.
        consideration: [
          {
            itemType: 0,
            token: zeroAddress,
            identifierOrCriteria: "0",
            startAmount: String(price),
            endAmount: String(price),
            recipient: seller.address,
          },
        ],
        orderType: 0,
        startTime: String(now - 10n),
        endTime: String(now + 86400n),
        zoneHash: zeroHash,
        salt: generateMarketplaceSalt(),
        conduitKey: zeroHash,
        counter: String(
          await client.readContract({
            address: verifyingContract,
            abi: seaportAbi,
            functionName: "getCounter",
            args: [seller.address],
          }),
        ),
      };
      const typed = getListingTypedData(parameters);
      assert(
        BigInt(parameters.salt)
          .toString(16)
          .padStart(64, "0")
          .startsWith(Buffer.from(BUILDER_CODE).toString("hex")),
        "Signed order salt must carry builder provenance",
      );
      return {
        parameters,
        signature: await seller.signTypedData({
          ...typed,
          domain: { ...typed.domain, verifyingContract },
        }),
      };
    };
    const buy = (order: SignedListing, target: Address = market) => {
      const p = orderValues(order.parameters);
      return send(
        target,
        encodeFunctionData({
          abi: seaportAbi,
          functionName: "fulfillOrder",
          args: [
            {
              parameters: { ...p, totalOriginalConsiderationItems: BigInt(p.consideration.length) },
              signature: order.signature,
            },
            zeroHash,
          ],
        }),
        price,
      );
    };
    const listing = await build();
    const hash = getListingOrderHash(listing.parameters);
    assert.equal(
      await client.readContract({
        address: market,
        abi: seaportAbi,
        functionName: "getOrderHash",
        args: [orderValues(listing.parameters)],
      }),
      hash,
    );
    await approve(SEAPORT_ADDRESS);
    assert.equal(
      (await buy(listing)).status,
      "reverted",
      "Canonical approval must not authorize own deployment",
    );
    assert.equal(
      (await buy(listing, SEAPORT_ADDRESS)).status,
      "reverted",
      "Custom signature must not replay on canonical Seaport",
    );
    await approve(market);
    assert.equal(
      (await buy(await build(SEAPORT_ADDRESS))).status,
      "reverted",
      "Canonical signature must not replay on own deployment",
    );
    const beforeSeller = await client.getBalance({ address: seller.address });
    assert.equal((await buy(listing)).status, "success");
    assert.equal(
      (await client.getBalance({ address: seller.address })) - beforeSeller,
      price,
      "Seller must receive 100% with no protocol/platform cut",
    );
    assert.equal(
      await client.getBalance({ address: market }),
      0n,
      "Marketplace must not retain sale funds",
    );
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
    assert.equal((await buy(listing)).status, "reverted", "Duplicate fill must revert");
    console.log(
      "PASS [local fork] own approval, builder-tagged signature/transactions, exact full-price payout, no retained funds, duplicate fill and cross-contract replay blocked",
    );

    assert.equal(
      (
        await send(
          DAO_ADDRESSES.token,
          encodeFunctionData({
            abi: erc721Abi,
            functionName: "transferFrom",
            args: [buyer.address, seller.address, tokenId],
          }),
        )
      ).status,
      "success",
    );
    await approve(market);
    const cancelled = await build();
    assert.equal(
      (
        await send(
          market,
          encodeFunctionData({
            abi: seaportAbi,
            functionName: "cancel",
            args: [[orderValues(cancelled.parameters)]],
          }),
          0n,
          sellerWallet,
        )
      ).status,
      "success",
    );
    const status = await client.readContract({
      address: market,
      abi: seaportAbi,
      functionName: "getOrderStatus",
      args: [getListingOrderHash(cancelled.parameters)],
    });
    assert.equal(status[1], true);
    assert.equal((await buy(cancelled)).status, "reverted");
    console.log(
      "PASS [local fork] cancellation invalidates exact signed order; no mainnet deployment or writes performed",
    );
  } finally {
    anvil.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => anvil.once("exit", resolve)), delay(3000)]);
    if (anvil.exitCode === null) anvil.kill("SIGKILL");
  }
}

main().catch((error: unknown) => {
  // Never print RPC errors: an explicitly supplied upstream endpoint may contain a credential.
  console.error(
    "FAIL [local fork]",
    error instanceof assert.AssertionError
      ? error.message
      : "Fork check failed. Check public RPC availability and local Anvil.",
  );
  process.exitCode = 1;
});
