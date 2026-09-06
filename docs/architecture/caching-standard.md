# Next.js Caching And Freshness Standard

Reviewed 2026-09-05. Cache policy must balance fresh financial data, upstream load, and response size. A TTL makes an entry eligible for revalidation after expiry; it does not run every page on a fixed timer.

## Cache Layers

- React `cache()` deduplicates calls during a server render. It is not a cross-request cache.
- Next `unstable_cache` and fetch revalidation persist public data across requests. Use canonical tags from `src/lib/cache-tags.ts` where mutations can invalidate the dataset.
- Route ISR and explicit response `s-maxage` control rendered response reuse. An explicit CDN response cache does not become tag-aware merely because its underlying data uses tags.
- React Query caches client reads. Preserve its five-minute global stale-time default; override individual live queries as needed.
- Router navigation caches are separate. A successful write must refresh the local view as well as request server invalidation.

Do not combine `force-dynamic` with a route `revalidate` value and expect ISR. Do not apply public caching to authenticated order data or write responses.

## Current Data Policies

| Surface                       | Implemented policy                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subgraph fetch helper         | Default 300-second fetch revalidation, caller overrides, bounded concurrency/retries; no default `no-store`.                                                       |
| Proposal list/detail services | 1,800-second tagged caches; canonical detail tags use decimal `proposal:<number>`.                                                                                 |
| Feed service                  | 300-second tagged cache.                                                                                                                                           |
| Stake graph                   | Tagged service cache and a separate shorter CDN response window. Failed reads must not pin an empty graph.                                                         |
| Public proposal/member APIs   | Explicit success-only CDN cache headers; failures remain failures.                                                                                                 |
| Wallet token API              | Short-lived balances; metadata cached separately in bounded batches. RPC failure responses must not be persisted as successful metadata.                           |
| TV feed                       | Healthy feed has a one-hour CDN window; degraded/error results use their explicit failure policy.                                                                  |
| Media-type endpoint           | Upstream HEAD/GET probes use `no-store`; metadata GET is read with a byte cap. Only validated successful endpoint results receive CDN caching.                     |
| Rounds                        | Explicit database queries; schema setup is `scripts/rounds-schema.sql`, run as a migration. Do not describe a proposed tagged rounds cache as already implemented. |
| Images                        | Thirty-day minimum optimizer TTL with a host allowlist. `ContentImage` serves unsupported external hosts directly instead of proxying arbitrary origins.           |

The byte cap on media probes requires uncached upstream fetches: Next's fetch-cache branch can buffer a cloned response even after the consumer stops reading.

## Transaction-Proven Invalidation

After a confirmed transaction, use:

```ts
requestRevalidation(["proposals", "feed"], {
  transactionHash,
  chainId: 8453,
});
```

The proof parameter is required. Ethereum Morpheus writes use chain `1`; Base writes use `8453`. Continue the relevant local refetch/invalidation after confirmation.

`POST /api/revalidate` accepts at most five bounded tags and validates a successful receipt on Base or Ethereum. It requires a block timestamp within the refresh window (up to ten minutes old, with a small future-clock tolerance), then derives permitted dataset tags from logs emitted by configured contracts. Arbitrary transactions cannot request arbitrary dataset invalidation.

The endpoint applies IP and transaction rate limits and calls `revalidateTag(tag, "max")`, which marks cached data stale for background refresh. It does not wait for the subgraph to index the transaction. `requestRevalidation` sends immediately and schedules a second browser request after **45 seconds**. There is **no server-side sleep**. If the browser leaves before the retry, TTLs remain the fallback.

The public endpoint currently authorizes only contract-backed datasets implemented in `revalidation-policy.ts`. Database mutations must invalidate their own relevant server caches; do not submit unsupported round tags without onchain evidence.

Tag invalidation does not guarantee that every client or explicit CDN response updates immediately. Measure indexer lag and verify each affected view instead of claiming instantaneous propagation.

## Read Failures And Financial Amounts

Unavailable prices, balances, rates, and failed collections must retain an error/unavailable state. A valid zero and a failed request are different results. Server Components should call the service directly rather than fetch the application's own API over HTTP.

Vault yield claims use conservative capital accounting:

- Reconstruct complete deposit, withdrawal, and transfer history before offering yield-only claims.
- Partial withdrawals leave the capital floor unchanged. This can understate remaining claimable yield, but prevents repeatedly reclassifying withdrawn yield as reductions in principal.
- A full exit resets the capital floor for a later position.
- Transferred shares, incomplete history, or an unknown principal disable yield-only claims. Full withdrawal remains available.

This is a deliberate conservative policy, not a claim of exact cost-basis accounting for transferred positions.

## Client Work And Verification

- Auction bids share a React Query key per auction, cancel obsolete reads, avoid background-tab polling, and gate homepage polling on viewport visibility.
- Hidden MiniTV instances unmount; clearing the video input stops stored playback.
- Keep response payloads scoped, including per-route translation dictionaries.
- Use `prefetch={false}` selectively where measured large grids cause expensive speculative work; it is not a substitute for caching.

Verify receipt rejection and allowed tags, failed-upstream behavior, cache headers, and EN/PT-BR runtime states. Record the exact production deployment and matching traffic windows before claiming cost reductions. See [Vercel quota strategy](vercel-quota-strategy.md) and [September remediation](2026-09-review-remediation.md).
