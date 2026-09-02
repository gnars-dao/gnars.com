"use client";

/**
 * The connected user's position in the UpgraderEth migration, read straight
 * from the contract with wagmi. Every value is `undefined` until it has actually
 * been read; a failed read surfaces as `isError`, never as a zero — a false zero
 * here would tell someone their deposit is gone.
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
  /** ETH (wei) the user has deposited and not withdrawn. */
  deposited: bigint | undefined;
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
  const { address } = useUserAddress();
  const enabled = isMigrationDepositLive() && Boolean(address);
  const upgrader = UPGRADER_ADDRESS as Address;
  const id = MIGRATION_UPGRADE_ID as bigint;
  const user = (address ?? zeroAddress) as Address;

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
    deposited: data?.[0],
    claimable: data?.[1],
    claimed: data?.[2],
    executed,
    buyToken: executed ? buyToken : undefined,
    totalDeposited: data?.[4],
    halted: data?.[5],
    refetch: doRefetch,
  };
}
