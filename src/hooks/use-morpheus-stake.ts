"use client";

// Ethereum mainnet withdrawals, MOR claims, and claim-receiver updates for existing
// positions. New deposits and resumable receiver setup use use-morpheus-stake-flow.
import { useCallback, useRef, useState } from "react";
import { sendTransaction, type ThirdwebClient } from "thirdweb";
import { ethereum } from "thirdweb/chains";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  fallback,
  http,
  parseUnits,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";
import { useWriteAccount } from "@/hooks/use-write-account";
import { prepareTransaction } from "@/lib/builder-code";
import { CACHE_TAGS } from "@/lib/cache-tags";
import {
  depositPoolAbi,
  L1_SENDER,
  LZ_ADAPTER_PARAMS,
  LZ_DST_CHAIN_ID,
  LZ_GATEWAY,
  lzEndpointAbi,
  MOR_REWARD_POOL_INDEX,
  MORPHEUS_POOLS,
  type MorpheusAsset,
} from "@/lib/morpheus";
import { requestRevalidation } from "@/lib/request-revalidation";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain, waitForSuccessfulReceipt } from "@/lib/thirdweb-tx";

/** Quote the LayerZero native fee for a claim (payload is fixed-size, so amount is nominal). */
async function quoteClaimFee(user: Address, amount: bigint): Promise<bigint> {
  const payload = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [user, amount]);
  const [nativeFee] = await rpc.readContract({
    address: LZ_GATEWAY,
    abi: lzEndpointAbi,
    functionName: "estimateFees",
    args: [LZ_DST_CHAIN_ID, L1_SENDER, payload, false, LZ_ADAPTER_PARAMS],
  });
  return (nativeFee * BigInt(120)) / BigInt(100); // +20% margin; excess is refunded on-chain
}

const rpc = createPublicClient({
  chain: mainnet,
  transport: fallback([
    http("https://ethereum.publicnode.com"),
    http("https://eth.llamarpc.com"),
    http("https://rpc.ankr.com/eth"),
  ]),
});
// Bound confirmation waiting without treating a timeout as proof of failure.
// The transaction may still confirm; users must check its status before repeating it.
const RECEIPT_TIMEOUT_MS = 120_000;
async function waitReceipt(client: ThirdwebClient, transactionHash: `0x${string}`): Promise<void> {
  await Promise.race([
    waitForSuccessfulReceipt({ client, chain: ethereum, transactionHash }),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "Transaction confirmation is still pending. Check its status in your wallet before submitting another transaction.",
            ),
          ),
        RECEIPT_TIMEOUT_MS,
      ),
    ),
  ]);
}

export type MorpheusPhase = "idle" | "stake" | "withdraw" | "claim" | "done" | "error";

export function useMorpheusStake() {
  const writer = useWriteAccount();
  const [phase, setPhase] = useState<MorpheusPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  /** Withdraw staked principal (reverts before the 7-day lock lifts). */
  const withdraw = useCallback(
    async (asset: MorpheusAsset, amount: string): Promise<boolean> => {
      if (pending.current) return false;
      const client = getThirdwebClient();
      if (!client) {
        setError("Thirdweb not configured.");
        setPhase("error");
        return false;
      }
      if (!writer) {
        setError("Connect your wallet.");
        setPhase("error");
        return false;
      }
      const { pool, decimals } = MORPHEUS_POOLS[asset];

      let assets: bigint;
      try {
        assets = parseUnits(amount, decimals);
      } catch {
        setError("Invalid amount.");
        setPhase("error");
        return false;
      }

      const account = writer.account;
      setError(null);
      pending.current = true;
      try {
        await ensureOnChain(writer.wallet, ethereum);
        setPhase("withdraw");
        const data = encodeFunctionData({
          abi: depositPoolAbi,
          functionName: "withdraw",
          args: [MOR_REWARD_POOL_INDEX, assets],
        });
        const tx = prepareTransaction({ client, chain: ethereum, to: pool, data });
        const hash = (await sendTransaction({ account, transaction: tx })).transactionHash;
        await waitReceipt(client, hash);
        requestRevalidation([CACHE_TAGS.stake], { transactionHash: hash, chainId: ethereum.id });
        setPhase("done");
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Withdrawal failed.");
        setPhase("error");
        return false;
      } finally {
        pending.current = false;
      }
    },
    [writer],
  );

  /**
   * Claim accrued MOR to `receiver` (own wallet for self-claim, or a Gnars/athlete
   * split for donate mode). Pays the quoted LayerZero fee; excess is refunded.
   */
  const claim = useCallback(
    async (asset: MorpheusAsset, receiver: Address): Promise<boolean> => {
      if (pending.current) return false;
      const client = getThirdwebClient();
      if (!client) {
        setError("Thirdweb not configured.");
        setPhase("error");
        return false;
      }
      if (!writer) {
        setError("Connect your wallet.");
        setPhase("error");
        return false;
      }
      const { pool } = MORPHEUS_POOLS[asset];
      const account = writer.account;
      setError(null);
      pending.current = true;
      try {
        await ensureOnChain(writer.wallet, ethereum);
        setPhase("claim");
        const pending_ = await rpc.readContract({
          address: pool,
          abi: depositPoolAbi,
          functionName: "getLatestUserReward",
          args: [MOR_REWARD_POOL_INDEX, account.address as Address],
        });
        if (pending_ <= BigInt(0)) {
          setError("No MOR to claim yet.");
          setPhase("error");
          return false;
        }
        // Quoting can fail for reasons that have nothing to do with the user
        // (the LayerZero pathway rejecting our params is how every claim died
        // for a while) — and a raw viem revert dump with a selector in it is
        // not an error message. Name the step that failed instead.
        let fee: bigint;
        try {
          fee = await quoteClaimFee(account.address as Address, pending_);
        } catch {
          setError("Couldn't price the bridge fee (mainnet → Arbitrum). Try again in a moment.");
          setPhase("error");
          return false;
        }
        const data = encodeFunctionData({
          abi: depositPoolAbi,
          functionName: "claim",
          args: [MOR_REWARD_POOL_INDEX, receiver],
        });
        const tx = prepareTransaction({ client, chain: ethereum, to: pool, data, value: fee });
        const hash = (await sendTransaction({ account, transaction: tx })).transactionHash;
        await waitReceipt(client, hash);
        requestRevalidation([CACHE_TAGS.stake], { transactionHash: hash, chainId: ethereum.id });
        setPhase("done");
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Claim failed.");
        setPhase("error");
        return false;
      } finally {
        pending.current = false;
      }
    },
    [writer],
  );

  /**
   * Donate mode: point this pool's claim receiver at a Gnars/athlete split.
   * Once set, every future claim (self OR a permissionless keeper `claimFor`)
   * routes 100% of this position's MOR to the split. Set receiver = own wallet
   * to turn donate mode off.
   */
  const setDonateReceiver = useCallback(
    async (asset: MorpheusAsset, receiver: Address): Promise<boolean> => {
      if (pending.current) return false;
      const client = getThirdwebClient();
      if (!client) {
        setError("Thirdweb not configured.");
        setPhase("error");
        return false;
      }
      if (!writer) {
        setError("Connect your wallet.");
        setPhase("error");
        return false;
      }
      const { pool } = MORPHEUS_POOLS[asset];
      const account = writer.account;
      setError(null);
      pending.current = true;
      try {
        await ensureOnChain(writer.wallet, ethereum);
        setPhase("stake");
        const data = encodeFunctionData({
          abi: depositPoolAbi,
          functionName: "setClaimReceiver",
          args: [MOR_REWARD_POOL_INDEX, receiver],
        });
        const tx = prepareTransaction({ client, chain: ethereum, to: pool, data });
        const hash = (await sendTransaction({ account, transaction: tx })).transactionHash;
        await waitReceipt(client, hash);
        requestRevalidation([CACHE_TAGS.stake], { transactionHash: hash, chainId: ethereum.id });
        setPhase("done");
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to set donate mode.");
        setPhase("error");
        return false;
      } finally {
        pending.current = false;
      }
    },
    [writer],
  );

  return {
    withdraw,
    claim,
    setDonateReceiver,
    phase,
    error,
    isBusy: phase === "stake" || phase === "withdraw" || phase === "claim",
  };
}
