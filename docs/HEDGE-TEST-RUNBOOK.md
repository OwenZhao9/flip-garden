# Hedge test runbook: the first real run (for the owner, not for an AI session)

**Goal:** prove, with real money and a few minutes, that the Hedge tab can create a Perpl account, open a small short on the MON perpetual, show an honest position, close it, and withdraw, and that every number it shows matches the chain. Nothing in this repository's tests has sent a real Perpl transaction; this run is the first real evidence.

**Rules for this run**

- Use a **throwaway wallet or a new passkey account**. Budget: **at least 12 AUSD** (the account needs a 10 AUSD first deposit; the exchange minimum is read live) plus **MON**: about 1 MON for network fees (five transactions cost about 0.025 MON each at today's gas price) and the MON you want to hedge. With the default 50% ratio, holding about **200 MON** gives a 100 MON short, a notional of about 2.5 USD; the smallest possible hedge is 1 MON (about 0.025 USD). Never fund the wallet with more than you can lose; the page's caps are 15 USD of hedge and 15 AUSD deposited.
- **An AI session must not do any step below.** You press every button yourself. Never paste a seed phrase, a key or the passkey's secret anywhere.
- Where to run it: the live page `https://owenzhao9.github.io/flip-garden/#hedge` once the owner has merged and published this phase. A passkey account is bound to the host, so use the same host as for the passkey run.
- Perpl's own web interface blocks several countries (BY, CU, GB, IR, KP, RU, SY, UA, US). This page talks to the contract directly, so that list is not applied, but it was **not checked whether Perpl's terms forbid using the contract from those places**. Do not run this from them.

## What you need first

| Item | How |
|---|---|
| AUSD | With the passkey: Passkey tab, swap USDC to AUSD (see `docs/PASSKEY-TEST-RUNBOOK.md`, steps 5 to 8). With a browser wallet: any way you already have AUSD on Monad mainnet (chain 143). |
| MON | At least about 200 MON for a 100 MON hedge, plus 1 MON for fees. MON at Kuru counts too. |
| Signer | A signed-in passkey session (Passkey tab) or a browser wallet on Monad mainnet. |

## Steps

1. Open `#hedge`. Press **Connect** (for the passkey session it shows "Connect Passkey (Mera)" only while you are signed in on the Passkey tab). **Expected:** "Connected: 0x…" and a card "Your MON and your Perpl account" showing your wallet MON, MON free at Kuru, AUSD in the wallet, "Perpl account: none yet", and the MON price as mark, best bid and best ask (AUSD per MON, today around 0.025).
2. Look at the **Plan a hedge** card. **Expected:** short size = 50% of the hedgeable MON rounded down to whole MON; notional; "Collateral needed at 2x" (about half the notional plus a small fee and buffer); a liquidation price about 45% above the entry (labelled estimate); "Funding at the current rate" per day with the rate and the 43-minute interval; the opening-and-closing estimate (about 0.24% of notional); the risks. Everything labelled "Preview, nothing sent". Try the ratio box: type 100 and then 10 and see the size change; 0 or a hedge below 1 MON says there is nothing to hedge.
3. Press **Open the hedge**. **Expected:** a card "Next transaction", then "Ready" with the statement **"Approve exactly 10 AUSD"** (or the exact first deposit shown in the plan), the exchange address `0x34B6…2a6F`, a network fee of about 0.025 MON and "Simulation passed". Press **Open the wallet pop-up** (browser wallet) or **Sign and send** (passkey). With a wallet, check the pop-up shows an `approve` on AUSD `0x0000…012a`, the exchange as spender and the same amount, **not unlimited**. **Expected after:** the log says "Approved … the AUSD allowance for the Perpl exchange is exactly the approved amount."
4. The page moves on by itself to the next card: **"Create your Perpl account with a 10 AUSD deposit"**, simulation passed and a trace line. Confirm. **Expected:** "Account created … Account N created with exactly 10 AUSD; the wallet AUSD fell by the same amount." Write down the account number.
5. Next card: **"Sell N MON short on Perpl at 2x leverage, immediate-or-cancel, at no worse than P AUSD per MON (1% below the best bid)"**. Check the size and price. Confirm. **Expected:** "Hedge opened … Filled completely: N MON sold short. Average price …, collateral … AUSD (of which … is the extra the exchange locks when the fill is below the mark price), trading fee …". The collateral should be about half of the notional plus that extra. The card **Your hedge** appears with the size, entry price, mark price, profit or loss so far (slightly negative at once: you sold at the bid, under the mark), collateral, liquidation price and a **Close hedge** button.
6. Wait at least a few minutes (a funding event happens every 8,571 blocks, about 43 minutes; you do not have to wait for one, but if you can, wait for one and note the funding figure on close). Press **Refresh** and watch the mark price and the profit or loss move.
7. Press **Close hedge**. **Expected:** a card "Buy back N MON to close your short, immediate-or-cancel, at no worse than P (1% above the best ask)". Confirm. **Expected:** "Hedge closed … Closed: N MON bought back. Price result …, funding … (negative = paid), trading fee …; … AUSD came back to your Perpl account." The price result should be about the spread plus any market move.
8. The page offers the last card: **"Withdraw X AUSD from your Perpl account to your wallet"**. Confirm. **Expected:** "Withdrawn … X AUSD came back to your wallet." The final card says "Closed. No position is open and your Perpl account is empty." Check your wallet AUSD: it should be your starting AUSD minus the total cost (spread, two fees, funding), a few cents on a 2.5 USD hedge.
9. Open every transaction link on the explorer (monadscan). **Expected:** the approve goes to AUSD, the other four go to `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`.
10. Optional checks: (a) after step 5 reload the page, connect again and confirm the card **Your hedge** and the **Close hedge** button come back from the chain; (b) in step 5 press **Cancel** at the announcement and confirm nothing was sent and the button works again; (c) with a browser wallet, press **Reject** in a pop-up and confirm the page says nothing was sent; (d) switch the wallet to another network and confirm the page asks to switch back.

## Things that must NOT happen (stop and report if they do)

- A pop-up or signature request that is not one of the five listed: AUSD approve, create account, one OpenShort order, one CloseShort order, withdraw. A pop-up with a value of MON being sent, an unlimited approval, another spender or another contract.
- A short bigger than the plan, a **long**, a resting order, or leverage above 2x anywhere.
- The log saying **Cannot explain**, or a position, collateral or balance that differs from what the page announced.
- "Close hedge" missing while a position exists, or a position that stays open after a close that said it closed.
- A second pop-up for the same step, or a transaction you did not just ask for.
- The AUSD in the wallet after step 8 being lower than the start by more than the few cents the costs explain.

## What the page does when something goes differently (and what to send back if you see it)

- **"Nothing was filled"**: the price moved beyond the 1% bound between the simulation and the block. No position, no collateral moved; press the button again.
- **"Partly filled: X of N MON"**: the order filled only partly inside the bound. The position is the smaller size; **Close hedge** closes what exists.
- **"The simulation would fill only X of N MON" or "nothing would fill"** before the pop-up: the page refuses to ask you; try again or lower the ratio.
- **Account already exists** from an earlier run with less collateral than the hedge needs: the page says to lower the ratio. It does not top up an account.

## What to send back

Public data only; **never** a key or seed phrase.

- Your address, the Perpl account number, and the five transaction hashes (approve, create, open, close, withdraw).
- The numbers on the cards: the plan (size, notional, collateral needed, liquidation estimate, funding per day, cost estimate), and the result lines of steps 5, 7 and 8 (average price, collateral, extra, fee, price result, funding).
- Screenshots or the exact text of any message that said Stopped, Cannot explain, "simulation failed", "nothing would fill" or "partly".
- Whether you used a browser wallet or the passkey, and the device and browser.
- If you waited through a funding event: the funding figure from step 7.

With these, the result goes into `docs/FINDINGS.md` as the first real verification of the hedge, and the "estimate" labels can be checked against what really happened (fill price against the bid, extra collateral against the mark at that block, fee against 345 per million, the round-trip cost against 0.24%).

## What this run cannot show

Hedges above a few dollars (the book's depth beyond the top levels), a liquidation, how the page behaves while funding changes the position's value over days, withdraw limits for larger amounts, other wallets, and the Kuru flip orders running at the same time (inventory that sits in resting sell orders is not counted).
