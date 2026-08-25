# Campaign baseline — "Stake or Die" (Gnars × Morpheus)

Freezes the **before** of the campaign that ships 2026-08-26, and defines the
procedure for re-collecting the **after** so the two are comparable.

```bash
pnpm campaign:baseline            # collect a snapshot
pnpm campaign:baseline --compare  # diff the two most recent snapshots
```

Snapshots are committed to `scripts/data/campaign-baseline/<utc-iso>.json`.

## Why this had to happen before the campaign

MOR staked, distinct stakers and treasury balances are **levels**, not logs. The
chain answers "what is the balance now"; it does not answer "what was the
balance before the announcement" unless someone asked at the time. Once the
campaign is out, no query recovers the counterfactual — the campaign becomes
judgeable only by anecdote ("felt like it engaged well").

One metric is exempt and it is worth knowing which: **traffic**. GA4 retains
aggregate reports, so page views for `/stake`, `/morpheus` and `/base` can be
pulled retroactively. Everything on-chain cannot.

## What is captured

| Metric                           | Source                                               | Notes                                    |
| -------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| MOR staked in the Gnars subnet   | `BuildersV4.subnetsData(subnetId).deposited` on Base | the headline number                      |
| Distinct stakers + each position | `UserDeposited` logs → `usersData(user, subnetId)`   | live positions, not log arithmetic       |
| Concentration                    | derived                                              | largest position, its share, median      |
| Treasury                         | `getBalance` + `balanceOf` on the allowlisted tokens | **raw balances, deliberately un-priced** |
| Rider sponsorship graph          | `https://www.gnars.com/api/stake-graph`              | the same number the campaign pages show  |
| Traffic                          | **not collected** — GA4 spec recorded instead        | see below                                |

Every on-chain read is pinned to **one block number**, recorded in the snapshot.
Metrics read seconds apart are not a snapshot; a pinned block makes the set
internally consistent and independently re-checkable by anyone with an RPC.

### Why the treasury is un-priced

A USD figure moves with the market, so "the treasury grew" after the campaign
would be unreadable — was that the campaign, or was that ETH? Raw balances move
only when the treasury actually receives or spends, which is what the campaign
claims to affect. Price it at read time for colour; compare the raw series.

### Why concentration is in there

A total that rises because one whale doubled is a different outcome from a total
that rises because 40 people arrived, and only the second vindicates a campaign.
`--compare` says which one happened instead of leaving it to interpretation.

## The trap this script already fell into

The first version enumerated stakers from **Blockscout's** Etherscan-compatible
`getLogs`, which answers the whole range in one keyless request. It silently
omitted one log: a real 2 MOR deposit from `0xC1afA4c0…F3E218` in block
50066903, absent from the Blockscout index but present in `eth_getLogs` for that
exact block. The undercount was 5 stakers instead of 6 — **20% off on the exact
metric the campaign is judged by** — and it raised no error.

It was caught by the reconciliation check, not by inspection. So:

- The log scan reads from an **RPC**, chunked at 9k blocks from the subnet
  genesis block. Slower, authoritative.
- **Reconciliation runs on every collection.** The sum of the individual
  positions must equal the contract's own subnet total. On mismatch the script
  exits non-zero and prints a refusal to publish the staker count.

If a future run reports `MISMATCH`, the staker list is incomplete. Do not
publish the count. Find the missing log first — the procedure that found this
one is: read `subnetsData().deposited` at each known deposit block, find where
the on-chain total diverges from the cumulative event sum, binary-search that
window for the block where the gap opens, then `eth_getLogs` that single block.

## Re-collection procedure

Run on **27/08, 28/08 and 01/09**, plus any day the campaign has a spike:

```bash
cd ~/Code/gnars/gnars-website
git pull
pnpm campaign:baseline
pnpm campaign:baseline --compare
git add scripts/data/campaign-baseline && git commit -m "chore(baseline): <date> snapshot"
```

`--compare` diffs the two most recent snapshots and prints a one-line read of
which kind of growth happened. Commit each snapshot — the series is the point.

No environment variables are required: the RPCs are public and the sponsorship
graph comes from the live site.

### Traffic, the one part that is manual

GA4 property **`G-S0R9RBJDKL`**, verified firing on `/stake`, `/morpheus`,
`/base` and their `pt-br` routes. It needs credentials this repo does not hold
(a GA4 Data API service account, or a human in the GA UI), so the snapshot
records the report to run rather than silently omitting the metric:

- **Dimensions**: `date`, `pagePath`
- **Metrics**: `screenPageViews`, `totalUsers`, `sessions`, `averageSessionDuration`
- **Filter** `pagePath` to `/stake`, `/morpheus`, `/base` and the three `pt-br` equivalents
- **Range**: `2026-08-12..2026-08-25` for the pre-campaign baseline; extend the
  end date on each re-collection

Paste the result next to the snapshot for the same date. If nobody ever pulls
it, say so in the report — "we had analytics and never read them" is a finding
about the operation, and it is the input to the next adjustment.

## Known adjacent breakage (not fixed by this script)

- `GET /api/treasury/performance` returns **HTTP 500** in production: Basescan
  refuses the deprecated V1 endpoint and tells the caller to migrate to
  Etherscan API V2. Treasury performance is a number the campaign leans on, so
  this is worth fixing before the 26th.
