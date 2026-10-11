# Stage C: the ledger core (brief for an Opus 5.5 session)

*Status: completed on 2026-10-11 and merged; kept as a record of the task.*

## Goal in one sentence

Write the **ledger core** of Flip Garden: given a wallet's on-chain data on one Kuru market, produce trustworthy balances (free and locked), orders (including flip chains), fills, fees, profit and loss (losses included) and position growth, and prove that "computed profit and loss equals the on-chain balance change".

## Why this part must not be wrong

The ledger is the product's promise to the user: every number it shows will be treated as real money. One wrong digit misleads the user. So: all arithmetic on integers (BigInt), no floating point; every rule has a test; uncertain semantics are marked unknown, never guessed.

## Existing assets (read first, do not rebuild)

- `docs/FINDINGS.md`: verified facts and open questions (required reading).
- `lib/units.cjs`, `lib/reconcile.cjs`: unit conversion, the price ladder and the reconciliation algorithm, with tests.
- `scripts/gate.cjs`: the command-line tool of the real-funds test; the reference implementation for event scanning and state reads. It is still used for testing; do not break it.
- `test/fixtures/gate-test-2026-10-10.json`: **real mainnet data** (5 transactions, 4 events, 6 balance snapshots). It reconciles with a difference of 0; `test/fixture.test.cjs` shows how to use it. Your ledger must reproduce the same result.
- `config/kuru.mainnet.json`: contract addresses and hard caps.

## Verified facts (summary; details in FINDINGS)

- Price precision 1e8, size precision 1e10, tick 100; USDC has 6 decimals, MON 18 (native, zero address); minimum order 200 MON; maker and taker fees read 0 bps.
- `Trade.isBuy` is the **taker's direction**: when our resting bid is hit by a seller, `isBuy` is false. `Trade.price` has 1e18 precision, prices inside orders 1e8.
- Flip: when a bid fills completely, `FlippedOrderCreated` appears in the same block with a **new order id**, size equal to the filled size, and its own flip price equal to the original bid price.
- Flip orders are cancelled with `batchCancelFlipOrders`; the event is `FlipOrdersCanceled`.
- Monad charges the gas limit: receipts report `gasUsed` equal to `gasLimit`, and the wallet's MON fell by the sum of `gasLimit x effectiveGasPrice`.
- Net worth = wallet + free margin + locked in orders. Depositing, withdrawing, placing and cancelling only move value between those three buckets; net worth changes only through fills, fees and gas.

## Deliverables

1. `src/` (TypeScript, mostly pure functions, no I/O; RPC reads in a thin adapter):
   - **Units and precision:** generic, never hard-coded to MON-USDC; explicit rounding rules (who rounds up, who rounds down), documented.
   - **Event decoding:** `Trade`, `FlipOrderCreated`, `FlippedOrderCreated`, `FlipOrderUpdated`, `FlipOrdersCanceled` (`OrderCreated` can be ignored).
   - **Order chains:** creation, fill, new-id opposite order, cancel; support one order filled in several partial fills.
   - **Ledger:** free and locked balances, open orders, fills, fees (gas by limit; maker and taker fees from the market parameters), realized profit and loss (per round trip), unrealized profit and loss (state the basis: one at the mid price and one at the immediately executable price), position growth, inventory imbalance.
   - **Reconciliation:** invariant checks that output structured differences and reasons, ready for a UI; extend `lib/reconcile.cjs` to several fills, partial fills and several orders.
   - **Incremental scanning** (last): at most 90 blocks per `eth_getLogs` call; resumable and idempotent.
2. Tests (prefer `node --test`, no new dependencies):
   - Reproduce a reconciliation difference of 0 from the real-data fixture.
   - **Randomized differential tests:** a minimal reference simulator generates many random place, partial fill, full fill, flip, cancel and withdraw sequences; assert the ledger agrees with it and that reconciliation differences stay within the rounding tolerance (at most one smallest unit per fill or lock).
   - **Precision tests:** synthetic markets with other precisions and non-zero fees.
   - **Negative test:** reading `Trade.isBuy` as the maker's side must make reconciliation fail (so nobody reverts to the wrong reading).
3. `docs/LEDGER.md`: data model, formulas, rounding rules, event semantics, list of unknowns.
4. Update `docs/FINDINGS.md` and append progress to the notes file.

## Unknowns to investigate (read-only chain queries; do not guess)

- With a partial fill: how `Trade.updatedSize` and the flipped opposite order grow, and when `FlipOrderUpdated(orderId, size)` appears.
- Whether a filled sell automatically flips back into a buy (inferable from `flippedPrice`, but not yet seen).
- Whether other markets charge non-zero fees.

Use the public RPC (`https://rpc.monad.xyz`, at most 90 blocks per `eth_getLogs` call) to scan other accounts' flip orders for samples. If none are found, mark the point "unverified" and make the code conservative: report "cannot explain" instead of computing a guess.

## Red lines

- Send no transactions, never use `--live`, never touch private keys.
- Do not modify `state/`.
- Ask the user before installing dependencies (for example typescript, vitest); Node 25 runs `.ts` directly (type stripping) and tests can use `node --test`.
- Do not delete or break `scripts/gate.cjs`, `lib/` or the existing tests.

## When finished

1. `npm test` passes.
2. Write progress and new findings into the notes and `docs/FINDINGS.md`.
3. Tell the user that stage C is done and that stage D (UI, sign-in, cross-chain funding and other integrations) should run in a new session on Sonnet 5.5.
