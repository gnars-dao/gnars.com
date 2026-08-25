import { SUBGRAPH } from "@/lib/config";
import { parseRetryAfter, run, SubgraphTransientError } from "@/lib/subgraph-gate";

type GraphQLRequestBody = {
  query: string;
  variables?: Record<string, unknown>;
};

/**
 * Default TTL for subgraph reads, in seconds.
 *
 * This used to be `cache: "no-store"`, which is request-scoped and therefore
 * opts the *entire calling route* out of caching: `/`, `/base`, `/droposals`
 * and `/treasury` all rendered on every single request (p50 712-1205 ms, all
 * `x-vercel-cache: MISS`) while the 16 routes that never touch the subgraph
 * server-side served from cache at ~200 ms. A TTL keeps the freshness the
 * `no-store` was reaching for while letting those routes go back to ISR.
 *
 * 300 s matches what those pages already declare in their segment config, so
 * the route revalidate is no longer dragged below the author's stated intent
 * (Next takes the *minimum* of the segment value and every fetch TTL).
 *
 * Live auction bids do not depend on this: they come from `use-auction-bids`,
 * a client hook, and `next.revalidate` is ignored in the browser. Callers that
 * genuinely need an uncached read can pass `revalidate: 0`.
 */
const DEFAULT_REVALIDATE_SECONDS = 300;

/**
 * Every subgraph read goes through the shared gate in `subgraph-gate.ts`: the
 * endpoint is Goldsky's public one, which rate-limits by burst, so bounded
 * concurrency plus a `retry-after`-aware ladder is what keeps builds and
 * request spikes from collecting 429s. A read that still fails after the ladder
 * throws — a failed read renders as a failure, never as zero.
 */
export async function subgraphQuery<TData>(
  query: string,
  variables?: Record<string, unknown>,
  options?: { revalidate?: number; label?: string },
): Promise<TData> {
  const body: GraphQLRequestBody = { query, variables };

  return run(async () => {
    const res = await fetch(SUBGRAPH.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      next: { revalidate: options?.revalidate ?? DEFAULT_REVALIDATE_SECONDS },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const message = `Subgraph error: ${res.status} ${res.statusText} ${text}`;
      // 429 and 5xx are the server asking us to come back later, not a bad
      // query — hand the gate its own `retry-after` so it waits exactly that.
      if (res.status === 429 || res.status >= 500) {
        throw new SubgraphTransientError(message, {
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        });
      }
      throw new Error(message);
    }

    const json = (await res.json()) as { data?: TData; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      throw new Error(`Subgraph query failed: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    return json.data as TData;
  }, options?.label ?? "query");
}
