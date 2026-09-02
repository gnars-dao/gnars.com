# Gnars × UpgraderEth — how /migrate is wired

Status as of 2026-09-01. Companion: `gnars-token-spec.md` (tokenomics, allocations).

## Verified on-chain (Base 8453)

Contract `UpgraderEth` at `0x064fd3d95f322909489dc085bb0044a343191ad3` (owner `0xb5a5…b6a2`, Onchain Inc / kompreni).
Simulated `eth_call` per candidate token, caller = depositing user:

| token                      | contract response    | reading                          |
| -------------------------- | -------------------- | -------------------------------- |
| `0x0000…0000` native ETH   | "No ETH sent"        | eligible (the only lane)         |
| `0x4200…0006` WETH         | passes eligibility   | eligible                         |
| old `$gnars` `0x0cf0…b23b` | "Token not eligible" | **rejected — ETH-only is final** |
| ZORA, USDC                 | "Token not eligible" | rejected                         |

- `deposit(uint256 upgradeId, address user, address token, uint256 quantity) payable` — **four** args, no `bool donation`.
- `deposit` reverts "Not authorized" when `msg.sender != user`, unless the user registered the caller via `addDelegate`. The authorization check runs before the token check.
- `withdraw(upgradeId, user, token, quantity)` exists and works until `execute()` runs — the user-side exit. `claim(upgradeId, user)` after.
- `halt()` and `sweep(token, recipient, quantity)` are owner-only. The owner is **not** the DAO multisig. The copy therefore never says "non-custodial".
- `getUpgradeCount() = 1`, `getTokens(0) = [address(0)]`, `isHalted() = false`. Upgrade id 0 is Gnars (confirmed by kompreni).
- No deadline getter, no notice period. The window closes the moment the operator calls `execute()`.

ABI: `~/Code/sopa-estado/artifacts/upgrader-eth-abi.json` (the contract is not verified on Basescan).

## Config — nothing is final

`NEXT_PUBLIC_UPGRADER_ADDRESS` and `NEXT_PUBLIC_MIGRATION_UPGRADE_ID` are **empty by default**. kompreni offered an on-chain deadline that requires a redeploy, i.e. a new address and a new id. The terminal turns on in production only when Vlad gives the go and both envs are set on Vercel. A malformed value renders as a configuration error, never as "opens at launch" (`src/lib/migration-config.ts`).

Terms (1% fee · 30% treasury · 7-day vesting) are confirmed by kompreni but not readable on-chain. They stay **out of the UI** and go in the launch announcement, attributed to him.

## What the page does (`src/app/[locale]/migrate`)

1. **Sell to ETH** — `useMigratableCoins` lists real Zora coins (indexer, not an ERC-20 scan); `useCoinQuotes` quotes each straight to ETH via `createTradeCall` at 5% slippage (`MIGRATION_SLIPPAGE`).
2. **Execute** — `useExecuteMigration`:
   - `batch` (smart account, sponsored gas, one signature): per coin `coin.approve(PERMIT2)` → `PERMIT2.approve(coin, router)` → `router.execute(...)` with Zora's `PERMIT2_PERMIT` command stripped (`src/lib/zora-router-call.ts`), then `deposit{value: minOut}`. Validated on a Base fork: `scripts/sim-migrate-batch.ts`.
   - `sequential` (plain EOA): the Zora SDK signs a Permit2 permit per coin, then one deposit tx. The UI states the signature count; the fallback is never silent.
   - Each coin's slippage — and so the router's `amountOutMin` and the deposit — is a per-route margin derived from the measured price impact (`src/lib/route-margin.ts`, 0.5%–5%). Anything received above the minimum stays in the wallet as ETH and can be deposited from the terminal.
3. **Terminal** — `useUpgraderPosition` reads `getUserDeposit / getUserClaim / getUserClaimed / getBuyToken / getTotalDeposit / isHalted` with wagmi; a failed read renders as a failure with retry, never as zero. `useUpgradeDeposit` writes deposit / withdraw / claim through `useWriteAccount` and `@/lib/builder-code`.

## Open

- Sell leg for existing old-$gnars holders (`$gnars → ZORA → WETH`, V4 hook `0xd61A…9040`): quote, show price impact as a number, and say that holding is a legitimate choice. Not built yet.
- Zap: decided against (`gnars-migration-zap.md`). The batch deposits the per-route guaranteed minimum instead.
- Confirm with kompreni whether `withdraw` on the ETH lane pays out ETH or WETH — a fork test suggested WETH.
- Notice period before `execute()`: asked, unanswered.
