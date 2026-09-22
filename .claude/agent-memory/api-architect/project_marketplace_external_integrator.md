---
name: marketplace-external-integrator
description: ps1.r4to.com consumes the Gnars marketplace API; buy path must be browser-direct (CORS), reads stay server-proxied
metadata:
  type: project
---

The owner runs a separate app (ps1.r4to.com) that surfaces Gnars + OpenSea listings and lets
people buy without leaving it. As of 2026-09-09 the split is deliberate:

- **Browser-direct (CORS-enabled):** `POST /api/marketplace/fulfillment` and
  `GET /api/marketplace/orders/[hash]`. The consuming client rebuilds the fulfillment calldata
  locally from the raw `SignedListing` and byte-compares it — that comparison is the security
  model, so the raw listing must reach the browser.
- **Server-proxied (no CORS, on purpose):** `GET /api/marketplace` listings feed. It is
  `public, s-maxage=15`, so one cached server fetch serves every user.

**Why:** `enforceRateLimit` in `src/lib/server/request-security.ts` keys its bucket on
`x-vercel-forwarded-for`. Proxying the buy path would collapse every integrator user into one
bucket and drain `enforceMarketplaceBudget`'s 40/min budget that gnars.com itself shares.

**How to apply:** If asked to expose more marketplace endpoints to a third-party origin, first ask
whether the endpoint is cacheable. Cacheable ⇒ proxy it, do not add CORS. Per-user / rate-limited /
mutating ⇒ it belongs on the browser-direct list. Never add CORS to the listings feed.
See [[project-api-patterns]] for the general caching layers.
