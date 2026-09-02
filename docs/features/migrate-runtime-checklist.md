# /migrate — runtime checklist for the money-moving clicks

What an automated pass cannot do: sign. `scripts/pw-migrate-connected.ts` renders
every connected state with a real holder impersonated read-only (holdings,
quotes, old-$gnars card with impact, sell preview, deposit terminal gated and
live). The steps below move real value and need a human with a wallet. Use a
wallet holding a few dollars of Zora dust and a little old $gnars on Base.

Report each line as ✅ / ❌ with what you saw. Anything ❌ blocks flipping the
terminal on in production.

## A. Mode 1 — in-app wallet (social / email login), pinned to the smart account

1. Connect. Holdings list shows only Zora coins; old $gnars appears in its own
   card above with balance, ETH estimate and **Price impact** as a percentage.
2. Select all. Preview shows "With a route" count, an ETH estimate, and the note
   **"One signature …"** (batch mode).
3. Tick "Sell my old $gnars to ETH along with the coins above". The ETH estimate
   grows; the card's impact number is unchanged.
4. Terminal envs unset (production today): the deposit card says **Opens at
   launch**; the primary button is "Sell N coins to ETH". Click it. One
   signature. Every step row turns ✓. ETH lands in the wallet. Coins are gone.
5. Terminal envs set (staging or local): the card says **Live**, shows "Your
   deposit" and "All deposits" as numbers (not "—"), and "Deposits close: No
   notice given". Primary button is "Sell N coins & deposit". Click it. One
   signature. Steps ✓ including "ETH → migration deposit". "Your deposit" rises
   by roughly the estimate minus the route margin; a small ETH remainder stays in
   the wallet.
6. Type an amount ≤ "Your deposit" and click **Withdraw**. One signature. "Your
   deposit" falls by that amount; the ETH is back in the wallet.
7. Type an amount, click **Deposit** directly (no swap). Works; "Your deposit"
   rises.
8. Disconnect and reload: nothing is remembered as selected.

## B. Mode 3 — external wallet in EOA mode (MetaMask, Coinbase, Rainbow, WalletConnect)

9. Preview note reads **"Your wallet will ask for N signatures …"** with N = coins
   (+1 when the terminal is live). Not the "One signature" note.
10. Run "Sell N coins & deposit" (terminal live). Expect one wallet prompt per
    coin (Permit2 signature + swap, as today) and one more for the deposit. Step
    rows advance one at a time.
11. Reject the second prompt. The rejected coin's row turns ✗, the run continues
    with the rest, and the deposit still happens for the sold ones.

## C. Mode 2 — external wallet switched to SA mode (the drawer toggle)

12. Switch to "Smart account" in the wallet drawer. The holdings list is empty
    (the SA holds no coins) and the old-$gnars card is gone — expected. The
    terminal shows "Wallet: 0 ETH" and Deposit stays disabled.
13. Having deposited in EOA mode first: the terminal shows "Your deposit 0 ETH"
    **and** the notice "You have X ETH deposited from your other address
    (0x…)" with "Switch to Wallet (EOA)". Switch back; the deposit reappears.

## D. Mode 4 — Farcaster mini app (open gnars.com/migrate from a cast in Warpcast)

14. The page connects on its own (no Connect modal). No wallet drawer toggle.
15. Preview note reads "Your wallet will ask for N signatures". Run a sell of
    one dust coin: Warpcast prompts per step (permit + swap), then the deposit.

## E. Mode 5 — mobile (phone, PT-BR)

16. Both tabs show their labels ("Entrar", "Guia"). No horizontal scrolling.
17. In the deposit field, type 0,05 with the comma keyboard. The field shows
    0.05 and the line above the button reads "Você vai enviar: 0.05 ETH".

## F. Failure states (any mode)

18. With the RPC blocked (devtools → offline after load), "Your deposit" shows
    **Read failed** and a Retry button, never "0 ETH".
19. Set `NEXT_PUBLIC_UPGRADER_ADDRESS` to a typo locally: the card says
    **Misconfigured** with the reason, and no button is enabled.
20. PT-BR: every string above in Portuguese, no English leaking, "tesouro" not
    "tesouraria".
