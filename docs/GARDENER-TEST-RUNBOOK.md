# First real round of the Gardener

This is how the owner (not an AI session) runs the Gardener once with real money: a mandate of **at most 5 USD for 1 hour**, with the rules-only Gardener, on the same throwaway passkey account as the 2026-10-11 round. Before this round the Gardener has run only against the fake wallet, the fake chain and the recorded market data (`docs/FINDINGS.md`, "The Gardener").

## Know before you start

- The Gardener signs with the **passkey session**, so it works only on the Plant page while the passkey session is signed in and the tab stays visible. Hiding the tab, switching apps, locking the session or the idle lock all stop it. Keep the Mac awake and the tab in front for the hour.
- **The idle lock.** Normally the passkey session locks after 5 minutes without a signed transaction. While a mandate runs (and the tab is in front), each Gardener check restarts that clock, so the hour is not cut short in a quiet market. When the mandate expires or you press Stop, the normal 5-minute lock applies again.
- One planting needs at least 200 MON of size, about 5.1 USDC at today's price. A 5 USDC mandate therefore lets the Gardener tend **one** bid of about 195 to 200 MON only if the price is under 0.025; above that, plant about 5.2 USDC yourself and set the Gardener's USDC limit to 5.2 (still about 5 USD). The Gardener never deposits: it only works with money already at Kuru.
- Network fees: each Gardener transaction costs about 0.02 to 0.04 MON. Keep at least 1 MON in the wallet; the default mandate allows at most 0.5 MON of fees and 12 transactions per hour.
- Run it on the local build in **Safari** (desktop Chrome on this Mac cannot use the passkey, see `docs/FINDINGS.md`):

```text
cd /Users/owenzhao/Projects/flip-garden/web
npm run build
cd dist && python3 -m http.server 8080
```

  then open `http://localhost:8080/#passkey` in Safari. The passkey is bound to the host name, so use `localhost` as in the 2026-10-11 round, not `127.0.0.1`.

## Steps and what to expect

1. **Passkey tab**: Sign in with the existing passkey. The address must be `0xdEbE9fCBc6A14963f555c63045ec8885D5f619EA` (the 2026-10-11 account) or a new throwaway one. Check that it holds about 5.2 USDC and at least 1 MON.
2. **Plant tab**: connect "Passkey session". Plant one level with a budget of about 5.2 USDC and **"Just above the best bid"** (the placement the Gardener also uses). Sign the approve, deposit and plant steps as before; each is verified.
3. A **Gardener** card appears under the garden. Press **Set up the Gardener**. Set:
   - USDC it may keep locked in bids: `5.2` (or `5` if one 200 MON bid fits);
   - AUSD it may commit to a hedge: `0`, and leave **Keep the Perpl short inside the hedge range** unticked (the hedge is not part of this round);
   - leave the price range (5% either side of today's price), the 0.2% re-place distance, 1 hour, 12 transactions and 0.5 MON per hour as proposed;
   - allowed actions: re-place, plant again, harvest, refuel (the defaults).
4. Press **Review the mandate**. Read the card: every limit is listed, decisions say "fixed rules (no AI model)". Press **Start the Gardener**. The status shows **Watching**.
5. Leave the tab in front. What may happen in the hour, each written to the timeline with its transaction link and the check against the chain:
   - The market moves up more than 0.2%: **Tend a bid · requote**: a cancel, then a new bid one tick above the best bid sized to the freed money. Two transactions, no button press.
   - A re-planted bid fails on chain (the race seen on 2026-10-11): the timeline shows the failed plant with its fee; within seconds **Recover · replant** plants the free money again. After a failure the same kind of action waits 30 s, then 60 s; three failures within ten minutes stop the Gardener.
   - The bid fills: Kuru flips it into a sell by itself; the Gardener leaves sells alone.
   - Nothing happens for a long time: that is normal in a quiet market.
6. After the hour the status shows **Stopped: the mandate has expired**. Or press **Stop the Gardener** earlier; nothing more is sent after Stop.
7. Unwind as usual (Plant tab, **Unwind**), or keep the garden.
8. Open the ledger for the account: the reconciliation must still show difference 0, and the **Gardener timeline** card lists every decision.

## Things that must NOT happen (stop and report if they do)

- Any transaction the timeline does not list, or one to another contract than Kuru's market and margin account.
- An approval or a deposit by the Gardener (it never makes either).
- A bid outside the price range on the mandate card, or more USDC locked in bids than the limit.
- Any transaction after Stop, after the tab was hidden or after the session locked.
- **Cannot explain** in the timeline or a ledger that does not reconcile.

## What to send back

Public data only; never a key or seed phrase.

- The account address and the start block shown on the Planted card.
- The transaction hashes from the Gardener timeline (or a screenshot of it), and when you started and stopped it.
- Anything that looked wrong, with the time it happened.
