import "server-only";
import { unstable_cache } from "next/cache";
import { getCoins, setApiKey } from "@zoralabs/coins-sdk";
import type { Address } from "viem";
import {
  parseClankerTokenSource,
  parseZoraTokenSources,
  type SwapTokenSource,
  type SwapTokenSources,
} from "@/lib/swap-token-sources";

const PROVIDER_TIMEOUT_MS = 4000;
const REQUEST_BUDGET_MS = 20_000;
const cachedZora = unstable_cache(
  async (addresses: Address[]) => {
    const key = process.env.NEXT_PUBLIC_ZORA_API_KEY;
    if (key) setApiKey(key);
    const response = await getCoins(
      { coins: addresses.map((collectionAddress) => ({ collectionAddress, chainId: 8453 })) },
      { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) } as NonNullable<
        Parameters<typeof getCoins>[1]
      >,
    );
    return parseZoraTokenSources(response.data, addresses);
  },
  ["swap-token-sources-zora-v1"],
  { revalidate: 3600 },
);

const cachedClanker = unstable_cache(
  async (address: Address) => {
    const params = new URLSearchParams({ chainId: "8453", q: address, limit: "20" });
    const response = await fetch(`https://www.clanker.world/api/tokens?${params}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("Clanker token source is unavailable");
    return parseClankerTokenSource(await response.json(), address);
  },
  ["swap-token-sources-clanker-v1"],
  { revalidate: 3600 },
);

const zoraPending = new Map<string, Promise<SwapTokenSource[]>>();
const clankerPending = new Map<string, Promise<SwapTokenSource | null>>();
function sharePending<T>(
  pending: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  let task = pending.get(key);
  if (!task) {
    task = load().finally(() => pending.delete(key));
    pending.set(key, task);
  }
  return task;
}

export async function getSwapTokenSources(
  requested: readonly Address[],
): Promise<SwapTokenSources> {
  const addresses = [
    ...new Set(requested.map((address) => address.toLowerCase() as Address)),
  ].sort();
  const startedAt = Date.now();
  let zora: SwapTokenSource[];
  try {
    zora = await sharePending(zoraPending, addresses.join(","), () => cachedZora(addresses));
  } catch {
    // A Zora outage must not turn one batch request into 25 fallback requests.
    return { tokens: [], complete: false };
  }
  const tokens = [...zora];
  const known = new Set(zora.map((token) => token.address.toLowerCase()));
  const unknown = addresses.filter((address) => !known.has(address));
  let complete = true;
  // Four lookups per wave bounds upstream concurrency and the total cold-request time.
  for (let index = 0; index < unknown.length; index += 4) {
    if (Date.now() - startedAt > REQUEST_BUDGET_MS - PROVIDER_TIMEOUT_MS) {
      complete = false;
      break;
    }
    const results = await Promise.allSettled(
      unknown
        .slice(index, index + 4)
        .map((address) => sharePending(clankerPending, address, () => cachedClanker(address))),
    );
    for (const result of results) {
      if (result.status === "rejected") complete = false;
      else if (result.value) tokens.push(result.value);
    }
  }
  return { tokens, complete };
}
