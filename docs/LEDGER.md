# Flip Garden ledger core

The ledger turns a wallet's Kuru events into numbers a user can trust as money: balances (free / locked), orders and their flip chains, fills, fees, gas, realized and unrealized PnL, position growth and inventory imbalance. It then proves those numbers against the chain: **computed PnL = balance change on chain**, to the raw unit.

Code: `src/` (TypeScript, run directly by Node ≥ 22.18 through type stripping; no build step, no new dependencies). Tests: `npm test` (`node --test`).

| File | Role | I/O |
|---|---|---|
| `src/units.ts` | market units, conversions, rounding | none |
| `src/rational.ts` | exact BigInt rationals for PnL | none |
| `src/keccak.ts`, `src/events.ts` | event topics and ABI decoding | none |
| `src/ledger.ts` | orders, flip chains, fills, flows, balances, issues | none |
| `src/pnl.ts` | cycles, realized / unrealized PnL, growth, imbalance | none |
| `src/reconcile.ts` | invariant checks against chain state | none |
| `src/scan.ts` | incremental, resumable log scanning (planner + merge) | via `LogSource` |
| `src/rpc.ts` | thin read-only JSON-RPC adapter (`fetch`) | read-only RPC |

## Units

Read from `getMarketParams()`; nothing is hard-wired to MON-USDC.

- order price: `pricePrecision` units of quote per one whole base unit (MON-USDC: 1e8)
- order size: `sizePrecision` units of base (MON-USDC: 1e10)
- event price (`Trade.price`, `bestBidAsk()`): 1e18-scaled; must convert exactly to an order price, otherwise `TRADE_PRICE_NOT_ON_GRID`
- token amounts: raw, at the token's decimals; native token = zero address

`quote = size × price × 10^quoteDecimals / (sizePrecision × pricePrecision)`, `base = size × 10^baseDecimals / sizePrecision`.

## Rounding rule

When a conversion is not exact: **what the user receives rounds down; what the user pays or locks rounds up.** Fees round up (taken from what is received).

The contract's own rounding for inexact amounts is **unverified** (every real amount observed so far was either exact or produced by the contract itself). So every inexact conversion that touches the user's balance — a fill's base or quote amount, a fee, a lock taken or released — adds one raw unit to that token's *rounding budget*. Reconciliation accepts a difference up to the budget and no more. With nothing inexact the budget is 0 and the difference must be exactly 0 (the real gate test is such a case).

## Data model

- **Order**: market, id, side, price, flip price, origin (`placed` = FlipOrderCreated, `flipped` = FlippedOrderCreated, `opening` = supplied opening state, `unseen` = first seen through a fill), parent (the order and fill that created it), children, initial size (grows with FlipOrderUpdated), remaining, status (open / filled / cancelled).
- **Fill**: our order filled as maker: our side, size, price, base and quote amounts (with exactness), fee, taker and `txOrigin` (the real counterparty for profiling), the orders it flipped into.
- **Flow**: every signed change of the Kuru account per token (opening, deposit, withdrawal, fill, fee) and of the wallet (gas), with block and log index — so any balance or delta can be computed for any block range.
- **Balances** per token: `equity = opening + deposits − withdrawals + fill proceeds − fill payments − fees`; `locked` = what open orders reserve (bid: quote for the remaining size, rounded up; ask: base); `free = equity − locked`.
- **Issues**: structured findings `{code, severity, en, market, orderId, tx, block, data}` ready for display. Severity `error` = something contradicts the chain or itself; `unknown` = behaviour not observed on-chain, numbers that depend on it are marked; `warn` = incomplete history; `info`.

Gas: Monad bills `gasLimit × effectiveGasPrice` (verified: receipt `gasUsed` equals `gasLimit`), paid from the wallet in the native token. It is not part of Kuru equity; it enters the whole-wallet check and PnL views.

## Event semantics

Verified on Monad mainnet (see `docs/FINDINGS.md` for evidence and dates):

1. `Trade.isBuy` is the **taker's** side. Our side as maker is the opposite. The ledger takes our side from the order's own creation event and flags `TRADE_SIDE_MISMATCH` if the two disagree.
2. `Trade.updatedSize` is the maker order's remaining size after the fill (checked against `remaining − filledSize`).
3. A **full** fill of a flip order logs `FlippedOrderCreated` (new order id, `flippedId = 0`, opposite side, price = parent's flip price, flip price = parent's price) **immediately before** its `Trade`.
4. A **partial** fill logs `FlippedOrderCreated` with `flippedId = parent id`. Each later fill of the same parent (partial or final) logs `FlipOrderUpdated(child, newTotalSize)` immediately before its `Trade` instead of creating another order.
5. Flipped size: a bid fill flips out the filled size (1 case: the gate test); an ask fill flips out `floor(filled × price / flipPrice)` — all quote proceeds go back into the bid, so the position grows each round (exact in all 121 ask fills of the second sample, including 5 partial fills; fees 0 in both markets). Any other size raises `FLIP_SIZE_UNEXPECTED` and the event's size is used.
6. `FlipOrdersCanceled(orderIds, owner)` releases each order's remaining lock to free margin.
7. `Deposit` / `Withdrawal` (MarginAccount) move value between wallet and Kuru; `batchWithdrawMaxTokens` logs one `Withdrawal` per token.

Linking a flipped order to its parent: by `flippedId` when non-zero, else the first matching fill of ours after it in the same transaction (opposite side, swapped prices). An order seen only through its fill learns its flip price from the order it flipped into.

## PnL

All PnL is computed with exact rationals and rounded once at the end (toward negative infinity: a gain is never overstated).

- **Lots**: each fill opens a lot (long for a buy, short for a sell) of the base it moved, with its quote cost or proceeds.
- **Cycle ("one round")**: a buy matched with a sell. A fill first closes the lot of the fill its order was flipped out of (the flip chain, `viaFlip = true`), then the oldest opposite lots (FIFO). `gross = sell quote − buy quote` for the matched base.
- **Realized** = Σ cycle gross. **Fees** are reported per token and valued at mid.
- **Unrealized**, two marks:
  - *mid* = (best bid + best ask) / 2;
  - *executable* = closing now: long lots sell into the bids, short lots buy from the asks. With depth levels given it walks them (and returns null if depth is insufficient); with only the best bid / ask it says "depth ignored".
- **Total(mark)** = realized + unrealized(mark) − fees(mark). Identity (tested): total = Σ quote flows + Σ base flows × mark − fees.
- **Position growth**: holdings change from trading (base, quote, net of fees); net result at mid = total(mid) − gas (gas valued at mid when gas is the base token); growth in bps on capital, where capital = the peak of net deposits valued at mid (deposit 6, withdraw 6, deposit 6 = 6, not 12 or 0).
- **Inventory imbalance**: account equity per token valued at mid; base share in bps (0 = all quote, 10000 = all base) and imbalance = 2 × share − 10000 (−10000 … +10000). Kuru margin is shared across markets, so with several markets on one token these mix.

PnL here is *trading* PnL relative to holding what was deposited: bought base keeps being marked even after it is withdrawn to the wallet.

## Reconciliation

`reconcile(ledger, chainState, baseline?)` returns `{ok, diffs, blocking, unknowns}`; each diff has `check, ok, token/orderId, expected, actual, diff, tolerance, en, hints`.

| Check | Ledger | Chain |
|---|---|---|
| `ORDER_SIZE` | remaining size of every known order | `s_orders(id).size` (0 once gone) |
| `EQUITY` | equity per token | free margin + locked (from order sizes) |
| `FREE` | free per token (only when every open size is known) | `MarginAccount.getBalance` |
| `WALLET` | Δ(fills − fees − gas) between two blocks | Δ(wallet + margin + locked) |

`hints` name likely causes when a check fails: `trade-side-reversed` (the difference is exactly −2× the fill flows), `scan-range-too-short`, `missing-event`, `other-market-same-token`, `external-transfer`, `gas-model`, `fee-model-unverified`, `free-locked-split`.

## Scanning

`sync(state, source)` scans `[nextBlock, head − confirmations]` in windows of at most 90 blocks (the public RPC rejects ranges above about 100), merges logs keyed by `(tx, logIndex)` and advances the cursor only after a window is merged — so it is resumable after a crash and idempotent on re-scan. The state is plain JSON (raw logs), meant to be saved to disk. Only logs that concern the account are kept. Gas: `candidateOwnTxs` lists the account's own transactions found through events; ERC-20 `approve` transactions have no Kuru event and must be added by the caller (they matter only for the whole-wallet check).

```ts
import { JsonRpc, newScanState, sync, eventsOf, candidateOwnTxs, buildLedger, reconcile, marketPnl } from './src/index.ts';
const rpc = new JsonRpc('https://rpc.monad.xyz');
const m = await rpc.marketParams(MARKET);
const st = newScanState({ account, markets: [MARKET], marginAccount, startBlock });
await sync(st, rpc);
const L = buildLedger({ account, markets: [m], events: eventsOf(st), txs: await rpc.ownTxs(account, candidateOwnTxs(st)) });
const report = reconcile(L, await rpc.chainState({ account, marginAccount, markets: [m], orderIds: [...L.orders.values()].map((o) => ({ market: o.market, id: o.id })), block: st.nextBlock - 1 }));
const pnl = marketPnl(L, MARKET, await rpc.bestBidAsk(m));
```

## Tests

- `test/ledger-fixture.test.ts`: the real 2026-10-10 gate test decoded from raw log bytes; free / locked equal the chain at all six snapshots; whole-wallet change equals fills − fees − gas; PnL and growth; **negative**: reading `Trade.isBuy` as the maker side is caught and fails reconciliation with the `trade-side-reversed` hint; idempotence.
- `test/ledger-partial.test.ts`: real partial fills of another account (market `0x52ce…74ce`): `flippedId` links, `FlipOrderUpdated` as new total, flipped sizes exactly as the rule.
- `test/differential.test.ts`: a reference chain (`test/helpers/sim.ts`, written independently of `src/`) runs random place / partial fill / full fill / flip / cancel / deposit / withdraw sequences on 400+ random markets (precisions, decimals, native or ERC-20 base, maker fees up to 250 bps) with adversarial rounding (each inexact conversion rounds up or down at random). After every step the ledger is rebuilt and must match the chain's real balances and PnL within its rounding budget; with nothing inexact the difference is exactly 0.
- `test/units-precision.test.ts`: rounding directions, exactness flags, fees, a 2-decimal / 8-decimal market with a 30 bps fee.
- `test/scan.test.ts`: window size, resume after failure, idempotence, JSON round trip.
- Live (read-only, not in `npm test`): scanning the gate-test range from mainnet with a resume, then reconciling against chain state read at blocks 112210404 and 112211503: every difference 0.

Type checking: there is no TypeScript compiler in the project (no new dependency was added); Node strips types and runs the code, and the tests exercise it. Running `tsc --noEmit` would need `typescript` installed.

## Unknowns (reported, never guessed)

| Unknown | How the code behaves |
|---|---|
| Maker / taker fee mechanics when non-zero (every market seen reads 0 bps) | Assumed: fee on the received token, rounded up. Flagged `fee-model-unverified` in hints; flipped sizes come from events. |
| Contract rounding on inexact amounts | Rounding budget, one raw unit per inexact conversion. |
| `FlipOrderUpdated` not followed by a fill of its parent, or on a closed child | Remaining size becomes unknown (`FLIP_ORDER_UPDATED`, unknown); `FREE` check skipped; `EQUITY`, `WALLET` and PnL still exact. |
| A fill of a flip order with no flipped order in the tx (e.g. a dust fill, a flip below the minimum size) | `FLIP_MISSING` / `PARTIAL_FILL_NO_FLIP` (unknown); proceeds counted in equity, assumed free. |
| Flipped size with non-zero fees | Event size used; `FLIP_SIZE_UNEXPECTED` (unknown) if it differs from the fee-free rule. |
| Our own taker trades (the account as taker) | Not modelled; Flip Garden only provides liquidity. |
| Reorg depth on Monad | `confirmations` default 2 is a choice, not a verified fact. |
