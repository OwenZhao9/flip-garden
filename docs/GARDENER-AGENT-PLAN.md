# The Gardener: an AI agent that tends a Flip Garden (design proposal for review)

Status: proposal, nothing built. Written for a reviewer who has not seen the project. Read with `README.md`, `docs/FINDINGS.md` (real-money runs) and `docs/STAGE-D2-BRIEF.md` (the safety boundary).

## 1. The problem the agent solves

Flip Garden lets a user plant a few dollars as Kuru flip orders on Monad (a limit order that, when filled, places the opposite order by itself), hedge the MON it accumulates with a short on Perpl, and read a ledger reconciled against the chain. Today every action is manual: the user previews, confirms each transaction, and has to watch the garden.

Our own real-money round on 2026-10-11 (all in `docs/FINDINGS.md`) showed why a garden needs constant tending:
- A Move re-planted one tick under the best ask; the market moved within about two seconds and Kuru refused the bid.
- A bid filled in the very next block; the flipped sell then sat waiting, and whether to keep, move or prune it was left to a human who was not watching.
- A hedge close ran out of gas because the order book changed between estimate and inclusion.

Blocks are about 0.4 s. A person cannot react at that pace; a garden left alone drifts away from the market. The agent is the gardener the product is missing. Whether users want an autonomous gardener has not been tested; this is the design hypothesis.

## 2. Why Jev (TypeSafe AI) is the right model here

Jev returns typed decisions from a fixed set of options with a calibrated probability per option, in about 70 to 500 ms, at a very low price (vendor figures from typesafe.ai, read 2026-10-12; not independently verified). Three properties map directly onto this product:
1. Tending questions are multiple-choice ("keep, move up one tick, move down one tick, prune"), not free text.
2. A calibrated confidence gives a principled rule for **when the agent may act alone and when it must ask the user** — the same preview-and-confirm card the product already has.
3. Jev outputs categories, never numbers. Exact prices and sizes stay computed by our code from the live order book, so every number remains chain-derived and reconcilable.

## 3. Architecture

```
browser (signed-in passkey session or wallet)            Cloudflare Worker (existing account)
 ├─ observe: book, orders, balances, hedge (read-only RPC) ─┐
 ├─ build a compact state snapshot (code)                   │
 ├─ ask: POST /decide {question, state, options} ──────────►├─ holds the Jev API key as a secret
 │                                                          ├─ calls Jev, validates the typed answer
 │◄──────────────── {choice, probabilities, confidence} ────┤  rate limit, no logging of wallet data beyond the address
 ├─ policy (code): mandate check + confidence threshold
 ├─ act: plan the exact transaction (code), guardTx, simulate, sendStep, verify on chain
 └─ log: action, reason, confidence, tx hash → ledger "Gardener" timeline
```

- The model only chooses among options. The **policy** (deterministic code) decides whether a choice becomes a transaction. The existing **guard** (allow-list, exact approvals, hard caps) and **sendStep** (simulate, verify post-conditions) stay the last gate, unchanged.
- The Jev key never reaches the browser. The Worker adds one endpoint; it holds no wallet key and sends no transaction.

## 4. The decisions (typed questions)

Each runs on a timer (every few blocks) and on events (a fill, a flip, a large book move). Options are fixed enums.

| Question | Options | Inputs (state) |
|---|---|---|
| Q1 Tend a resting order | keep, requote_closer, requote_further, prune | its price vs best bid/ask in ticks, age in blocks, recent mid-price path, fill progress, inventory share |
| Q2 Plant a new level | none, plant_near_bid, plant_mid_gap | free USDC at Kuru, open levels, spread, recent volatility bucket |
| Q3 Inventory / hedge | hold, hedge_up, hedge_down, close_hedge | MON inventory, current short, funding rate sign, mark vs entry, margin headroom |
| Q4 Idle money | leave, harvest | free balances, time since last fill |
| Q5 Situation check (gate for all others) | normal, trending_up, trending_down, illiquid, pause | book depth, spread, last N mid prices |

Code turns each choice into exact parameters (for example `requote_closer` = best bid + 1 tick, never crossing the ask by construction, re-read just before sending). A `pause` from Q5 or a stale snapshot stops all actions.

## 5. The mandate (what the user authorises once)

Autonomous actions require one explicit, signed-off mandate shown as a single card:
- total budget in USDC and AUSD (within the existing caps: 15 USDC per planting/deposit, 15 USD hedge notional, 15 AUSD Perpl deposit);
- allowed action kinds (for example tend and harvest only; planting new money and hedging optional);
- confidence thresholds per question (default: act alone at ≥ 0.85, ask the user between 0.6 and 0.85, do nothing below 0.6);
- a maximum number of transactions per hour and a maximum network fee per hour;
- an expiry (default 24 hours) and a visible **Stop** button that halts everything immediately.

Anything outside the mandate becomes a normal confirmation card, exactly as today. The mandate and the running totals are shown on the page; nothing about it is stored outside the browser.

This changes the product principle from "the user confirms every transaction" to "the user confirms a bounded mandate; inside it the gardener acts, outside it the user confirms". That change is the owner's decision.

## 6. Where the agent runs (a real constraint)

The passkey key exists only in memory while the user is signed in, and a browser wallet signs only while the page is open. So in this design **the gardener works only while the page is open and signed in**. Running 24/7 would need delegated, on-chain-limited signing (for example a smart-account session key with spending limits) or a server holding a key; both are outside this proposal and would need their own safety review.

## 7. What the user sees

- A "Gardener" switch with the mandate card, a status line (watching / acting / waiting for you / paused), the remaining budget and the next check time.
- A timeline in the ledger: each action with the question, the chosen option, the confidence, the exact transaction, and its on-chain verification.
- Low-confidence choices appear as the existing confirmation card, labelled as the gardener's suggestion.
- The game layer reacts as now (growth, celebrations); the gardener is the character tending the plots.

## 8. Failure handling

- Jev unreachable, slow (> 2 s), or answer fails validation: no action, retry on the next tick, status shows it.
- Market moved between decision and send: the existing book re-check refuses; the gardener re-asks next tick.
- Transaction reverted or out of gas: logged; the gardener backs off that action kind for a cool-down; repeated failures pause it.
- Mandate exhausted or expired: stop and tell the user.
- Tab hidden or session locked: stop (already the passkey rule).

## 9. Costs

Model calls: a few questions every few seconds while the page is open; at the vendor's price the model cost is expected to be small compared with network fees, to be measured. Network fees: each autonomous transaction costs about 0.02–0.05 MON at today's gas; the per-hour fee cap bounds it.

## 10. Testing

- Unit tests: the policy (mandate, thresholds, caps, cool-downs) as pure functions; every model answer type, including malformed ones.
- Fake chain + fake Jev (scripted probabilities) for whole tending sessions: drift, trend, sudden fill, revert, Jev down.
- Replay tests on recorded real data (the 2026-10-10 and 2026-10-11 fixtures): what would the gardener have decided at each block.
- One small real-money round with a mandate of a few dollars, then a write-up in `docs/FINDINGS.md`.

## 11. Open questions for the reviewer

1. Is "act alone above a confidence threshold, ask below it" a sound way to bound an autonomous trading agent, or should the bound be purely the mandate?
2. Are the five questions the right decomposition, or should Q5 (situation) feed the others as an input instead of being a gate?
3. Is "works only while the page is open" acceptable for a first version, or does an agent that sleeps when the tab closes defeat the purpose?
4. What would make the integration feel forced to a judge rather than necessary?
5. Jev API specifics (request format, limits, latency from Asia, terms for trading use) still have to be read from docs.typesafe.ai before building.
