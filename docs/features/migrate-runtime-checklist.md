# /migrate — runtime checklist for the money-moving clicks

What an automated pass cannot do: sign. `scripts/pw-migrate-connected.ts` renders
every connected state with a real holder impersonated read-only (status chip,
ETH row, old-$gnars row with impact, Zora coins list with per-row quotes,
receipt, primary CTA, deposit terminal, position block) in both locales and both
viewports. The steps below move real value and need a human with a wallet. Use a
wallet holding a few dollars of Zora dust and a little old $gnars on Base.

Report each line as ✅ / ❌ with what you saw. Anything ❌ blocks flipping the
terminal on in production.

## The page, in the words it uses

One screen, two columns, no tabs. Left: **What you hold** ("Pick what to turn
into ETH"). Right: **Your migration deposit** ("Where it all goes"), sticky on
desktop, first in the DOM on mobile. Next to the page title sits the status chip,
which reads exactly one of: **Deposits open** (with "no close date, can end any
time"), **Opens at launch**, **Halted by the operator**, **Launched**,
**Misconfigured**, **Read failed**, **Checking…**. The deposit terminal is on by
default (the contract and upgrade id are config defaults since 2026-09-03); set
`NEXT_PUBLIC_UPGRADER_ADDRESS=` to an empty string locally to get the gated
state back.

## A. Mode 1 — in-app wallet (social / email login), pinned to the smart account

1. Connect. Left column shows, top to bottom: **ETH in your wallet** ("Ready to
   deposit as is", "accepted"), the **Old $gnars** row ("Not accepted. Sells
   through a thin pool.") with balance, "≈ x ETH" and **Price impact −x%**, then
   the **Zora coins** card whose header hint reads "0 of N selected".
2. **Select all**. Header hint becomes "N of N selected" and, when any coin
   cannot be routed, "· K without a route". Each row shows one of "≈ x ETH",
   **No liquidity** or **Quote failed**.
3. The two failure labels are visibly different: **No liquidity** is muted grey
   on a dimmed row (a dead pool), **Quote failed** is red with a warning icon (a
   quote service that fell over). Never the same label for both.
4. Press **Deselect K unroutable**. Exactly those K rows lose their checkbox,
   nothing else changes, the button goes disabled and the "· K without a route"
   part of the hint disappears. **Clear** empties the whole selection and unticks
   old $gnars.
5. The receipt on the right adds up: "ETH in wallet" minus "− gas reserve" (only
   for an EOA signer) plus "+ N Zora coins, sold" plus "+ old $gnars, sold"
   equals **Available to deposit**. With nothing selected the coins row reads
   "Nothing selected", never "0".
6. Tick the old-$gnars checkbox ("Sell my old $gnars to ETH along with the coins
   below"). A "+ old $gnars, sold" row appears in the receipt and Available to
   deposit grows; the row's impact number is unchanged. Press **75%**, then type
   a larger number than you hold: "That is more than you hold; the estimate is
   capped at your balance."
7. Terminal live: primary CTA reads **"Sell N coins and deposit ≈x ETH"** and the
   note under it is **"One signature: every sell and the deposit run as a single
   sponsored transaction."** (batch). Click it. One signature. Every step row
   turns ✓ including "ETH → migration deposit". **Deposited so far** rises by
   roughly the estimate minus each route's margin; a small ETH remainder stays in
   the wallet.
8. Terminal gated (`NEXT_PUBLIC_UPGRADER_ADDRESS=`): the chip says **Opens at
   launch**, the deposit block is locked with the gated hint, and the CTA reads
   **"Sell N coins to ETH"**. Click it. One signature, steps ✓, ETH lands in the
   wallet, coins are gone, nothing is deposited.
9. Under **Deposit from your wallet**: type an amount ≤ **Deposited so far** and
   click **Withdraw**. One signature. Deposited so far falls by that amount, the
   ETH is back in the wallet. **Withdraw everything** fills the field with the
   full deposit.
10. Type an amount and click **Deposit** directly (no sell). Works; Deposited so
    far and **All deposits** both rise. **Max** fills the usable balance.
11. Disconnect and reload: nothing is remembered as selected.

## B. Mode 3 — external wallet in EOA mode (MetaMask, Coinbase, Rainbow, WalletConnect)

12. The note under the CTA reads **"Your wallet may ask for up to N signatures
    (approve, permit and swap per coin, then the deposit), and you pay the
    gas…"** with N = 3 × routable coins + 1. Not the "One signature" note. The
    receipt shows a **− gas reserve** row (0.0005 ETH) that the smart-account
    modes do not have.
13. When any coin routes through Kyber, the line "{K} of these coins Zora could
    not route; KyberSwap can, and will be used for them." is present.
14. Run "Sell N coins and deposit ≈x ETH". Expect one wallet prompt per coin
    (Permit2 signature + swap) and one more for the deposit. Step rows advance
    one at a time.
15. Reject the second prompt. The rejected coin's row turns ✗, the run continues
    with the rest, and the deposit still happens for the sold ones. The failed
    coins stay selected so retry is one click.
16. Kill the deposit prompt after the sells land: the red note "The sells went
    through but the deposit did not. About x ETH from them is in your wallet;
    deposit it from the terminal below." appears, and the amount is really there.

## C. Mode 2 — external wallet switched to SA mode (the drawer toggle)

17. Switch to wallet mode in the wallet drawer. The Zora coins card is replaced
    by "No migratable Zora coins found in this wallet." plus the line naming the
    admin address and the drawer button to press; the old-$gnars row is gone.
    Expected: the SA holds nothing.
18. The deposit block shows "Wallet: 0 ETH", the note "This smart account holds
    no ETH. Your ETH is in your admin address (0x…); open the wallet menu and
    press "Switch to admin"…", and **Deposit** stays disabled.
19. Having deposited in EOA mode first: **Deposited so far** reads 0 ETH **and**
    the notice "You have X ETH deposited from your other address (0x…)" appears
    with "Switch to admin". Switch back; the deposit reappears.

## D. Mode 4 — Farcaster mini app (open gnars.com/migrate from a cast in Warpcast)

20. The page connects on its own (no Connect modal). No wallet drawer toggle.
21. The note reads "Your wallet may ask for up to N signatures". Run a sell of
    one dust coin: Warpcast prompts per step (permit + swap), then the deposit.

## E. Mode 5 — mobile (phone, PT-BR)

22. **Your migration deposit** is the first card on screen; **What you hold**
    follows below it. No horizontal scrolling at 390px.
23. With anything selected, the primary CTA is also pinned in a sticky bar at the
    bottom of the viewport, and it is the same label as the one in the card.
24. In the deposit field, type 0,05 with the comma keyboard. The field shows
    0.05 and the line above the buttons reads "Você vai enviar: 0.05 ETH".
25. The Zora coins card header wraps without clipping: "Coins da Zora", the hint
    "N de M selecionadas · K sem rota", and the three buttons Selecionar tudo /
    Desmarcar K sem rota / Limpar.

## F. Failure states (any mode)

26. With the RPC blocked (devtools → offline after load), the chip says **Read
    failed** and the deposit block shows "Couldn't read your deposit from the
    contract. Nothing is assumed: your deposit is not shown as zero." with a
    **Retry**. **Deposited so far** and **All deposits** show "—", never "0 ETH".
27. Block the quote service only: the receipt shows "N quotes failed. The quote
    service did not answer; the coins are marked in the list." with **Retry**,
    the matching rows read **Quote failed**, and the CTA is disabled while no
    coin is routable.
28. Break the wallet-balance read: the ETH row and the receipt say "Couldn't
    read", never 0, and Deposit is not blocked by the (unknown) cap.
29. Set `NEXT_PUBLIC_UPGRADER_ADDRESS` to a typo locally: the chip says
    **Misconfigured**, the deposit block shows the reason, and no button is
    enabled.
30. The amber callout under the deposit card is always present: the contract is
    operated by Onchain Inc (kompreni), the owner can halt deposits and move
    tokens out, withdraw is the exit you control, and the Basescan link resolves
    to the UpgraderEth address.
31. PT-BR: every string above in Portuguese, no English leaking, "tesouro" not
    "tesouraria".
