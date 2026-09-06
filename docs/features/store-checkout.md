# Store Checkout and Payment

The customer checkout at `/store/[slug]/checkout` collects order details, accepts USDC
on Base in live mode, verifies payment ownership, and creates a KeepKey fulfillment
order. Sandbox mode uses `KK-TEST-001` without taking payment. Both customer modes
require a connected wallet and a signed checkout request.

The production configuration inspected during the audit has no KeepKey tokens or
checkout database URL. Checkout therefore remains unavailable until those prerequisites
are configured; implementing the payment gate does not activate fulfillment.

## Readiness and Setup

`GET /api/store/checkout` returns `{ ready, sandbox }`. Before a new live payment, the
client requires `ready: true`. The server independently checks readiness during checkout.

| Mode    | Required configuration                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| Sandbox | `KEEPKEY_DROPSHIP_MODE=test`, `KEEPKEY_DROPSHIP_TEST_TOKEN`                                                             |
| Live    | `KEEPKEY_DROPSHIP_MODE=live`, `KEEPKEY_DROPSHIP_LIVE_TOKEN`, configured checkout recipient, reachable migrated Postgres |

Live payment storage uses the first configured URL in this order:
`ROUNDS_DATABASE_URL`, `DATABASE_PUBLIC_URL`, `DATABASE_URL`. A configured URL alone
does not make checkout ready: the readiness query must also find the required table.

Before enabling live mode, apply [scripts/security-schema.sql](../../scripts/security-schema.sql)
to the selected database. It creates `store_payment_claims`, keyed by `(chain_id, tx_hash)`.
Run the migration as a deployment operation; request handlers do not create tables.
Use a database connection string with the TLS settings required by its provider.

Other configuration:

- `NEXT_PUBLIC_STORE_CHECKOUT_ADDRESS` overrides the recipient in
  `src/lib/config.ts` (`STORE_CHECKOUT.recipient`).
- `KEEPKEY_DROPSHIP_BASE_URL` optionally overrides the fulfillment API endpoint.
- `EMAIL_USER` / `EMAIL_PASS` and optional SMTP settings configure best-effort buyer
  receipts. Missing email configuration does not fail a placed order.
- `KEEPKEY_DROPSHIP_INTERNAL_SECRET` protects live calls to the separate internal
  `/api/store/orders` creation endpoint. Customer checkout does not use that endpoint.

## Customer Flow

1. Collect product finish, contact information, and a supported US shipping address.
2. Connect the wallet. For a new live payment, check readiness before requesting USDC.
3. `useUsdcPayment()` sends the retail amount through `useWriteAccount()` and waits for
   a successful receipt. It returns the mined transaction hash, including for smart
   accounts. A reverted receipt is rejected.
4. Persist the paid hash and form locally before requesting fulfillment. A retry uses
   that hash and never automatically makes another payment.
5. Parse the order through `checkoutInputSchema`, which normalizes the transaction
   hash to lowercase, then sign the canonical checkout payload.
6. POST `{ checkout, authorization }` to `/api/store/checkout`.
7. The server verifies the signature, product eligibility, shipping region, payment,
   and durable claim before sending the order to KeepKey.
8. Show confirmation and track the order using the returned access token.

## Authorization and Payment Claims

The authorization binds the Gnars audience, Base chain, method, path, complete order
payload digest, signer, issue time, and nonce. It expires after five minutes. Verification
supports EOAs and ERC-1271/ERC-6492 smart wallets. A public transaction hash is not proof
of payment ownership.

For live orders, `verifyUsdcPayment()` requires a successful Base transaction with at
least one confirmation and a Base USDC `Transfer` whose sender is the authenticated
wallet, recipient is the configured checkout wallet, and value covers the retail price.
Receipt propagation is retried for up to 25 seconds.

The server reserves the normalized hash in Postgres against the payer and the exact
order payload digest. Different payer or order details receive `409`. The fulfillment
identifier is `gnars-<lowercase txHash>`; KeepKey's external-order idempotency handles
concurrent or interrupted fulfillment attempts using that same identifier.

A completed claim returns the saved order and a refreshed tracking token without
creating another order or sending another receipt email. An incomplete claim can retry
the original payload. Once reserved, changing order details requires operator recovery;
do not delete a claim until the upstream order state has been reconciled. If fulfillment
succeeds but the local completion write fails, retry with the same payment and payload.

The claim table stores payer, transaction hash, payload digest, completion result, and
timestamps. It does not persist the complete shipping/contact form. Full buyer order
history and automated refunds are separate, unimplemented workflows.

## Tracking and Request Limits

Checkout returns `orderAccessToken`, an HMAC-authenticated capability scoped to both
the KeepKey order ID and external order ID, valid for 90 days. Its signing key is derived
with a distinct purpose label from the active KeepKey token. Rotating that token also
invalidates previously issued tracking tokens.

Both `GET /api/store/orders?externalOrderId=...` and `GET /api/store/orders/[id]` require
the capability in `x-gnars-order-token`. Possession of an order ID alone does not authorize
a read. Keep tokens private. A signed live checkout retry can recover a completed order
with a new token.

The confirmation view polls every five minutes while visible and nonterminal; manual
refresh remains available. The sandbox tester receives and sends tracking tokens too.

Checkout caps JSON bodies at 32,000 bytes, with secondary process-local limits of 20
requests per hour per IP and per wallet. Tracking has a local 30-per-minute IP limit;
raw internal/sandbox creation has a local 10-per-hour IP limit. **These counters are not
distributed quotas.** The four WAF rules published for this audit cover uploads
(60/hour/IP), Alchemy (120/minute/IP), revalidation (20/minute/IP), and wallet endpoints
(60/minute/IP); they do not provide a store-specific distributed limit. Add an appropriate
store WAF rule before public fulfillment activation.

## Code and Verification

- `src/components/store/CheckoutFlow.tsx`, `src/hooks/use-usdc-payment.ts`: customer flow.
- `src/app/api/store/checkout/route.ts`: readiness, authorization, fulfillment, receipts.
- `src/services/store-payment.ts`: authenticated payer and receipt verification.
- `src/services/store-payment-claims.ts`: durable reservation and completion.
- `src/lib/schemas/checkout.ts`: order validation and hash normalization.
- `src/lib/server/store-order-access.ts`: scoped tracking tokens.
- `src/lib/wallet-authorization.ts`, `src/lib/server/request-security.ts`: shared request
  authorization, byte limits, and local rate counters.

Tests cover foreign-payer rejection, mixed-case hash normalization, claim conflicts,
completed retries, missing-storage readiness, and tracking token scope/expiry. Database
and fulfillment calls are mocked in these tests. Before live activation, run the SQL
migration, verify readiness, and test the signed flow with EOA and smart-account wallets
in sandbox. Real payments, shipments, and credentials are not needed for unit tests.
