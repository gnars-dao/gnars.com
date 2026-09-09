# Gnars Marketplace

## Scope

`/marketplace` and `/pt-br/marketplace` trade the existing Gnars DAO ERC721 on Base,
using `DAO_ADDRESSES.token`. This is not the $GNARS ERC20, the primary auction,
or a new NFT collection. Community collections, ERC1155, offers, auctions,
cross-chain payments and collection deployment are outside this release.

The default server-rendered view shows for-sale listings first, with NFT metadata
from the Builder subgraph. Burned tokens are excluded from the catalogue. Inventory is scoped to the actual `useWriteAccount()` owner,
not the member page's merged EOA/smart-account inventory. Details re-read ownership.
The collection grid does not claim that missing price data means an NFT is unlisted.

The frontend includes collection, for-sale, owned-inventory and owner-listings
(`selling`) views, exact token-ID search and direct links to an NFT drawer.
The URL preserves `view`, `q` (token ID) and `nft` (selected NFT); browser navigation
restores them. Wallet-scoped views always use the connected write account.
Cards show the best loaded supported offer and its source. This is not a claim
that the entire collection has been globally sorted or that every order type is
supported.

Cards use NFT artwork with a lightweight metallic reflection, never a webcam.
Mouse pointers control the sheen; touch and reduced-motion users receive a static
surface. Compact prices are display-only approximations; exact wei values remain
unchanged for signing, execution and the detail view.

## Trading

- OpenSea: server-only v2 API, `gnars-dao` collection slug, native ETH fixed-price
  listings on Base only. Detail requests fetch the best supported external listing.
  Sellers can approve a single Gnars NFT to OpenSea's canonical conduit, sign an order, and publish
  directly to OpenSea without a local database. The sell form explicitly chooses
  among the configured destinations; it never changes the destination silently.
- Gnars: PostgreSQL stores signed Seaport orders. NFTs remain in the seller wallet.
  Listing approval is per NFT, followed by EIP-712 signing and publication.
  These local orders are not automatically cross-posted to OpenSea.
- Gnars contract (`gnars-contract`): a separately deployed, unmodified Seaport 1.6
  instance, with its own approval address, EIP-712 verifying contract and
  PostgreSQL order table. This third destination requires a verified deployment
  and its own storage readiness. It is not live merely because its code exists.
- OpenSea and Gnars (`gnars`) retain canonical Seaport 1.6,
  `0x0000000000000068F116a894984e2DB1123eB395`. The custom destination uses only
  `NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS`. Neither local destination adds a
  platform fee; applicable collection royalties are still included by the app.
- New OpenSea listings use the canonical conduit key and operator
  `0x1e0049783f008a0085193e00003d00cd54003c71`; Gnars-native listings use direct
  Seaport approvals to their selected protocol address. Legacy zero-conduit signed orders remain readable and
  cancellable without modifying their signature, but cannot be republished to
  OpenSea. Old direct-Seaport approvals are not approval to the OpenSea conduit.
- Approval, purchase and cancellation transactions retain the Gnars ERC-8021
  builder suffix. New signed orders additionally embed `BUILDER_CODE` into the
  leading bytes of their salt, with the remainder cryptographically random.
  This is signed-order provenance, not an ERC-8021 transaction or a claim that
  offchain signatures are counted by the Base leaderboard. Existing signatures
  and the Seaport EIP-712 domain are never rewritten.
- Local listings include the collection's current ERC2981 royalty, when supported,
  deducted from the entered gross price. RPC failures abort instead of waiving it.
- OpenSea purchases preserve signed consideration and its total price. Unsupported
  orders are rejected, never rewritten into different economic terms.
- OpenSea listings quote the collection's required fees from its API, in integer
  basis points and wei. Optional creator fees are excluded and disclosed in the
  review; no extra Gnars fee is added. Required fees are deducted from the entered
  total, with seller proceeds shown before approval/signing. Publication checks
  fresh fee policy again. Unknown fees, required zones, changed recipients/rates,
  and insufficient seller proceeds fail closed.
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

The review footer keeps the financial summary and explicit wallet action visible.
There is one recovery surface: on the page when no drawer is open, otherwise in
the drawer. Listing progress separates NFT approval, order signature and offchain
publication; a failed publication is not described as an unconfirmed transaction.

Wallet attempts are journaled in browser storage by Base account before requesting
a transaction/signature. Web Locks coordinate tabs. Reloading, closing a drawer,
or a WalletConnect timeout must not permit a duplicate submission.

The recovery panel can check receipts, continue a confirmed approval into signing,
or republish the same saved signature. Unknown transaction hashes can be supplied
for verification against the persisted intent before reconciliation. Unknown
outcomes cannot be silently reset. Clearing browser storage is not a safe recovery
procedure. No private keys are stored.

`checkStatus` only reconciles existing state; it cannot publish an order or request
a wallet signature. Continuing/retrying is a separate explicit action. Permanent
publication rejections disable blind publication retries while keeping status
checks and cancellation available. Rejecting a cancellation prompt preserves the
original signed order and prevents it from being replaced by a new listing.

Invalid journals expose an export and conservative metadata repair instead of a
dead control or storage reset. Repair requires a structurally valid signed order
belonging to the connected account, preserves that order, and refuses records with
transaction details or unresolved signatures. Exported recovery data can contain
an executable signed order and must be handled accordingly.

When an approval receipt is unavailable, recovery can confirm the current NFT
owner and exact saved approval operator at the same Base block. This applies only to a
saved zero-value, single-NFT approval intent; it never substitutes for purchase or
cancellation transaction verification. Cancellation recovery separately checks
Seaport's cancelled flag for the exact saved order before requiring its receipt;
an already-cancelled order is terminal even if the RPC cannot return that receipt.
The observed approval hash is retained as
`approvalTxHash`, pending transaction fields are cleared, and the user explicitly
continues before signing. Ownership, approval and fees are checked again then.

Saved listing attempts persist their destination and reviewed fee quote. Legacy
attempts without a destination remain Gnars-native and are never silently posted
to OpenSea. An OpenSea retry checks the exact hash before publishing and only
confirms a matching provider order. A lost response followed by a sale,
cancellation or expiry is resolved from chain as that terminal outcome, not as a
new active listing. A saved signed order that cannot be published can be cancelled
onchain from the recovery panel after explicit confirmation; it cannot simply be
discarded. OpenSea cancellation reads exact order components, verifies them again
in the client, and uses the same tagged transaction and receipt recovery flow.

The canonical OpenSea order lookup can return HTTP 400 with
`{"errors":["Order not found"]}` for a missing hash, as well as HTTP 404. Only that
exact 400 response on the optional order lookup means absent; other provider
errors must still abort publication rather than bypass its retry checks.
Publication adds the required `totalOriginalConsiderationItems` count only to the
OpenSea wire payload. It does not change the stored EIP-712 order or its hash.
The current POST response is a direct OpenSea `Listing`: it is validated against
the exact submitted order before accepting publication. Older/unrecognized
envelopes fall back to the canonical hash lookup, never an assumed success.
Provider failures identify the operation (read, posting or fulfillment), HTTP
status, network failure or malformed JSON in the API error. Typed errors retain
their safe diagnostic code, retryability and request ID through the API and UI.
Posting rejections, changed fees, authentication failures and temporary provider
failures are distinct; only static diagnostic categories are shown. Raw provider
bodies, credentials and signatures are never forwarded as diagnostic text.

## Configuration And Cost

1. Configure `OPENSEA_API_KEY` as a server secret for external listing reads,
   purchases, publication and cancellation-data reads. None requires a local
   order database. Readiness reports `openseaBuy`, `openseaSell`, `openseaCancel`
   separately from PostgreSQL-backed `localTrading`.
2. For Gnars-native listings, configure a pooled PostgreSQL URL in `MARKETPLACE_DATABASE_URL`. Existing
   `ROUNDS_DATABASE_URL`, `DATABASE_PUBLIC_URL`, `DATABASE_URL` are fallbacks,
   in that order. Apply `scripts/marketplace-schema.sql` to the selected database.
3. Confirm `/api/marketplace/readiness` reports the expected capabilities.
4. Configure Vercel WAF rate limits for public marketplace GET endpoints before
   broad production exposure. App-instance limits alone are not a
   distributed public-read quota. Monitor provider quota and Vercel usage.
5. Verify a real OpenSea API response and controlled wallet flow before announcing
   trading availability. Do not use production funds for automated tests.

### Independently Deployed Contract

All three destinations remain native-ETH fixed-price sales of the existing Gnars
ERC721. Adding an independently deployed settlement address does not add offers,
auctions, other collections or minting. Canonical Gnars and OpenSea orders remain
on their original contracts; approval, signatures and cancellation cannot migrate
automatically to the new address.

`contracts/gnars-marketplace/upstream-lock.json` pins unmodified MIT-licensed
`ProjectOpenSea/seaport-core` at `523097f9cee66c15d308c900c50f336b291cda08` and
`seaport-types` at `b72493221ee1d2f2fb30ed94a3cc535a9028d09f`. Vendored source
hashes are checked before every build. Compiler settings are Solidity
`0.8.24+commit.e11b9ed9`, Cancun, via-IR, optimizer enabled with 4,294,967,295 runs
and metadata bytecode hash `none`. Source licenses are preserved. No source
changes or configurable Gnars fee hooks are introduced.

From the repository root:

```bash
node scripts/custom-marketplace-build.mjs
pnpm exec tsx scripts/custom-marketplace-fork.ts
```

The optional build flag `--fetch` refreshes the vendored sources from the two
exact pinned upstream commits. Build outputs are
`contracts/gnars-marketplace/artifacts/Seaport.json` (ABI, creation bytecode,
runtime template, compiler metadata and hashes), `standard-input.json` (complete
compiler input for explorer verification), and `runtime-manifest.json` (small
runtime identity manifest). The official constructor takes the canonical conduit
controller `0x00000000F9490004C11Cef243f5400493c00Ad63`.

The fork script starts its own localhost-only Anvil on port 18559 at Base block
51,021,116; its default upstream is the public Base RPC. It does not load env
files, use real wallets or submit upstream writes. `CUSTOM_MARKETPLACE_FORK_URL`
may explicitly override the read-only upstream. Deployment, approval, purchase
and cancellation calldata include the builder suffix; signed salts carry builder
provenance. The zero-fee fixture verifies that the seller receives the entire
price, not that the app waives royalties.

The verified fork deployment consumed 5,290,703 gas and returned 23,981 bytes of
runtime. This is a gas-unit observation, not a live ETH/USD cost quote: mainnet
fees and L1 data fees must be estimated for the actual user-signed transaction.
The constructor deploys its own tiny TLOAD probe; its address and the EIP-712
domain separator differ across instances, so raw runtime hashes cannot simply
be compared between deployments.

No deployment UI or automatic mainnet broadcaster is included. Mainnet deployment
requires an explicitly reviewed creation transaction signed by the user's wallet.
The provided verifier supports direct EOA creation, not an unreviewed factory or
smart-account CREATE route. Do not put a deployer private key in scripts or env.
After the user signs and the deployment confirms, run:

```bash
pnpm exec tsx scripts/custom-marketplace-verify.ts <contract-address> <creation-tx-hash>
```

This read-only check verifies Base, the successful creation receipt, exact
creation bytecode plus constructor argument and builder suffix, runtime outside
compiler-declared immutable slots, Seaport version, domain and controller.
Complete explorer source verification separately with `standard-input.json`,
compiler `v0.8.24+commit.e11b9ed9`, contract
`vendor/seaport-core/src/Seaport.sol:Seaport`, and the ABI-encoded controller
constructor argument. Preserve the actual compiler settings rather than guessing
a lower optimizer count. Retain the creation hash and verification result.

Only then configure the public address in both build and server environments and
deploy the application. Runtime readiness independently checks the pinned runtime
against canonical Base Seaport, validates every immutable constant, the exact
domain/controller/chain and the constructor's TLOAD probe, with a 30-second cache.
It fails closed for arbitrary addresses, incorrect deployments or unavailable
RPC data. `customTrading` also requires the separate custom-order table and
restricted runtime permissions. Existing `localTrading` is independent.

The additive migration is `scripts/marketplace-contract-schema.sql`, applied
separately by the administrative database operator. It creates
`marketplace_contract_orders`, keyed by chain, protocol address and order hash,
without rewriting existing canonical orders. It enables RLS, excludes public
Data API roles and grants the existing `gnars_marketplace` runtime role only
SELECT/INSERT, UPDATE of `status`/`checked_at`, and sequence USAGE. Deployment
preparation does not apply this migration to production automatically.

These checks and the upstream protocol's history are not an audit of this
deployment or integration. Exact audit coverage of the pinned version has not
been established; never represent a modified fork as inheriting an upstream audit.

### Supabase Connection Security

Use the project's transaction-pooler connection for Vercel, with a dedicated
non-owner marketplace login rather than the `postgres` administrator. Its grants
are limited to schema usage, order SELECT/INSERT/UPDATE, rate-limit
SELECT/INSERT/UPDATE/DELETE, and USAGE of the order-ID sequence. Enable RLS with
policies scoped only to that runtime role; revoke these objects' Data API access
from `PUBLIC`, `anon`, `authenticated`, and `service_role`. No browser Supabase
client or Supabase Auth integration is required.

Set the server-only `MARKETPLACE_DATABASE_SSL_CA` to the project's trusted PEM
certificate when its connection requires a custom CA. Both multiline PEM and
literal `\\n` escapes are accepted. Supplying a CA forces TLS certificate and
hostname verification; URL SSL parameters cannot override that configuration.
Connections without this variable retain their existing driver behavior. Never
disable certificate verification to work around connection errors.

An administrative `SUPABASE_DATABASE_URL` may be supplied locally for provisioning
only. Never deploy that administrator credential to Vercel or prefix a database
variable with `NEXT_PUBLIC_`. Use `MARKETPLACE_DATABASE_URL`, not a shared fallback,
to avoid enabling unverified rounds or checkout storage. Keep production and
preview data and credentials isolated.

Verify the runtime role's actual inserts, reads, updates, budget upserts and
cleanup inside a rolled-back transaction before enabling production. The readiness
check verifies table structure and grants but does not prove RLS policies allow
the required operations. Also verify anonymous/authenticated Data API roles
cannot access the marketplace tables, and the runtime role cannot delete orders
or perform schema changes.

### Provisioning Commands

`scripts/marketplace-supabase-setup.mjs` separates database setup from deployment.
Run from the repository root using Node 24; each command requires the expected
Supabase project reference explicitly:

```bash
node scripts/marketplace-supabase-setup.mjs inspect <project-ref>
node scripts/marketplace-supabase-setup.mjs provision <project-ref>
node scripts/marketplace-supabase-setup.mjs smoke <project-ref>
node scripts/marketplace-supabase-setup.mjs publish-env <project-ref>
```

- `inspect` loads local `.env.local`, verifies the admin session-pooler URL matches
  the supplied project, and reports existing public tables and runtime-role
  presence. It downloads the CA from Supabase's official certificate distribution
  endpoint over HTTPS and verifies PostgreSQL TLS; it does not change the database.
- `provision` requires a fresh public schema and no existing runtime role or local
  runtime connection settings. It creates the tables and security policies,
  generates a restricted-role password, and writes the runtime URL and CA into
  `.env.local` with owner-only permissions. It then runs the rollback smoke test.
  It refuses to overwrite existing setup or rotate credentials silently.
- `smoke` uses the runtime URL and CA already present locally. It verifies allowed
  SQL operations, rejects forbidden operations, and rolls back its test rows.
- `publish-env` first repeats the runtime smoke test, then uploads only
  `MARKETPLACE_DATABASE_URL` and `MARKETPLACE_DATABASE_SSL_CA` to the linked
  `gnars.com` Vercel project's Production environment. Vercel CLI authentication is
  required. It does not publish administrative credentials or configure Preview.

The official CA source used by the script is
`https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`.
Admin URLs use the dashboard's session pooler on port 5432, without SSL query
overrides; generated runtime URLs use that project's transaction pooler on 6543.

These commands never deploy the application or submit blockchain transactions.
Verify both Vercel variables before the separate deployment and then check
production readiness. If provisioning is interrupted after writing local settings,
inspect the database before retrying; retained credentials are not proof of a
committed setup. Environment uploads are sequential, so a failed upload can leave
only one variable configured; `publish-env` can be retried without recreating the
database.

Missing configuration disables only the dependent actions: an absent OpenSea key
disables external buying/publication; unavailable PostgreSQL disables local listing creation,
purchase and cancellation through the local orderbook. `not_configured` means an
inactive source, not an outage banner. A configured source that fails or yields
partial results is explicitly incomplete, not an empty successful result.
Readiness describes configuration, not a successful live provider health check.
Metadata and listing-read failures do not indiscriminately disable independent
selling/cancellation capabilities. OpenSea purchases still require fresh
order/owner/price checks, exact-calldata validation and simulation.

Pages use 24-item cursor pagination. Collection reads cache for 60 seconds,
OpenSea list reads for 30 seconds, local listings for 15 seconds. Public API
responses use short CDN caching; owned inventory and failed reads are no-store.
Details load on demand, without a per-NFT external request for every grid card.
Owned inventory is enriched by one cached maker-filtered OpenSea feed (up to 200
results); a remaining cursor marks it partial. The owner-listings view has its own
maker-filtered pagination. A failed source retains its input cursor so a later
retry does not silently skip that source's page.
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

Native listing reads reuse snapshots younger than 15 seconds. Stale candidates
share one Base block and batched multicalls for status, counter, ownership and
approval; one bulk update persists the verified results. After cached readiness,
this is one candidate SELECT plus at most one snapshot UPDATE rather than SQL
reads/writes per card. Failed checks mark the result partial. Transaction execution
still validates the selected order freshly; a catalogue snapshot cannot authorize
a purchase.

Read, posting and fulfillment provider quotas are separate. The fee policy is
cached for five minutes for quote previews, but is freshly read before posting.
OpenSea order cache invalidation is separate from catalogue/fee metadata and
bounded per instance to limit replay-driven cache flushes.

Production WAF verification remains an operational prerequisite: project-scope
access was unavailable during this review. In a deployment without the order
database, the distributed provider-budget fallback is not active; do not mistake
per-instance limits for a verified account-wide cap.

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
- `tests/e2e/marketplace-selling.spec.ts`: connected desktop/mobile listing,
  approval, purchase and completed cancellation through the actual action buttons,
  using an in-memory provider/RPC ledger. Coverage includes exact-signature retry,
  rejected cancellation preserving the order, permanent publication rejection,
  safe journal recovery and unavailable-receipt recovery. Signing/broadcasting
  are counted and builder suffixes are checked. The ledger tests browser state
  transitions; the fork tests exercise the actual contracts.
- `scripts/marketplace-opensea-probe.ts [appOrigin] [simulationBuyer]`: read-only
  authenticated OpenSea collection/fee checks, app quote accounting, live listing
  and canonical-order compatibility, exact cancellation encoding, and app
  fulfillment validation with onchain simulation. The probe permits only quote
  and fulfillment preparation POSTs, never publication or broadcasting. Run with
  `pnpm exec tsx scripts/marketplace-opensea-probe.ts http://localhost:3100` against
  a running app with the server-side key configured in `.env.local`.
- `scripts/marketplace-inspect.ts <tokenId> [transactionHash]`: read-only Base
  ownership, approval and receipt diagnostics. Without a hash, it searches recent
  public Blockscout account transactions for the matching NFT approval. It never
  signs, publishes an order or broadcasts a transaction.
- A read-only authenticated OpenSea check on September 6 successfully encoded and
  independently validated the live Gnars #1951 fulfillment response. This checks
  provider response compatibility, not a funded production wallet transaction.
- During the September 7 review, the fork smoke and live OpenSea/app probe passed.
  These checks do not establish that production publication or a funded wallet
  trade succeeded, nor do they certify that a deployment has completed.
- The listing fork smoke additionally verifies a required-fee order's exact
  seller/fee balances, whole-NFT transfer, and tagged cancellation. Browser
  listing tests use mocked provider/RPC responses; they must never publish a
  real order or send a production transaction. Live publication with an actual
  owner wallet remains a separate explicit manual validation.

Protocol references: [Seaport](https://github.com/ProjectOpenSea/seaport),
[OpenSea conduit mapping](https://github.com/ProjectOpenSea/opensea-js/blob/main/src/utils/chain.ts),
[OpenSea fulfillment API](https://docs.opensea.io/reference/generate_listing_fulfillment_data_v2),
[ERC2981](https://docs.openzeppelin.com/contracts/5.x/api/token/common).
