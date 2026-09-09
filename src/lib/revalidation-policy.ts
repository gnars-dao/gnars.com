import { DAO_ADDRESSES } from "./config";
import { RIDER_LIST } from "./gnars-vaults";
import { MORPHEUS_DISTRIBUTOR, MORPHEUS_POOLS } from "./morpheus";
import { BUILDERS } from "./morpheus-builder";

/** Only logs emitted by configured contracts can invalidate their datasets. */
export function allowedReceiptTags(chainId: number, addresses: string[]): Set<string> {
  const emitted = new Set(addresses.map((address) => address.toLowerCase()));
  const tags = new Set<string>();
  const add = (address: string, values: string[]) => {
    if (emitted.has(address.toLowerCase())) values.forEach((tag) => tags.add(tag));
  };
  if (chainId === 8453) {
    add(DAO_ADDRESSES.governor, ["proposals", "feed", "treasury", "proposal"]);
    add(DAO_ADDRESSES.auction, ["auction", "auctions", "feed", "treasury"]);
    add(DAO_ADDRESSES.token, ["members", "feed"]);
    add(BUILDERS, ["stake"]);
    for (const rider of RIDER_LIST) if (rider.vault) add(rider.vault, ["stake"]);
  } else if (chainId === 1) {
    add(MORPHEUS_DISTRIBUTOR, ["stake"]);
    for (const pool of Object.values(MORPHEUS_POOLS)) add(pool.pool, ["stake"]);
  }
  return tags;
}

export function filterReceiptTags(requested: string[], allowed: Set<string>): string[] {
  return [...new Set(requested)].filter(
    (tag) => allowed.has(tag) || (allowed.has("proposal") && /^proposal:\d{1,8}$/.test(tag)),
  );
}
