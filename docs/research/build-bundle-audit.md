# Build And Bundle Audit

Reviewed against the repository on 2026-09-05. This replaces the earlier audit's stale file paths and unverified bundle estimates.

## Current Architecture

- Next.js 16 App Router and React 19, with `src/app/[locale]/layout.tsx` as the localized root and `src/proxy.ts` handling routing/content negotiation.
- The homepage is a Server Component. Interactive auctions, wallet controls, TV, maps, and forms use client components.
- The root provider combines wagmi reads, React Query, thirdweb, and account view state. A client provider around server-rendered children does not by itself turn those children into client components.
- Three.js scenes, the map implementation, and other feature components already use dynamic imports. The former claim that the repository had only two dynamic imports was incorrect.
- `next.config.ts` enables the React compiler, rejects TypeScript build errors, disables `X-Powered-By`, and controls static-generation concurrency.
- Framer Motion is used by active components and must not be removed based on the disabled mural background.

## September Frontend Changes

### Translation Delivery

Previously every localized page received all 31 translation dictionaries. The root now sends `common`, `footer`, `nav`, `stake`, and `wallet`. Each feature layout sends its additional namespaces through `RouteMessages`; its client wrapper merges the inherited root messages.

The global `stake` namespace is intentional: the rewards UI is mounted site-wide. Server translation lookups still have the complete message catalog.

| Locale / scope                   | Serialized JSON bytes | Gzip bytes |
| -------------------------------- | --------------------: | ---------: |
| EN, previous complete catalog    |               123,136 |     40,723 |
| EN, shared root                  |                24,594 |      8,748 |
| EN, root plus homepage           |                57,830 |     19,980 |
| PT-BR, previous complete catalog |               131,022 |     43,874 |
| PT-BR, shared root               |                25,834 |      9,485 |
| PT-BR, root plus homepage        |                61,246 |     21,529 |

These are local dictionary serialization measurements during remediation, not production RSC transfer or billing measurements. Copy changes can move the exact byte counts.

`src/i18n/client-messages.test.ts` follows local imports and dynamic imports from route entry points to check that client translation namespaces remain available, including shared dialogs. New client namespaces need a corresponding route mapping.

### Background Work

- MiniTV mounts its feed and 3D child only when its route/hero visibility permits it.
- Removing the MiniTV video input clears the stored URL, allowing the video component to unmount and pause.
- Auction bid reads use a shared React Query key, obsolete-request cancellation, foreground polling, and viewport gating for homepage panels.
- Homepage DAO, proposal, feed, and bounty failures have explicit EN/PT-BR failure states instead of fabricated zeros or empty histories.

## Remaining Measurement Work

Use a production build and route-level browser/network measurements to identify the next largest bundles. Unused dependencies can slow installation or enlarge the dependency surface without necessarily contributing any browser bytes.

- Measure wallet bootstrap and the globally mounted rewards UI before moving their code behind interaction boundaries.
- Measure actual image sizes and optimizer usage before changing `unoptimized`, formats, or cache TTLs. The image host policy must preserve supported external content while rejecting arbitrary origins.
- Keep heavy client components split at feature boundaries; prioritize components that load before the user needs them.
- Review large files such as `TV3DModel.tsx`, `BountyDetailView.tsx`, and migration widgets when behavior changes require work there. Line count alone does not justify a refactor.
- Preserve the existing strict TypeScript configuration. A higher TypeScript target or standalone output is not, by itself, a demonstrated Vercel cost improvement.

## Validation

The frontend remediation passed targeted ESLint and all 34 translation coverage tests. The overall remediation also passed TypeScript and seven browser checks, including EN/PT-BR desktop/mobile and 3D playback. Final combined suite totals and deployment verification belong to the release gates. No local production build was authorized; Vercel performs the deployment build.

See [review remediation](../architecture/2026-09-review-remediation.md) and [Vercel quota strategy](../architecture/vercel-quota-strategy.md).
