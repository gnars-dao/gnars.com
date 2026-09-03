# SwapPro Swap Integration

The `/swap` page trades ETH, USDC, GNARS and the other tokens in the picker, on six
chains, through
the [SwapPro HTTP API](https://www.swaps.pro/docs/api). One `GET /quote` routes across
0x, CoW, LI.FI, Relay and more and returns a firm quote with the transaction to sign.
There is no API key. All transaction signing happens through the existing thirdweb
wallet layer (`useWriteAccount`), exactly as before.

## Architecture

```
src/app/[locale]/swap/
  SwapWidget.tsx      "use client" — token pickers, debounced price, approve, swap (unchanged UI)

src/lib/
  swappro.ts          pure: SwapPro request/response ⇄ the shape the widget reads (unit-tested)
  swapproRoute.ts     the one handler: reads the query, sets the fee from config, calls SwapPro

src/app/api/0x/
  price/route.ts      GET → swapproRoute   (kept at its old path so the widget does not change)
  quote/route.ts      GET → swapproRoute   (same call: every SwapPro answer is firm)
```

The routes keep their `/api/0x/*` paths on purpose: the widget's two-step flow (price while
typing, quote on click) is untouched, and the fee recipient is still set server-side from
`src/lib/config.ts` rather than in the client bundle.

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
   naming the venue SwapPro chose.
4. If `issues.allowance` is present, the widget shows "Approve". SwapPro's approval is for
   the exact amount; the widget's existing approve flow (`prepareContractCall` +
   `sendTransaction`) is unchanged.
5. "Swap" calls `/api/0x/quote` — the same call — and sends `transaction` via
   `prepareTransaction` on the user's thirdweb account.
6. Wrong-network state shows a "Switch to Base" CTA, as before.

## Configuration

| Setting       | Source                                       | Notes                                                                                                 |
| ------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| API key       | none                                         | SwapPro is CORS-open and keyless. `ZEROX_API_KEY` is no longer read.                                  |
| Fee recipient | `getSwapFeeRecipient` in `src/lib/config.ts` | Sent as SwapPro's `partner`. An EVM address as partner is the opt-in to being paid the partner share. |
| Fee rate      | `SWAP_FEE_BPS` in `src/lib/config.ts`        | Sent as `partnerFeeBps`. SwapPro caps it at 100 bps (200 with a Pro Pass).                            |
| Rate limit    | SwapPro                                      | 60 quotes a minute per IP with no credential; the proxy shares the site's server IP.                  |

## Affiliate fee behaviour — read this before merging

The fee is still **opt-in per request** (`fee=1`, the "Support Gnars treasury" checkbox,
default checked), and it is now also **gated on the chain**. What changes is _how_ it is
collected, and it depends on the venue SwapPro picks for the quote:

- **0x and CoW** — collected on chain, on top of SwapPro's own 30 bps, and paid to a
  0xSplits contract derived from `(payout address, bps)` that divides it between the
  treasury and SwapPro with no invoice and nobody to trust.
- **LI.FI** — collected, but LI.FI registers one fee wallet per integrator rather than
  accepting one per request, so it lands in SwapPro's wallet and the response says so
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

The picker offers exactly the six chains SwapPro routes: Base, Ethereum, Arbitrum,
BNB Chain, Avalanche and Robinhood Chain.

Optimism was removed. It sat in the picker and every quote on it came back
`liquidityAvailable: false` with `code: UNSUPPORTED_CHAIN` — a chain offered that could
never fill an order. `chains.test.ts` now fails when `SWAP_CHAINS` and `SWAPPRO_CHAINS`
disagree, so a chain SwapPro adds shows up as a failing test rather than as silence, and
one it drops cannot linger.

Token addresses and decimals come from SwapPro's own `/tokens` registry and were read back
from chain before being written down. Two that are not guessable: **BNB Chain's USDT and
USDC carry 18 decimals**, not Ethereum's six, and Avalanche's Tether is `USDt`. Robinhood
Chain carries tokenised equities (NVDA, TSLA), which is the reason it is worth offering.
