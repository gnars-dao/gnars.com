# September 2026 Review Remediation

Review date: 2026-09-05. This record distinguishes repository changes from operational configuration and deployment verification.

## Deployment Baseline

The reviewed production project is `gnars.com` in the SOPA team (`sopa1`), using Fluid compute in `iad1`. The local Vercel project link was corrected during this review. September 1-5 usage was approximately **$1.42 effective usage with approximately $0 billed**; this is a dated snapshot, not a monthly cost estimate.

WAF configuration `waf_QLtrUWcHmDh4`, version 1, is published and verified live with four active per-IP rules: Alchemy 120/minute, uploads 60/hour, revalidation 20/minute, and wallet tokens 60/minute. The production database and fulfillment configuration are absent, so checkout remains disabled. Durable-order code does not make checkout production-ready without those prerequisites.

## Repository Changes

- Public upstream surfaces gain bounded input validation, timeouts, and rate-limit controls. Upload policy is shared between signed/direct Pinata paths and their callers.
- Public API success caching is explicit. Upstream errors remain errors; degraded TV feed results do not receive the healthy feed's hour-long cache window.
- Wallet token enrichment batches and caches metadata separately from short-lived balances.
- Rounds schema creation moves out of request handling into `scripts/rounds-schema.sql`. Apply this migration explicitly against the intended database.
- Root translations are limited to five global namespaces, with feature dictionaries delivered by route layouts. Client merging preserves shared controls and import-graph tests protect coverage.
- MiniTV unmounts where hidden and clears playback after hover ends. Auction bids use shared queries, cancellation, and visibility-aware polling.
- Homepage failed DAO/feed/proposal/bounty reads render localized unavailable states.
- Stale quota and bundle documentation is replaced with current code behavior and measured local dictionary sizes.

Vault accounting keeps a conservative capital floor unchanged after partial withdrawals and resets it only on full exit. Unknown or transferred histories disable yield-only claims while full withdrawal remains available. The wider review also covers durable store orders, replay protection, governance proposer eligibility, the image host policy, dependency cleanup, and CI; verify final release status against the deployed commit.

## Validation And Release Gates

Confirmed checks at this handoff: TypeScript passed; the final unit suite passed **408 tests with one todo across 57 files**. Seven browser checks passed across EN/PT-BR desktop/mobile, including moving 3D content, loaded video, and playback pause after mouseleave. The 34 translation coverage tests are included in the suite. All four WAF rules were reverified active through the CLI. Dictionary measurements are in [the bundle audit](../research/build-bundle-audit.md).

Before marking the remediation deployed:

1. Run the final combined unit suite, TypeScript check, lint, and format check. No local production build was authorized; Vercel performs the deployment build.
2. Exercise EN/PT-BR desktop and mobile routes, wallet dialogs, failed-data states, and TV visibility/playback. Capture the PT-BR layout.
3. Verify production order persistence and the explicit rounds migration against the configured database. Keep real checkout gated while its prerequisites are absent.
4. Verify the active WAF rules, project/team link, and exact deployment SHA.
5. Compare post-deploy usage against a matching traffic window; do not report predicted dollar savings as observed savings.

WAF activation is verified above. Record deployment success and final suite totals from their actual results; checkout remains disabled until database and fulfillment prerequisites are configured and verified.
