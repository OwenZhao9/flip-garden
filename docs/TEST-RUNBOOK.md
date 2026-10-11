# Combined test runbook: one real-money round for everything not yet verified (for the owner, not for an AI session)

**Status: not run yet.** One session, one throwaway passkey account, one funding, in an order that reuses what each step leaves behind. It replaces running [`PASSKEY-TEST-RUNBOOK.md`](PASSKEY-TEST-RUNBOOK.md), [`HEDGE-TEST-RUNBOOK.md`](HEDGE-TEST-RUNBOOK.md) and the garden actions separately; each of those still has the detailed expectations for its own steps and is referenced below by step number. The planting flow itself was already verified once with MetaMask (see `docs/FINDINGS.md`); here it is run again through the passkey signer.

## What this round verifies

| # | Feature | Verified before? |
|---|---|---|
| 1 | Passkey sign-in, lock, idle lock, reload (desktop Chrome) | No |
| 2 | USDC to AUSD swap through Kuru Flow | Simulated only |
| 3 | Planting through the passkey signer | MetaMask only |
| 4 | Garden actions: Prune, Harvest, Move | Fake chain only |
| 5 | Leaderboard: join from the page, the scan, the ranking | Fake chain and fake KV only |
| 6 | Perpl hedge: open, close, withdraw | Simulated only |
| 7 | Unwind and a clean ledger at the end | MetaMask only |
| 8 | (second, small round on the iPhone, after publishing) | No |

## Rules for this round

- **An AI session never does any step below.** You press every button. Never paste a seed phrase, key or passkey secret anywhere; the page never shows one.
- One **new, throwaway passkey account**. Never fund it with more than the budget below. Everything the page spends is capped in code (15 USDC per deposit and per planting, 3 orders, 15 USD of hedge, 15 AUSD deposited).
- Run it from the **local build**, on desktop Chrome: `http://localhost:8788/` (the main session serves `web/dist/`; to serve it yourself: `cd web && npm run build && cd dist && python3 -m http.server 8788`). A passkey account is bound to the host, so this account exists only on `localhost`; the live page gets a different account (step 8 covers that).
- Desktop Chrome needs Google Password Manager as the passkey provider (your Chrome is signed in to Google; if the page says it cannot derive a secret from the passkey, stop and report).
- Network: **Monad mainnet, chain id 143** for every transfer. A transfer on the wrong network is lost.

## Budget (fund once)

| What | Amount | Used for |
|---|---|---|
| USDC | **20** | 12 swapped to AUSD (Perpl needs a 10 AUSD deposit plus a buffer), about 6 for one planted level, the rest as slack |
| MON | **205** | about 200 to hedge (50% of 200 is a 100 MON short, about 2.5 USD of notional), about 3 for network fees (around 20 transactions at roughly 0.025 MON each) |

Expected cost of the whole round: network fees (a few cents of MON), trading fees and spread on the hedge (about 0.24% of a 2.5 USD hedge), funding on it for the minutes it is open, and any small mark-to-market change on the planted bid. Everything else comes back when you unwind and withdraw. If you already hold MON in another test wallet, send it from there; the page does not bridge.

## Part A: sign in and fund

1. Open `http://localhost:8788/#passkey`. Press **Create passkey** and confirm (one or two prompts, see `PASSKEY-TEST-RUNBOOK.md` step 2). **Expected:** the green bar "Signed in with a passkey as 0x…", balances 0. Copy the address.
2. From your own wallet or an exchange, send **20 USDC and 205 MON** to that address on chain 143. Press **Refresh balances** until they show.

## Part B: swap USDC to AUSD (passkey runbook steps 5 to 8)

3. In the swap card enter **12** USDC and press **Preview the swap**. **Expected:** you pay exactly 12 USDC and receive about 11.9x AUSD, never less than the stated minimum; router `0xb3e6…13cb`.
4. Start, then **Sign and send** twice (approve exactly 12 USDC, then the swap). **Expected:** no system pop-up on these; after each, the log verifies it from the chain; Balances show about 8 USDC and about 11.9 AUSD. Open both transaction links on the explorer.

## Part C: plant through the passkey signer, and the garden actions

5. Open `#plant`. Press **Connect Passkey (Mera)**. Plan: budget **6**, one level, "Right under the best ask". Press **Plant these orders**. **Expected:** three cards (approve exactly the amount, deposit, place the bid), each with a simulation line, each signed with **Sign and send** and no system pop-up; after each the log verifies the chain. Then the **Planted** card.
6. The garden panel on the same page: the new plot should show as a seed (resting), with the level and achievements ("first planting" earned, others locked). Press **Refresh** or wait; the "last read" time should advance by itself.
7. **Move** (the plot's Move button): pick a new price from the current book. **Expected:** two steps, each with its own simulation and confirmation: cancel the order, then plant a new bid at the chosen price. The plot afterwards shows the new order; the old one shows as pruned.
8. **Prune**: select the live order and press **Prune selected**. **Expected:** one cancel; the plot shows a cut stem. **Harvest free money**: **expected:** one withdrawal of what is free at Kuru, the page saying plainly that this returns free money and not profit. Afterwards the USDC is back in the wallet.
9. Plant again (budget 6, one level) for the rest of the round, so there is something to fill and something to unwind. If a fill happens, note the order ids; the ledger shows the flipped sell, and a flip back into a buy would be the first real completed round trip (the "fruit" stage; every label that depends on it says "not yet seen on real data").

## Part D: leaderboard

10. On the **Planted** card press **Join the leaderboard** (it opens `#board` with your address and start block filled in). Press **Join**. **Expected:** "Registered." Press **Check my status**. **Expected:** registered; either "still reading the chain" or your first figures. Reload `#board` after a few minutes: your row should appear (round trips probably 0, level Seed, age 0 days). The service scans every five minutes in small batches, so a start block from a few minutes ago is read quickly.
11. Open `https://flip-garden-leaderboard.photogif.workers.dev/leaderboard` in a tab. **Expected:** JSON containing, once scanned, your address shortened as `0x1234…abcd`, never in full.

## Part E: the hedge (hedge runbook steps 1 to 9)

12. Open `#hedge` and press **Connect Passkey (Mera)**. **Expected:** wallet MON about 205 (less what Kuru holds in orders is shown separately), AUSD about 11.9, "Perpl account: none yet".
13. Keep the default ratio (50%). Check the plan card against the hedge runbook step 2 (size about 100 MON, notional about 2.5 USD, collateral at 2x about half of that plus a small extra, funding per day, round-trip cost about 0.24%, the risks).
14. Press **Open the hedge** and confirm five transactions with **Sign and send**: approve exactly 10 AUSD (or the exact figure shown), create the account with the deposit, open the short (immediate-or-cancel, at most 1% below the best bid), later close it, then withdraw. Compare every result line with the hedge runbook (steps 3 to 8). Wait a few minutes between opening and closing and watch the profit or loss move.
15. After the withdrawal the final card says "Closed. No position is open and your Perpl account is empty."

## Part F: unwind and the final check

16. Open `#plant` and press **Unwind: cancel all and withdraw**. Expect up to two transactions (cancel live orders, withdraw). The final card says *Unwound*.
17. Open the ledger for the wallet (the link on the planting page). **Expected:** every reconciliation row shows difference 0, no order is left resting, and the garden panel's achievements match what you did (first planting, first prune, first harvest; "first fill" only if one happened).
18. Passkey checks (`PASSKEY-TEST-RUNBOOK.md` steps 9, 11, 12): press **Lock** and sign in again (same address); reload (you are signed out); sign in and leave the page idle for 5 minutes (it locks by itself).

## Things that must NOT happen (stop and report if they do)

- Any system prompt other than the passkey prompts at create and sign-in; a prompt at **Sign and send** is not expected.
- A transaction other than the ones listed here, an approval that is not the exact amount, a spender other than the Flow router `0xb3e6…13cb`, the Kuru margin account `0x2A68…90c5` or the Perpl exchange `0x34B6…2a6F`, or any transfer of MON out of the account.
- A long position, a resting Perpl order, or leverage above 2x.
- The log saying **Cannot explain** at any step, a ledger badge *Does not match*, or a position, collateral or balance that differs from what the page announced.
- The page showing a seed phrase, private key or passkey secret, or storing one (desktop: the browser's Application tab should hold only the ledger cache and a planting note).
- The leaderboard showing your address in full, asking for a signature, or listing a number you cannot reproduce from the ledger.

If anything stops, do not press the same button again and again. Reloading half-way is safe (each page works out its next step from the chain); take a screenshot and report.

## What to send back

Public data only; **never** a key or seed phrase.

- The passkey account address, the Perpl account number and every transaction hash (the pages list them as links), in order.
- Screenshots or the exact text of any message that said Stopped, Cannot explain, "cannot derive a secret", "simulation failed", "nothing would fill" or "partly".
- The plan and result lines of the hedge (size, notional, collateral, liquidation estimate, funding per day, average price, fee, price result, funding).
- Whether a fill happened and the order ids; if a flipped sell filled and flipped back into a buy, say so: that is the first real completed round trip.
- What the leaderboard showed and how long it took to appear.
- The device, OS and browser.

The results go into `docs/FINDINGS.md`, and the "unverified" labels are then updated one by one for what was actually seen.

## Step 8: a short second round on the iPhone (after the page is published)

Only after the owner has approved publishing. An iPhone cannot reach `localhost`, and the account on the live host is a new one. Needs iOS 18 or later with iCloud Keychain on. Fund the new account with about 1 USDC and 0.2 MON (nothing more).

1. Open `https://owenzhao9.github.io/flip-garden/#passkey` in Safari, create the passkey, sign in. **Expected:** the same flow as step 1, one or two prompts, a signed-in bar with an address.
2. Optionally swap 1 USDC to AUSD (steps 3 and 4 with 1 instead of 12), then **Lock**, sign in again (same address), reload (signed out).
3. Open `#board`, enter that address and a recent start block, and press **Join**.

Report the device, iOS version, browser, the address and anything unexpected.

## What this round cannot show

Hedges above a few dollars, a liquidation, funding over days, other passkey providers and browsers, other wallets, non-zero Kuru fees, and the leaderboard's behaviour with many wallets or a start block far in the past (the free Cloudflare plan's 10 ms CPU limit is not yet checked under load).
