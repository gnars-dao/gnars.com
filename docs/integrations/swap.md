# SwapsPro Swap Integration

The `/swap` page trades ETH, USDC, GNARS and the other tokens in the picker, on six
chains, through
the [SwapsPro HTTP API](https://www.swaps.pro/docs/api). One `GET /quote` routes across
0x, CoW, LI.FI, Relay and more and returns a firm quote with the transaction to sign.
There is no API key. All transaction signing happens through the existing thirdweb
wallet layer (`useWriteAccount`), exactly as before.

## Architecture

```
src/app/[locale]/swap/
  SwapWidget.tsx      "use client" — debounced price, approve, swap
  TokenPicker.tsx     responsive token catalogue, shared search and wallet balances
  tokenPickerModel.ts pure token identity, filtering and balance formatting

src/lib/
  swappro.ts          pure: SwapsPro request/response ⇄ the shape the widget reads (unit-tested)
  swapproRoute.ts     the one handler: reads the query, sets the fee from config, calls SwapsPro
  swap-token-directory.ts validated creator/stock catalogue schema and provider parsers

src/services/
  swap-token-directory.ts cached Zora/Clanker discovery and vetted Base stock registry

src/data/
  swap-stock-tokens.ts 13 Coinbase B20 tokens verified on Base on 2026-09-07 (8 decimals)

src/app/api/swap/
  tokens/route.ts     GET catalogue, Base only, shared CDN cache and request limit

src/app/api/0x/
  price/route.ts      GET → swapproRoute   (kept at its old path so the widget does not change)
  quote/route.ts      GET → swapproRoute   (same call: every SwapsPro answer is firm)
```

The routes keep their `/api/0x/*` paths on purpose: the widget's two-step flow (price while
typing, quote on click) is untouched, and the fee recipient is still set server-side from
`src/lib/config.ts` rather than in the client bundle.

## Token Selector

Desktop uses three independently scrolling columns; mobile uses keyboard-accessible
category tabs. The first column switches between the connected wallet's holdings and
crypto tokens, the second contains Zora/Clanker creator coins, and the third contains
Base tokenized stocks. Symbols, names and balances cannot expand the fixed row tracks.
Full names remain searchable and available as accessible labels/tooltips.

- `/api/swap/tokens?chainId=8453` is fetched only while a picker is open. Both pickers
  share a five-minute React Query cache; typing filters locally, without catalogue requests.
- Official Zora and Clanker feeds provide bounded discovery lists, not an exhaustive
  index. Each provider is independently cached for five minutes with cold-request
  deduplication and a 30-second failure backoff. A partial response retains valid tokens
  and reports the failed source instead of pretending the catalogue is empty.
- Base stock provenance comes from the [official issuer registry](https://brand.base.org/stocks).
  Stock symbols on other chains are not reused as Base contracts. Catalogue inclusion
  does not guarantee quote liquidity or issuer eligibility; swap routing remains unchanged.
  Balances and swap amounts are ERC-20 token units, not underlying share counts. B20
  multipliers and transfer policies are described in the
  [Base integration guide](https://docs.base.org/specifications/b20/tokenized-stocks-on-base).
- The wallet's Pioneer portfolio supplies row balances, with one shared native-asset
  query while open. There are no per-row balance queries or Zora logo lookups. Logos
  come from catalogue/portfolio metadata and fall back to the token initial.
- Unknown contract addresses use the existing debounced metadata lookup. Case-insensitive
  address identity prevents duplicate rows and selecting the same token on both sides.
- Other supported swap chains retain wallet/crypto selection; Base-only catalogues are
  never injected into a different chain.

Regression coverage: `tokenPickerModel.test.ts`, the directory parser/service/route tests,
and `tests/e2e/swap-token-picker.spec.ts` (PT-BR desktop/mobile, long labels, selection,
category navigation, shared requests and provider failures).

## Flow

1. User picks sell/buy tokens and enters an amount.
2. After 600 ms of idle, `SwapWidget` calls `/api/0x/price` with `chainId`, `sellToken`,
   `buyToken`, `sellAmount` (base units), `taker`, `sellDecimals`, `buyDecimals` and
   (optionally) `fee=1`.
3. The handler converts base units to human decimals, maps the native sentinel
   (`0xeeee…`) to the chain's native symbol, and calls
   `https://www.swaps.pro/api/sdk/v1/quote`. The answer comes back in the widget's shape:
   `liquidityAvailable`, `buyAmount` / `minBuyAmount` in base units, `issues.allowance`
   when an ERC-20 approval is needed, `transaction { to, data, value, gas }`, and `route`
   naming the venue SwapsPro chose.
4. If `issues.allowance` is present, the widget shows "Approve". SwapsPro's approval is for
   the exact amount; the widget's existing approve flow (`prepareContractCall` +
   `sendTransaction`) is unchanged.
5. "Swap" calls `/api/0x/quote` — the same call — and sends `transaction` via
   `prepareTransaction` on the user's thirdweb account.
6. Wrong-network state shows a "Switch to Base" CTA, as before.

## Configuration

| Setting       | Source                                       | Notes                                                                                                  |
| ------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| API key       | none                                         | SwapsPro is CORS-open and keyless. `ZEROX_API_KEY` is no longer read.                                  |
| Fee recipient | `getSwapFeeRecipient` in `src/lib/config.ts` | Sent as SwapsPro's `partner`. An EVM address as partner is the opt-in to being paid the partner share. |
| Fee rate      | `SWAP_FEE_BPS` in `src/lib/config.ts`        | Sent as `partnerFeeBps`. SwapsPro caps it at 100 bps (200 with a Pro Pass).                            |
| Rate limit    | SwapsPro                                     | 60 quotes a minute per IP with no credential; the proxy shares the site's server IP.                   |

## Affiliate fee behaviour — read this before merging

The fee is still **opt-in per request** (`fee=1`, the "Support Gnars treasury" checkbox,
default checked), and it is now also **gated on the chain**. What changes is _how_ it is
collected, and it depends on the venue SwapsPro picks for the quote:

- **0x and CoW** — collected on chain, on top of SwapsPro's own 30 bps, and paid to a
  0xSplits contract derived from `(payout address, bps)` that divides it between the
  treasury and SwapsPro with no invoice and nobody to trust.
- **LI.FI** — collected, but LI.FI registers one fee wallet per integrator rather than
  accepting one per request, so it lands in SwapsPro's wallet and the response says so
  (`paidToPartner: false`).
- **Relay and other Pioneer venues** — cannot carry a partner fee at all.

Every quote returns a `partnerFee` block saying what was requested, what was collected,
whether it was `paidToPartner` and where it landed. The handler passes it through verbatim.

### The chain gate

`GNARS_SWAP_PAYOUT` in `src/lib/config.ts` lists the chains where the treasury has an
address that can actually receive. **A chain missing from that map asks for no fee at
all** and the checkbox is not shown there.

That is not caution, it is measurement: `eth_getCode` on 2026-09-03 found the treasury's
split holding 89 bytes on Base and **zero** on Ethereum, Arbitrum, BNB Chain, Avalanche
and Robinhood Chain. Requesting 50 bps on those chains would take the money from the user
and park it at an address with nothing behind it. Without the gate the user pays 80 bps
and the treasury receives none of it.

To earn on another chain: deploy the same split there (0xSplits derives the address from
the configuration, so it carries over unchanged), then add the chain id to the map.
Robinhood Chain is the exception — 0xSplits has no factory on 4663, so an EOA or a Safe
is the only option there.

## What the user gains

- Every quote is priced across every venue at once, not just 0x.
- `minBuyAmount` is the floor the transaction enforces on chain; the wallet receives at
  least that or the transaction reverts.
- No API key to rotate, no per-request 0x pricing.
- Cross-chain and Bitcoin-native routes (THORChain) are one parameter away when the DAO
  wants them: the same endpoint takes a different `sellChain`.

## Chains

The picker offers exactly the six chains SwapsPro routes: Base, Ethereum, Arbitrum,
BNB Chain, Avalanche and Robinhood Chain.

Optimism was removed. It sat in the picker and every quote on it came back
`liquidityAvailable: false` with `code: UNSUPPORTED_CHAIN` — a chain offered that could
never fill an order. `chains.test.ts` now fails when `SWAP_CHAINS` and `SWAPPRO_CHAINS`
disagree, so a chain SwapsPro adds shows up as a failing test rather than as silence, and
one it drops cannot linger.

Token addresses and decimals come from SwapsPro's own `/tokens` registry and were read back
from chain before being written down. Two that are not guessable: **BNB Chain's USDT and
USDC carry 18 decimals**, not Ethereum's six, and Avalanche's Tether is `USDt`. Robinhood
Chain carries tokenised equities (NVDA, TSLA), which is the reason it is worth offering.
