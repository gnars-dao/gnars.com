import { describe, expect, it } from "vitest";
import type { PoidhSopaToken } from "@/lib/config";
import { groupPending, ownedSopaAccounts, totalsByToken } from "./withdrawals";

const ETH: PoidhSopaToken = {
  symbol: "ETH",
  address: "0x0000000000000000000000000000000000000000",
  decimals: 18,
};
const USDC: PoidhSopaToken = {
  symbol: "USDC",
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
};
const SA = "0x00000000000000000000000000000000000000aa" as const;
const EOA = "0x00000000000000000000000000000000000000bb" as const;

const ok = (result: bigint) => ({ status: "success" as const, result });

describe("ownedSopaAccounts", () => {
  it("lists the smart account then a distinct admin EOA", () => {
    expect(ownedSopaAccounts({ saAddress: SA, adminAddress: EOA })).toEqual([
      { address: SA, kind: "sa" },
      { address: EOA, kind: "eoa" },
    ]);
  });

  it("drops the admin when it is the same address (pure EOA session)", () => {
    expect(ownedSopaAccounts({ saAddress: SA, adminAddress: SA.toUpperCase() as never })).toEqual([
      { address: SA, kind: "sa" },
    ]);
  });

  it("is the smart account alone for in-app wallets", () => {
    expect(ownedSopaAccounts({ saAddress: SA, adminAddress: undefined })).toEqual([
      { address: SA, kind: "sa" },
    ]);
  });

  it("is empty when disconnected", () => {
    expect(ownedSopaAccounts({ saAddress: undefined, adminAddress: undefined })).toEqual([]);
  });
});

describe("groupPending", () => {
  const accounts = ownedSopaAccounts({ saAddress: SA, adminAddress: EOA });

  it("keeps only accounts and tokens with a balance, account-major", () => {
    const { accounts: got, failed } = groupPending(
      accounts,
      [ETH, USDC],
      [ok(0n), ok(0n), ok(0n), ok(8_775_000n)],
    );
    expect(failed).toBe(false);
    expect(got).toEqual([
      { address: EOA, kind: "eoa", items: [{ token: USDC, amount: 8_775_000n }] },
    ]);
  });

  it("flags a failed or missing read instead of treating it as zero", () => {
    const { accounts: got, failed } = groupPending(
      accounts,
      [ETH, USDC],
      [ok(5n), { status: "failure" }, ok(0n)],
    );
    expect(failed).toBe(true);
    expect(got).toEqual([{ address: SA, kind: "sa", items: [{ token: ETH, amount: 5n }] }]);
  });
});

describe("totalsByToken", () => {
  it("sums each token across accounts", () => {
    const totals = totalsByToken([
      { address: SA, kind: "sa", items: [{ token: USDC, amount: 1n }] },
      {
        address: EOA,
        kind: "eoa",
        items: [
          { token: ETH, amount: 2n },
          { token: USDC, amount: 3n },
        ],
      },
    ]);
    expect(totals).toEqual([
      { token: USDC, amount: 4n },
      { token: ETH, amount: 2n },
    ]);
  });
});
