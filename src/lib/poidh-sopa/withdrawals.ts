import type { PoidhSopaToken } from "@/lib/config";

/**
 * Pending PoidhSopa balances across every account the user controls. The contract credits
 * the claimer's address (`pendingWithdrawals(account, token)`), which may be the smart
 * account or the admin EOA depending on which one submitted the claim, so the UI reads
 * both and lets the matching signer withdraw. Kept out of the hooks so it is testable.
 */

export type SopaAccountKind = "sa" | "eoa";

export interface SopaOwnedAccount {
  address: `0x${string}`;
  kind: SopaAccountKind;
}

export interface SopaPendingItem {
  token: PoidhSopaToken;
  amount: bigint;
}

export interface SopaPendingAccount extends SopaOwnedAccount {
  items: SopaPendingItem[];
}

/**
 * The user's accounts, smart account first. The admin EOA only counts when it is a
 * distinct, user-facing account (external wallets; in-app sessions never expose it).
 */
export function ownedSopaAccounts(input: {
  saAddress: `0x${string}` | undefined;
  adminAddress: `0x${string}` | undefined;
}): SopaOwnedAccount[] {
  const accounts: SopaOwnedAccount[] = [];
  if (input.saAddress) accounts.push({ address: input.saAddress, kind: "sa" });
  if (input.adminAddress && input.adminAddress.toLowerCase() !== input.saAddress?.toLowerCase()) {
    accounts.push({ address: input.adminAddress, kind: "eoa" });
  }
  return accounts;
}

/** Read result as wagmi returns it with `allowFailure: true`. */
export type PendingRead = { status: "success"; result: unknown } | { status: "failure" };

/**
 * Groups `pendingWithdrawals` reads (laid out account-major: every token for account 0,
 * then account 1…) into accounts with something to withdraw. `failed` is set when any
 * read failed: the caller must say so instead of showing "nothing to withdraw".
 */
export function groupPending(
  accounts: readonly SopaOwnedAccount[],
  tokens: readonly PoidhSopaToken[],
  reads: readonly (PendingRead | undefined)[],
): { accounts: SopaPendingAccount[]; failed: boolean } {
  let failed = false;
  const out: SopaPendingAccount[] = [];
  accounts.forEach((account, a) => {
    const items: SopaPendingItem[] = [];
    tokens.forEach((token, t) => {
      const r = reads[a * tokens.length + t];
      if (!r || r.status !== "success") {
        failed = true;
        return;
      }
      const amount = typeof r.result === "bigint" ? r.result : 0n;
      if (amount > 0n) items.push({ token, amount });
    });
    if (items.length > 0) out.push({ ...account, items });
  });
  return { accounts: out, failed };
}

/** Sum per token across accounts, in first-seen order. */
export function totalsByToken(accounts: readonly SopaPendingAccount[]): SopaPendingItem[] {
  const totals = new Map<string, SopaPendingItem>();
  for (const account of accounts) {
    for (const { token, amount } of account.items) {
      const key = token.address.toLowerCase();
      const prev = totals.get(key);
      totals.set(key, { token, amount: (prev?.amount ?? 0n) + amount });
    }
  }
  return [...totals.values()];
}
