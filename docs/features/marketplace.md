# Gnars Marketplace

## Scope

`/marketplace` and `/pt-br/marketplace` trade the existing Gnars DAO ERC721 on Base,
using `DAO_ADDRESSES.token`. This is not the $GNARS ERC20, the primary auction,
or a new NFT collection. Community collections, ERC1155, offers, auctions,
cross-chain payments and collection deployment are outside this release.

The initial server-rendered collection comes from the Builder subgraph. Burned
tokens are excluded. Inventory is scoped to the actual `useWriteAccount()` owner,
not the member page's merged EOA/smart-account inventory. Details re-read ownership.
The collection grid does not claim that missing price data means an NFT is unlisted.

## Trading

- OpenSea: server-only v2 API, `gnars-dao` collection slug, native ETH fixed-price
  listings on Base only. Detail requests fetch the best supported external listing.
- Gnars: PostgreSQL stores signed Seaport orders. NFTs remain in the seller wallet.
  Listing approval is per NFT, followed by EIP-712 signing and publication.
  These local orders are not automatically cross-posted to OpenSea.
- Settlement: canonical Seaport 1.6, `0x0000000000000068F116a894984e2DB1123eB395`.
  No custom settlement contract or additional Gnars platform fee is introduced.
- Local listings include the collection's current ERC2981 royalty, when supported,
  deducted from the entered gross price. RPC failures abort instead of waiving it.
- OpenSea purchases preserve signed consideration and its total price. Unsupported
  orders are rejected, never rewritten into different economic terms.
- Before purchase, the server refreshes the listing, checks owner and expected
  price, validates the exact transaction, and simulates it as the buyer. The wallet
  client independently decodes/checks it and simulates again before submission.
- External basic, standard and advanced single-item Seaport fulfillments are
  supported. Criteria orders, partial fills, tips, batch matches, ERC20 payments,
  arbitrary destinations and arbitrary calldata are rejected.
  Partial-enabled order types are accepted only as whole singleton ERC721 fills;
  buyer routing is limited to no conduit or OpenSea's canonical conduit. Live
  `seaport1.6` responses and hexadecimal integer fields are supported.
- Cancellation is an onchain Seaport transaction. A database-only deletion does
  not cancel a valid signature. Filled/cancelled state is reconciled from chain.
- EOA signatures are recovered directly. Deployed smart accounts must explicitly
  pass ERC1271. Counterfactual signatures are not accepted as EOA signatures.

## Drawer And Recovery

Selected NFTs open in a right-side drawer at desktop widths (768px+) and a bottom
drawer on mobile. A fixed header keeps close/back controls visible; the interior
scrolls independently. Dismissal and dragging are disabled during a wallet action,
and closing restores focus to the selected NFT. Breakpoint changes preserve the
selected NFT and review state. The parent waits for the exit animation before
unmounting the detail view.

Wallet attempts are journaled in browser storage by Base account before requesting
a transaction/signature. Web Locks coordinate tabs. Reloading, closing a drawer,
or a WalletConnect timeout must not permit a duplicate submission.

The recovery panel can check receipts, continue a confirmed approval into signing,
or republish the same saved signature. Unknown transaction hashes can be supplied
for verification against the persisted intent before reconciliation. Unknown
outcomes cannot be silently reset. Clearing browser storage is not a safe recovery
procedure. No private keys are stored.

## Configuration And Cost

1. Configure `OPENSEA_API_KEY` as a server secret for external listing reads and
   purchases. OpenSea order fulfillment does not require a local order database.
2. For Gnars-native listings, configure a pooled PostgreSQL URL in `MARKETPLACE_DATABASE_URL`. Existing
   `ROUNDS_DATABASE_URL`, `DATABASE_PUBLIC_URL`, `DATABASE_URL` are fallbacks,
   in that order. Apply `scripts/marketplace-schema.sql` to the selected database.
3. Confirm `/api/marketplace/readiness` reports the expected capabilities.
4. Configure Vercel WAF rate limits for public marketplace GET endpoints before
   enabling the production OpenSea key. App-instance limits alone are not a
   distributed public-read quota. Monitor provider quota and Vercel usage.
5. Verify a real OpenSea API response and controlled wallet flow before announcing
   trading availability. Do not use production funds for automated tests.

Missing configuration disables only the dependent actions: an absent OpenSea key
disables external buying; unavailable PostgreSQL disables local listing creation,
purchase and cancellation through the local orderbook. Missing sources remain
visible as unavailable, not empty successful results. OpenSea purchases still
require fresh order/owner/price checks, exact-calldata validation and simulation.

Pages use 24-item cursor pagination. Collection reads cache for 60 seconds,
OpenSea list reads for 30 seconds, local listings for 15 seconds. Public API
responses use short CDN caching; owned inventory and failed reads are no-store.
Details load on demand, without a per-NFT external request for every grid card.
There is no background browser polling or new cron job. Fulfillment is uncached.
Local-order POSTs have durable per-IP and global minute budgets in PostgreSQL; the
pool is bounded to two connections per function instance with query timeouts.
OpenSea reads coalesce identical in-flight requests; different reads have bounded
concurrency. Provider rate-limit responses trigger a shared per-instance cooldown
using Retry-After. Outbound quotas use the distributed budget table when ready,
otherwise bounded per-instance quotas. Instance-only quotas cannot guarantee the
account-wide allowance across Vercel instances; WAF/distributed controls and
monitoring remain necessary. A budget write that fails after readiness does not
silently bypass the distributed guard. Local-order mutations invalidate only local
order caches, preserving unrelated collection and OpenSea caches.

## Verification

- Unit coverage: price precision, collection parsing, cursors/partial availability,
  OpenSea normalization/encoding, order storage, fulfillment, Seaport signatures
  and validation, transaction recovery identity.
- `scripts/marketplace-fork.ts`: isolated Anvil fork protocol smoke test. The script
  must only write to verified localhost Anvil and never to the upstream Base RPC.
  Verified local purchases, duplicate-fill rejection, cancellation, owner changes,
  and generated OpenSea basic/advanced settlement on a Base fork. Settlement calls
  include the Gnars builder suffix; this tests contract compatibility, not whether
  an external leaderboard has indexed the transaction.
- `tests/e2e/marketplace.spec.ts`: localized desktop/mobile browsing and failure
  states. These tests are not evidence of a real OpenSea API trade or funded
  WalletConnect/smart-account production purchase.
- A read-only authenticated OpenSea check on September 6 successfully encoded and
  independently validated the live Gnars #1951 fulfillment response. This checks
  provider response compatibility, not a funded production wallet transaction.

Protocol references: [Seaport](https://github.com/ProjectOpenSea/seaport),
[OpenSea fulfillment API](https://docs.opensea.io/reference/generate_listing_fulfillment_data_v2),
[ERC2981](https://docs.openzeppelin.com/contracts/5.x/api/token/common).
