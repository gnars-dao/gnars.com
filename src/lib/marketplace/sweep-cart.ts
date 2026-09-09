import type { Address } from "viem";
import { validateMixedSweepPlan, type MixedSweepPlan } from "./mixed-sweep";

export type SweepCart = {
  plan: MixedSweepPlan;
  purchased: string[];
  skipped: string[];
  awaiting?: string;
  previousJournalId?: string;
};

export function parseSweepCart(raw: string, buyer: Address): SweepCart {
  const value = JSON.parse(raw);
  const plan = validateMixedSweepPlan(value.plan, buyer, true);
  const tokens = new Set(plan.items.map((item) => item.tokenId));
  for (const ids of [value.purchased, value.skipped]) {
    if (
      !Array.isArray(ids) ||
      ids.some((id) => !tokens.has(id)) ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Invalid sweep progress");
  }
  if (
    value.purchased.some((id: string) => value.skipped.includes(id)) ||
    (value.awaiting !== undefined && value.awaiting !== "batch" && !tokens.has(value.awaiting)) ||
    (value.previousJournalId !== undefined && typeof value.previousJournalId !== "string")
  )
    throw new Error("Invalid sweep progress");
  return {
    plan,
    purchased: value.purchased,
    skipped: value.skipped,
    awaiting: value.awaiting,
    previousJournalId: value.previousJournalId,
  };
}

export function applySweepConfirmation(
  cart: SweepCart,
  confirmation: {
    journalId: string;
    tokenId: string;
    source?: string;
    orderHash?: string;
    sweepOrderHashes?: string[];
    result?: { purchasedTokenIds: string[]; skippedTokenIds: string[] } | null;
  },
): SweepCart {
  if (!cart.awaiting || confirmation.journalId === cart.previousJournalId) return cart;
  const item = cart.plan.items.find((item) => item.tokenId === cart.awaiting);
  if (cart.awaiting === "batch") {
    const result = confirmation.result;
    const tokens = cart.plan.items.map((item) => item.tokenId);
    if (
      !result ||
      confirmation.source !== "gnars-contract" ||
      !confirmation.sweepOrderHashes ||
      confirmation.sweepOrderHashes.length !== cart.plan.items.length ||
      cart.plan.items.some(
        (item, index) =>
          item.offers[0].orderHash.toLowerCase() !==
          confirmation.sweepOrderHashes![index].toLowerCase(),
      ) ||
      !cart.plan.items.every((item) => item.offers[0].source === "gnars-contract") ||
      result.purchasedTokenIds.length + result.skippedTokenIds.length !== tokens.length ||
      new Set([...result.purchasedTokenIds, ...result.skippedTokenIds]).size !== tokens.length ||
      [...result.purchasedTokenIds, ...result.skippedTokenIds].some((id) => !tokens.includes(id))
    )
      return cart;
    return {
      ...cart,
      purchased: result.purchasedTokenIds,
      skipped: result.skippedTokenIds,
      awaiting: undefined,
    };
  }
  if (
    !item ||
    item.tokenId !== confirmation.tokenId ||
    item.offers[0].source !== confirmation.source ||
    item.offers[0].orderHash.toLowerCase() !== confirmation.orderHash?.toLowerCase() ||
    confirmation.result
  )
    return cart;
  return {
    ...cart,
    purchased: [...new Set([...cart.purchased, item.tokenId])],
    awaiting: undefined,
  };
}
