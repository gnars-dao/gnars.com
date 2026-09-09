"use client";

// Claimable Morpho yield across every rider sponsorship vault, so the reward
// panel can surface a "claim yield" per vault alongside the MOR rewards.
// Claims require complete history reconciled against the on-chain position.
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, fallback, formatUnits, http, type Address } from "viem";
import { base } from "viem/chains";
import { RIDERS, type RiderId } from "@/lib/gnars-vaults";
import { readVaultEarnings } from "@/lib/vault-accounting";

const client = createPublicClient({
  chain: base,
  transport: fallback([
    http("https://mainnet.base.org"),
    http("https://base-rpc.publicnode.com"),
    http("https://base.drpc.org"),
  ]),
});

const abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "convertToAssets",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export type VaultReward = {
  riderId: RiderId;
  vault: Address;
  /** USDC micro-units, for the claim (withdraw) call. */
  earnedRaw: bigint;
  /** USDC. */
  earned: number;
};

const DUST = BigInt(100); // 0.0001 USDC in 6-dec units

/** Stable empty result so consumers don't see a new array identity per render. */
const NO_REWARDS: VaultReward[] = [];

async function fetchVaultRewards(account: string): Promise<VaultReward[]> {
  const riders = Object.values(RIDERS).filter((r): r is Rider & { vault: Address } =>
    Boolean(r.vault),
  );
  // Cheap first pass — only the vaults where the wallet actually holds shares
  // are worth the (costlier) earned computation.
  const shares = await Promise.all(
    riders.map((r) =>
      client
        .readContract({
          address: r.vault,
          abi,
          functionName: "balanceOf",
          args: [account as Address],
        })
        .catch(() => BigInt(0)),
    ),
  );
  const held = riders.map((r, i) => ({ r, shares: shares[i] })).filter((x) => x.shares > BigInt(0));

  const out: VaultReward[] = [];
  for (const { r } of held) {
    try {
      const { earned } = await readVaultEarnings(client, r.vault, account as Address);
      if (earned > DUST)
        out.push({
          riderId: r.id,
          vault: r.vault,
          earnedRaw: earned,
          earned: Number(formatUnits(earned, 6)),
        });
    } catch {
      // Unknown basis or incomplete history must never enable a withdrawal.
    }
  }
  return out;
}

/**
 * Cached through react-query: this walks every rider vault on public Base RPCs
 * plus a Blockscout log query per held vault, so a remount or a second consumer
 * must not replay the whole sweep. One key per (account, nonce), 30s fresh.
 *
 * `nonce` remains the post-transaction refetch handle (bump it after a harvest).
 * Post-transaction refreshes clear previous amounts while history catches up.
 *
 * Returns [] while loading, on error, or with no account — same as before.
 */
export function useVaultRewards(account?: string, nonce = 0): VaultReward[] {
  const { data } = useQuery({
    queryKey: ["vault-rewards", account, nonce] as const,
    queryFn: () => fetchVaultRewards(account as string),
    enabled: !!account,
    staleTime: 30_000,
  });

  return data ?? NO_REWARDS;
}

// Local alias so the type-guard predicate reads cleanly.
type Rider = (typeof RIDERS)[RiderId];
