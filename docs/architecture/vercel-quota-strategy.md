# Vercel Quota Strategy

Reviewed 2026-09-05. The earlier June Hobby-quota figures are historical and must not be used as the current billing baseline.

## Current Deployment And Usage

- Production belongs to the SOPA team (`sopa1`), project `gnars.com`, with Fluid compute in `iad1`.
- The local Vercel project link was corrected during the September review; verify the project and team before running operational commands.
- The September 1-5 usage snapshot showed approximately **$1.42 effective usage and $0 billed**. Effective usage is not an invoice and this short window is not a monthly forecast.
- WAF configuration `waf_QLtrUWcHmDh4` version 1 is published and verified live: four active per-IP rules cover Alchemy (120/minute), uploads (60/hour), revalidation (20/minute), and wallet tokens (60/minute).
- Record the deployment SHA, date range, project, and active firewall configuration alongside any future cost comparison.

## Controls In The Repository

| Surface         | Current behavior                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subgraph        | `src/lib/subgraph.ts` uses a 300-second fetch TTL by default, with caller overrides and a shared concurrency/retry gate. It does not default to `no-store`.              |
| Proposals       | List and detail service caches use 1,800-second revalidation. List payloads use the reduced proposal representation.                                                     |
| Sitemap         | `src/app/sitemap.xml/route.ts` revalidates hourly; it no longer combines this setting with `force-dynamic`.                                                              |
| Public GET APIs | Successful proposal/member/media responses have explicit shared-cache windows. Failures must not become cached successful empty results.                                 |
| Wallet tokens   | Bounded Zora metadata batches have a shared cache and timeout. Short balance caching remains separate from stable metadata.                                              |
| TV feed         | Healthy aggregation responses have a one-hour CDN window. Degraded aggregation responses must not occupy that healthy window.                                            |
| Translations    | The global client provider receives five shared namespaces. Route layouts supply only their feature namespaces; import-graph tests cover shared dialogs and descendants. |
| MiniTV          | Hidden routes/hero states unmount the widget and its feed request. Clearing its video input stops the stored playback state.                                             |
| Auction bids    | React Query deduplicates by auction, cancels obsolete fetches, avoids background polling, and gates homepage polling on viewport visibility.                             |
| Rounds          | Table/index creation is an explicit `scripts/rounds-schema.sql` migration, not request-time work.                                                                        |

## Cost Decisions

Measure request volume, cache hits, response size, active CPU, and origin transfer before changing architecture. A short TTL is not automatically wasteful, and a long TTL is not safe for every financial read.

- Use request-local React memoization for duplicate reads within a render. Use Next data caching for reuse across requests.
- Keep balances, quotes, and transaction eligibility on freshness windows appropriate to their use. Cache token metadata and immutable content separately.
- Restrict paid upstream proxies and uploads by method, input size, timeout, and rate limits. A client-side restriction alone does not protect credentials or upstream spend.
- Avoid introducing a unique cache key for every arbitrary caller input. Normalize, validate, and bound inputs first.
- Keep failed upstream responses distinguishable from valid zero balances or empty collections.
- Keep authenticated responses and order access private. Public CDN caching is appropriate only for public data.
- Treat dependency installation size, browser transfer, GPU work, Vercel function invocations, and third-party API usage as separate measurements.

Do not claim that CDN cache hits or WAF-blocked traffic are universally free: check the account's current plan and billing dimensions. Likewise, disabling image optimization can reduce transformations while increasing transferred bytes.

## Verification

1. Run the relevant tests, typecheck, lint, and format check.
2. Check EN/PT-BR runtime behavior at desktop and mobile widths, including wallet dialogs and navigation.
3. Verify the exact production deployment SHA and the active WAF rules.
4. Compare matching traffic windows in project Observability and team Usage. Track route-level cache hits, active CPU, origin transfer, image transformations, and upstream errors.
5. Report observed savings only after production measurements; local payload measurements are supporting evidence.

For the September changes and deployment prerequisites, see [review remediation](2026-09-review-remediation.md). Current product billing references: [Vercel pricing](https://vercel.com/docs/pricing) and [Fluid compute](https://vercel.com/docs/fluid-compute).
