# PoidhSopa (Gnars POIDH fork)

TL;DR: `/community/bounties` lists POIDH V3 bounties (poidh.xyz API) **and** PoidhSopa bounties (read straight from Base over RPC). Sopa adds ETH/USDC rewards, a category per bounty, and payouts split across 1–10 winners. While `POIDH_SOPA_ADDRESS` is `null`, every Sopa surface is hidden and the page is V3-only.

Turn Sopa on after the deploy by setting the two constants at the top of `POIDH_SOPA` in `src/lib/config.ts` (public values, committed):

```ts
const POIDH_SOPA_ADDRESS: `0x${string}` | null = "0x..."; // PoidhSopa on Base
const POIDH_SOPA_DEPLOY_BLOCK = 12345678n; // block of the deploy tx
```

```bash
pnpm exec vitest run src/lib/poidh-sopa # pure logic tests
```

## Where things live

| Concern                       | File                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Address, deploy block, tokens | `src/lib/config.ts` → `POIDH_SOPA`, `isPoidhSopaEnabled()` (constants)                               |
| ABI                           | `src/lib/poidh-sopa/abi.ts` (copied from the fork's Foundry artifact; regenerate on contract change) |
| Pure logic (tested)           | `src/lib/poidh-sopa/{shares,tokens,bounty-data,blocks,receipt,errors,categories}.ts`                 |
| Server reads                  | `src/services/poidh-sopa.ts`                                                                         |
| API (client refetch)          | `GET /api/poidh/sopa/bounties`, `GET /api/poidh/sopa/bounty/[id]`                                    |
| Writes                        | `src/hooks/use-poidh-sopa-write.ts` (`usePoidhSopaWrite` + `sopaCalls`)                              |
| UI                            | `src/components/bounties/sopa/*`, route `src/app/[locale]/community/bounties/sopa/[id]`              |

Sopa ids start at 0 and collide with V3 ids, so Sopa detail lives at `/community/bounties/sopa/[id]`. V3 routes are unchanged.

## Data flow (no subgraph)

List (`fetchSopaBounties`, `unstable_cache` 60 s, failures are not cached and surface as an error):

1. `bountyCounter()` + latest block.
2. Multicall `bounties(i)` and `getCurrentProposal(i)` for the newest 200 ids. `getBounties(offset)` is **not** used: its paging is broken upstream.
3. `BountyCreated` logs give `category` and `isOpenBounty` (not stored in the struct). Public Base RPCs cap `eth_getLogs` at 10k blocks, so the service estimates each bounty's creation block from `createdAt` (Base = 2 s blocks) and only fetches the deploy-aligned 10k chunks that can contain it (`blocks.ts`). Chunks ending ≥ 900 blocks behind head are cached for a day.
4. Merge by id (`mergeSopaBounties`). A bounty whose log was not found gets `category: null`, and open/solo from `getParticipants` length.

Status comes from `Bounty.claimer`: `0x0` = open (voting when a proposal is pending), `== issuer` = cancelled, `== contract` = paid.

Detail (`fetchSopaBountyFresh`, uncached so the page sees its own writes): struct, `getParticipants`, `everHadExternalContributor`, `getWinners`, `getCurrentProposal`, `bountyVotingTracker`, `bountyFees`, and claims via `bountyClaims(id, i)` (enumerated until revert) + `claims(cid)` + claim NFT `tokenURI(cid)` for the proof media.

To swap in an indexer later, reimplement `src/services/poidh-sopa.ts` with the same return types (`src/lib/poidh-sopa/types.ts`).

## Writes

- Every write goes through `useWriteAccount()` + thirdweb, with Builder Code via `@/lib/builder-code`.
- ERC-20 rewards/contributions need an allowance. Smart accounts send `approve + call` as one userop (`sendBatchTransaction`); EOAs send approve, wait for it (and for the allowance to show on the read RPC), then the call.
- Sopa has no `tx.origin` check, so smart accounts can create bounties (V3 cannot).
- After a create, the new id is parsed from the receipt's `BountyCreated` log (`extractCreatedBountyId`) and the user is sent to its page.
- Winners: 1–10 claims, % per winner converted to basis points summing to 10 000 (remainder on the last). Solo bounties, or open bounties that never had an outside contributor, pay with `acceptClaims`; otherwise `submitWinnersForVote`, then contributors `voteClaim`, anyone `resolveVote` after the deadline (or `resetVotingPeriod` on a failed vote).
- Fees are snapshotted per bounty at creation (`bountyFees(id)` → POIDH + Sopa bps). The payout preview uses that snapshot; the create modal shows the current `poidhFeeBps + sopaFeeBps`.
- Pending balances are per token (`pendingWithdrawals(account, token)`); the banner on `/community/bounties` offers `withdraw(token)` for each configured token.

## Add a reward token

Add an entry to `POIDH_SOPA.tokens` in `src/lib/config.ts`:

```ts
{ symbol: "DEGEN", address: "0x…", decimals: 18 }
```

Nothing else changes: the create modal, cards, detail page, pool stats and withdrawal banner all read that list. Bounties in a token missing from the list still render, with `?` as the symbol and 18 decimals assumed.

## Categories

`src/lib/poidh-sopa/categories.ts` (`skate, tech, surf, snow, art, parkour, music, weed, creative`). The contract accepts any 1–32 byte slug; the UI only offers this list. Labels live in `messages/*/bounties.json` → `sopa.categories`.

## Not verified yet

The contract was not deployed when this was written: no live read or write has run against it. Check list after deploy: list + category merge, detail claims/media, create ETH + USDC (EOA two-step and SA batch), join, cancel, refund, winners pay, vote / resolve / reset, per-token withdraw.
