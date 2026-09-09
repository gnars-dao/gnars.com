import { zeroAddress, type Address } from "viem";

/**
 * The exact shape of every UpgraderEth call the site makes, in one place, so a
 * test can pin the encoded calldata. This file exists because the deposit
 * signature was modelled wrong once (a fifth `bool donation` that the contract
 * never had); an ABI-level mistake here is the one that costs real money.
 *
 * Verified against the live contract on Base (2026-09-01):
 *   deposit(uint256 upgradeId, address user, address token, uint256 quantity) payable
 *   withdraw(uint256 upgradeId, address user, address token, uint256 quantity) payable
 *   claim(uint256 upgradeId, address user) returns (uint256)
 *
 * ETH is the only eligible token: `token` is address(0) and the ETH rides as
 * msg.value, so for a deposit `value === quantity` always. `user` MUST be the
 * address that signs (msg.sender) — the contract checks that before anything
 * else and reverts "Not authorized" otherwise.
 */
export const UPGRADER_DEPOSIT_METHOD =
  "function deposit(uint256 upgradeId, address user, address token, uint256 quantity) payable" as const;
export const UPGRADER_WITHDRAW_METHOD =
  "function withdraw(uint256 upgradeId, address user, address token, uint256 quantity) payable" as const;
export const UPGRADER_CLAIM_METHOD =
  "function claim(uint256 upgradeId, address user) returns (uint256)" as const;

export interface UpgraderCall<M extends string, P extends readonly unknown[]> {
  method: M;
  params: P;
  /** ETH attached to the call (wei). */
  value: bigint;
}

export function depositCall(
  upgradeId: bigint,
  signer: Address,
  amount: bigint,
): UpgraderCall<typeof UPGRADER_DEPOSIT_METHOD, readonly [bigint, Address, Address, bigint]> {
  if (amount <= 0n) throw new Error("deposit amount must be positive");
  return {
    method: UPGRADER_DEPOSIT_METHOD,
    params: [upgradeId, signer, zeroAddress, amount] as const,
    value: amount,
  };
}

export function withdrawCall(
  upgradeId: bigint,
  signer: Address,
  amount: bigint,
): UpgraderCall<typeof UPGRADER_WITHDRAW_METHOD, readonly [bigint, Address, Address, bigint]> {
  if (amount <= 0n) throw new Error("withdraw amount must be positive");
  return {
    method: UPGRADER_WITHDRAW_METHOD,
    params: [upgradeId, signer, zeroAddress, amount] as const,
    value: 0n,
  };
}

export function claimCall(
  upgradeId: bigint,
  signer: Address,
): UpgraderCall<typeof UPGRADER_CLAIM_METHOD, readonly [bigint, Address]> {
  return { method: UPGRADER_CLAIM_METHOD, params: [upgradeId, signer] as const, value: 0n };
}
