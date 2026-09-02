"use client";

/**
 * The connected user's position in the UpgraderEth migration, read straight
 * from the contract with wagmi. Every value is `undefined` until it has actually
 * been read; a failed read surfaces as `isError`, never as a zero — a false zero
 * here would tell someone their deposit is gone.
 *
 * One person, two addresses: an external wallet under account abstraction has a
 * smart account AND an admin EOA, and the WalletDrawer toggle decides which one
 * signs. A deposit made in SA mode lives under the SA address; flip to EOA and
 * `getUserDeposit(id, EOA)` returns a legitimate zero. So this hook reads BOTH
 * addresses whenever both exist and reports which one holds the deposit, so the
 * UI can say "switch mode" instead of "nothing here".
 */
import { useCallback } from "react";
import { zeroAddress, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { useUserAddress } from "@/hooks/use-user-address";
import {
  CHAIN,
  isMigrationDepositLive,
  MIGRATION_UPGRADE_ID,
  UPGRADER_ADDRESS,
} from "@/lib/config";

export const UPGRADER_READ_ABI = [
  {
    name: "getUserDeposit",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "upgradeId", type: "uint256" },
      { name: "user", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getUserClaim",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "upgradeId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getUserClaimed",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "upgradeId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getBuyToken",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "upgradeId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getTotalDeposit",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "upgradeId", type: "uint256" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isHalted",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface UpgraderPosition {
  /** False while the deposit terminal is not configured (no address / id). */
  enabled: boolean;
  isLoading: boolean;
  isError: boolean;
  /** The address the current view mode signs with — the one `deposited` is for. */
  activeAddress: Address | undefined;
  /** ETH (wei) the user has deposited and not withdrawn, under `activeAddress`. */
  deposited: bigint | undefined;
  /**
   * The user's OTHER address (SA when viewing as EOA, EOA when viewing as SA)
   * and its deposit, when the wallet has two. `undefined` for single-address
   * sessions (in-app wallet, mini app, plain EOA).
   */
  other:
    | {
        address: Address;
        mode: "sa" | "eoa";
        deposited: bigint | undefined;
        claimable: bigint | undefined;
        claimed: boolean | undefined;
      }
    | undefined;
  /** New-token amount claimable after the operator runs execute(). */
  claimable: bigint | undefined;
  claimed: boolean | undefined;
  /** True once execute() has run — deposits and withdrawals are over. */
  executed: boolean | undefined;
  /** New $gnars token address, once execute() has deployed it. */
  buyToken: Address | undefined;
  /** Total ETH (wei) deposited by everyone. */
  totalDeposited: bigint | undefined;
  halted: boolean | undefined;
  refetch: () => void;
}

export function useUpgraderPosition(): UpgraderPosition {
  const { address, saAddress, adminAddress, viewMode, canSwitchView } = useUserAddress();
  const enabled = isMigrationDepositLive() && Boolean(address);
  const upgrader = UPGRADER_ADDRESS as Address;
  const id = MIGRATION_UPGRADE_ID as bigint;
  const user = (address ?? zeroAddress) as Address;
  // The address the other view mode would sign with, when there is one.
  const otherAddress: Address | undefined = canSwitchView
    ? viewMode === "eoa"
      ? saAddress
      : adminAddress
    : undefined;
  const otherUser = (otherAddress ?? zeroAddress) as Address;

  const { data, isLoading, isError, refetch } = useReadContracts({
    allowFailure: false,
    query: { enabled, refetchInterval: 30_000 },
    contracts: [
      {
        address: upgrader,
        abi: UPGRADER_READ_ABI,
        functionName: "getUserDeposit",
        args: [id, user, zeroAddress],
        chainId: CHAIN.id,
      },
      {
        address: upgrader,
        abi: UPGRADER_READ_ABI,
        functionName: "getUserClaim",
        args: [id, user],
        chainId: CHAIN.id,
      },
      {
        address: upgrader,
        abi: UPGRADER_READ_ABI,
        functionName: "getUserClaimed",
        args: [id, user],
        chainId: CHAIN.id,
      },
      {
        address: upgrader,
        abi: UPGRADER_READ_ABI,
        functionName: "getBuyToken",
        args: [id],
        chainId: CHAIN.id,
      },
      {
        address: upgrader,
        abi: UPGRADER_READ_ABI,
        functionName: "getTotalDeposit",
        args: [id, zeroAddress],
        chainId: CHAIN.id,
      },
      { address: upgrader, abi: UPGRADER_READ_ABI, functionName: "isHalted", chainId: CHAIN.id },
      // The other address's position. Read against address(0) when there is no
      // other address, so the tuple shape is stable; the result is ignored then.
      {
        address: upgrader,
        abi: UPGRADER_READ_ABI,
        functionName: "getUserDeposit",
        args: [id, otherUser, zeroAddress],
        chainId: CHAIN.id,
      },
      {
        address: upgrader,
        abi: UPGRADER_READ_ABI,
        functionName: "getUserClaim",
        args: [id, otherUser],
        chainId: CHAIN.id,
      },
      {
        address: upgrader,
        abi: UPGRADER_READ_ABI,
        functionName: "getUserClaimed",
        args: [id, otherUser],
        chainId: CHAIN.id,
      },
    ],
  });

  const buyToken = data?.[3];
  const executed = buyToken === undefined ? undefined : buyToken !== zeroAddress;

  const doRefetch = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    enabled,
    isLoading: enabled && isLoading,
    isError: enabled && isError,
    activeAddress: address as Address | undefined,
    deposited: data?.[0],
    other: otherAddress
      ? {
          address: otherAddress,
          mode: viewMode === "eoa" ? "sa" : "eoa",
          deposited: data?.[6],
          claimable: data?.[7],
          claimed: data?.[8],
        }
      : undefined,
    claimable: data?.[1],
    claimed: data?.[2],
    executed,
    buyToken: executed ? buyToken : undefined,
    totalDeposited: data?.[4],
    halted: data?.[5],
    refetch: doRefetch,
  };
}
