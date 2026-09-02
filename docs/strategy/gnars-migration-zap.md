# The migration zap — designed, not built (decision of 2026-09-02)

A periphery contract was in the plan to make the swap → deposit step deposit the
_exact_ ETH received. It is not being built. This note keeps the design so it can
be revived if exactness ever matters, and records why it lost.

## Why it looked necessary

The smart-account batch signs every call up front, so the ETH a swap will return
is not known when `deposit{value: …}` is encoded. A contract that reads the
received amount at execution time could deposit it all.

## Why it is not needed

Atomicity comes from the batch, not from a contract. In a smart account
`msg.sender == user`, so the batch already calls `UpgraderEth.deposit` directly
and passes the "Not authorized" check with no `addDelegate`. The only gap is the
unknown amount, and the batch closes it by depositing the router's guaranteed
minimum — the same `amountOutMin` the router enforces — computed per route from
its measured price impact (`src/lib/route-margin.ts`). Whatever arrives above the
minimum stays in the user's own wallet as ETH, visible, and depositable from the
terminal.

## Why it lost

1. **Built-in expiry.** kompreni offered an on-chain deadline that requires a
   redeploy of UpgraderEth — a new address and a new upgrade id. A zap fixes both
   in its constructor, so it would be deployed with a known shelf life.
2. **Trust and audit cost.** A new contract touching community ETH has to be
   reviewed and trusted. The thing it buys is a sub-margin remainder that never
   leaves the user's wallet.
3. **Worse UX, more surface.** Zora's quote API returns unusable calldata when a
   `recipient` is passed (`target` becomes the recipient, a one-call
   `executeBatch`), so the zap could not simply receive ETH from the router. It
   would have to pull WETH by allowance: one more approval per run, plus a
   standing allowance to reason about.

## The design, for the record

```
GnarsMigrationZap(upgrader, upgradeId, weth)   // all immutable, no owner, no sweep
depositAll(user, minAmount, maxAmount) → amount
  require msg.sender == user                    // no third party can push a user's WETH in
  require upgrader.isUserDelegating(user, this) // user ran addDelegate(zap) once
  amount = min(WETH.balanceOf(user), allowance, maxAmount); require amount ≥ minAmount
  WETH.transferFrom(user, this, amount); WETH.withdraw(amount)
  upgrader.deposit{value: amount}(upgradeId, user, address(0), amount)
receive() only from WETH                        // stray ETH refused
```

Batch shape: `[swaps → WETH to user, WETH.approve(zap), addDelegate(zap) once, zap.depositAll(user, minOut, quote × 1.05)]`.
A fork test suite against the live UpgraderEth passed the happy paths (exact
balance, `maxAmount` cap, allowance cap, below-minimum revert, no-delegation
revert, withdraw afterwards). Two assertions never got fixed before the decision:
reverts from the live contract come back without data under `vm.prank` from a
contract address, and `withdraw` appears to pay out WETH rather than ETH — worth
knowing on its own, and now noted in the handoff doc as something to confirm.
