# Stake Orbit Data

The orbit, rider selector and treasury sponsorship widget share `/api/stake-graph`.
Rider backing is Morpho vault TVL plus current Morpheus principal, valued in USD.
Morpheus backers also expose their native token amount (`tokenAmount`).

## Discovery And Balances

`morpheus-discovery.ts` discovers Ethereum `UserReferred` participants through
keyless Blockscout logs, with optional Etherscan fallback. Discovery starts at
genesis, overlaps pagination boundary blocks, and marks capped or failed results
incomplete. Known candidates survive fallback responses.

`morpheus-backing.ts` reads current principal and referrer at one Ethereum block,
instead of adding historical deposits. Withdrawn balances therefore do not inflate
backing. Reads use bounded multicalls (60 calls per batch, 300 candidates maximum).
Discovery is bounded to four pages per query; saturated results are partial.

## Principal Is Not Revenue

Current principal linked to a rider remains visible even if reward routing is
unconfigured, custom or unreadable. `routing` distinguishes those states from
`verified-split`, which requires the exact deterministic 50/25/25 split address.
Only verified routing contributes pending MOR to the treasury estimate. Actual
MOR already held by the expected split is counted independently of current routing.
The orbit does not animate reward flow for an unverified Morpheus receiver.

`morResolved: false` signals incomplete Morpheus data; consumers label subtotals
instead of presenting missing reads as zero. Degraded responses are not cached.
When a previous complete graph is available, it can be returned with incomplete
flags rather than silently presented as fresh.

## Cache And Refresh

The heavy server graph uses the versioned `stake-graph-v2` cache for 1,800 seconds,
with transaction-verified stake invalidation. Healthy HTTP responses use 60 seconds
of CDN freshness plus 60 seconds of stale-while-revalidate. React Query stays fresh
for 60 seconds and refetches stale data on window focus; there is no scheduled graph
polling. Confirmed staking steps invalidate the shared client graph query as well.

This reduces post-transaction CDN lag without repeatedly scanning chain history.
It increases lightweight cached route requests compared with the old five-minute
CDN window. Indexer lag and CDN freshness still mean updates are not instantaneous.
