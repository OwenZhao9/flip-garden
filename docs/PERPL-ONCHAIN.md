# Perpl direct on-chain ordering (stage D, milestone 3, phase 0)

Read-only spike, 2026-10-11. No transaction was sent, no key was used, no Perpl account was created, no authenticated endpoint was called. Everything below was read from public sources or produced by `eth_call` / `debug_traceCall` simulations on Monad mainnet (chain id 143) from a random throwaway address.

## Decision

**Direct on-chain ordering works in simulation. No relay server is needed.** The exchange contract executes orders for `msg.sender`'s own account, so the page can sign an ordinary transaction and send it through the public Monad RPC, which accepts calls from `https://owenzhao9.github.io` (checked below). GitHub Pages stays sufficient for hosting.

What this does **not** prove: a real transaction was never sent, so mempool, nonce, gas-limit and fill behaviour with real money are unverified until the owner's own run in phase 3.

## Sources and pinning

| Item | Value |
|---|---|
| Interface source | `github.com/PerplFoundation/dex-sdk`, commit `78ce8a06e39e2f9288792eba41aca5f3c08c1195` (2026-10-08), files `crates/sdk/abi/dex/Exchange.json`, `crates/sdk/abi/dex/Errors.abi.json`, `crates/sdk/src/types/request.rs`, `crates/sdk/src/state/version.rs`; ABI revision `rc_v1.1.7-203-g0e5902dd` |
| Docs | `docs.perpl.xyz/llms-full.txt`, read in Chrome 2026-10-11 |
| Exchange (mainnet) | `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`, `getContractVersion()` = 1.7.5, `isHalted()` = false |
| Collateral | AUSD `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 decimals (`getExchangeInfo()` names it as the collateral token) |
| MON market | perp id 10, "MON Perp", price decimals 6, lot decimals 0 (size = whole MON), maintenance factor 20 (5% of notional), maximum leverage 10x (`getMarginFractions`) |
| Stored in the repo | `config/perpl.mainnet.json` (addresses, source pin, AUSD storage layout), `config/perpl.exchange.abi.json` (the 24 functions and 18 events we use, copied from the pinned ABI), `config/perpl.errors.json` (149 error signatures, to name reverts) |

The live values (decimals, minimum deposit, fees) must be read from the chain at run time; the config copies are what was seen on 2026-10-11.

## Contract interface (what we use)

All arguments are static types, so a call is a selector followed by 32-byte words. Units: price `PNS` = AUSD x 10^6 per whole MON, size `LNS` = whole MON, collateral `CNS` = AUSD x 10^6, leverage in hundredths (500 = 5x).

| Purpose | Signature |
|---|---|
| Approve AUSD | `approve(address,uint256)` on the AUSD token, spender = the exchange |
| Create account + first deposit | `createAccount(uint256 amountCNS) returns (uint256 accountId)`; `amountCNS >= getMinAccountOpenCNS()` (10,000,000 = 10 AUSD on 2026-10-11) |
| Deposit / withdraw | `depositCollateral(uint256)`, `withdrawCollateral(uint256)` |
| Orders | `execOrder(OrderDesc)`, `execOrders(OrderDesc[], bool revertOnFail)` where `OrderDesc` = (orderDescId, perpId, orderType, orderId, pricePNS, lotLNS, expiryBlock, postOnly, fillOrKill, immediateOrCancel, maxMatches, leverageHdths, lastExecutionBlock, amountCNS, maxNegPnlCollatBPS), 15 words |
| Order types | 0 OpenLong, 1 OpenShort, 2 CloseLong, 3 CloseShort (reduce-only), 4 Cancel, 5 IncreasePositionCollateral, 6 Change |
| Views | `getAccountByAddr`, `getAccountById`, `getPositionV2(perpId, accountId)`, `getPerpetualInfoV2`, `getPerpOrderLocks(accountId, perpId)`, `getOrderV2(perpId, orderId)`, `getMarginFractions`, `getTakerFee`, `getMakerFee`, `getMinAccountOpenCNS`, `getContractVersion`, `getWithdrawAllowanceData` |
| Events (none has an indexed field) | `AccountCreated`, `CollateralDeposit`, `CollateralWithdrawal`, `OrderRequestV2`, `OrderPlaced`, `OrderCancelled`, `OrderChanged`, `PositionOpenedV2`, `PositionDecreased`, `PositionClosed`, `MakerOrderFilledV2`, `TakerOrderFilledV2`, `OrderBatchCompleted` |

Facts worth knowing:

- There is no market-order primitive. A "market order" is a limit order with `immediateOrCancel` priced at the slippage bound (docs, "How a market order is built").
- `revertOnFail = true` makes the batch revert when one request fails; with `false` the exchange skips the request and emits an error event. The page must use `true` so that simulation and real call agree.
- Order forwarding (`allowOrderForwarding`) is the operator path used by REST/WebSocket. Direct ordering does not need it and it is left off.
- A smart contract can own an account (the simulations use one), so account abstraction is not excluded; not tested with Mera's EOA, which is an ordinary key.
- On-chain the only access list is `addressBlocked(address)`; the REST country list (BY, CU, GB, IR, KP, RU, SY, UA, US) is applied by Perpl's API, which a chain call never touches. Whether Perpl's terms forbid using the contract from those places is not something this spike checked.
- Fee unit: contract >= 1.7.5 stores fees in **millionths** of notional (`PPM_FEE_UNIT` in `version.rs`; earlier versions used hundred-thousandths). `getTakerFee(10)` = 345 = 3.45 bps and `getMakerFee(10)` = 45 = 0.45 bps match the docs' tier 1 table. The simulated fill below charged 858 CNS on a notional of 2,484,100 CNS = 345.4 per million, confirming the unit.

## Simulations

`node src/perpl/simulate.ts` (read-only; add `--json` for machine output). Run at block 112,391,577 (2026-10-11 06:00 UTC), pinned to one block so the book cannot move between steps. The throwaway sender is given a forwarding bytecode, 100 native MON, 1,000 AUSD and an allowance for the exchange by state override. 17 of 17 behaved as expected, five consecutive runs.

| # | Simulation | Result |
|---|---|---|
| 1 | `createAccount` with the minimum, 10 AUSD | ok |
| 2 | control: 1 unit below the minimum | revert `InsufficentAmountToOpenAccount` (sic) |
| 3 | control: no AUSD | revert `ERC20InsufficientAllowance` |
| 4 | control: no allowance | revert `ERC20InsufficientAllowance` |
| 5 | create, then OpenShort 1000 MON resting post-only 3% above the best ask | ok |
| 6 | control: OpenShort without an account | revert `AccountDoesNotExist` |
| 7 | control: post-only OpenShort that crosses the book | revert `CrossesBook` |
| 8 | control: OpenShort at three times the price (outside the exchange limits) | revert `CantPostOrder` |
| 9 | control: OpenShort of 5,000,000 MON (needs more margin than 10 AUSD) | revert `CantPostOrder` |
| 10 | create, then OpenLong 1000 MON resting post-only 3% below the best bid | ok |
| 11 | cancel the resting order in the same simulation | ok |
| 12 | change the resting order (price 1% up) | ok |
| 13 | hedge: OpenShort 100 MON, IOC at the best bid | ok, fills |
| 14 | unwind: CloseShort 100 MON, IOC 2% above the best ask | ok, position closed |
| 15 | control: CloseShort with no position | revert `CloseOrderExceedsPosition` |
| 16 | withdraw 5 of the 10 AUSD | ok |
| 17 | control: withdraw 11 AUSD | revert `AmountExceedsAvailableBalance` |

The events of the hedge (rows 13 and 14), from `debug_traceCall`, show the real mechanics: the order is matched against a resting maker (here account 4704 at 24,841), `PositionOpenedV2` opens a short of 100 MON at 0.024841 AUSD with leverage 5x, the taker fee is 858 CNS, and the unwind sweeps two makers and `PositionClosed` reports a delta PnL of -2,700 CNS. Round trip on a notional of about 2.48 AUSD: -2,700 PnL (the spread walked) plus 2 x 858 fees = 4,416 CNS, about 0.18% of notional.

Gas used by the EVM in the three forwarded calls (create, open, close): 175,575, 200,308, 242,677. Monad bills the gas **limit**, not the gas used (docs/FINDINGS.md), so the page must set limits with margin; at the observed `eth_gasPrice` of 0x17bfac7c00 (102 gwei) a limit of 400,000 costs about 0.04 MON.

Not simulated with real state: anything involving a real account's existing positions beyond a read, and rate limits on larger withdrawals (`getWithdrawAllowanceData` returned zeros for the example account; the 5 AUSD withdrawal passed).

### How the simulation works (and its limits)

Every call acts on `msg.sender`, and a fresh address has no account. `src/perpl/sim.ts` therefore puts an 85-byte forwarding program on the throwaway address with an `eth_call` state override, so one `eth_call` can run "create account, open, close" in sequence with the same sender. AUSD balance and allowance are faked by writing the token's storage: AUSD is an upgradeable proxy whose balance for `a` sits at `keccak256(abi.encode(a, base))` as `amount << 8` (the low byte holds flags), and whose allowance sits at `keccak256(abi.encode(spender, keccak256(abi.encode(owner, base + 1))))`; `base` is in `config/perpl.mainnet.json` (found by tracing `balanceOf` with `debug_traceCall` and matching the implementation's constants). The forwarder is tested on a small reference interpreter in `test/perpl-sim.test.ts`.

Limits: a simulation is a statement about one block. The book moves several times a second, so a price read earlier can be stale. Use `immediateOrCancel` with a price bound, `lastExecutionBlock` a few blocks ahead, and `revertOnFail = true`, and expect real fills to differ from the simulated ones.

## Browser access (checked from the live page origin)

From `https://owenzhao9.github.io/flip-garden/` in Chrome, plain `fetch` POSTs to `https://rpc.monad.xyz` succeeded for `eth_gasPrice`, `eth_getTransactionCount`, `eth_call`, `debug_traceCall` and `eth_sendRawTransaction` (sent with the undecodable payload `0x00`, rejected as "Transaction decoding error", so nothing could have been broadcast). Together with the earlier `eth_chainId` and Kuru Flow results this means a static page can read, simulate and broadcast without a server.

## Read model

`src/perpl/state.ts` reads, with `eth_call` only: the account (free and locked collateral, position bitmap), a position (side, deposit, entry, size, PnL, funding, mark), the perpetual (decimals, mark, oracle, open interest, funding rate, book limits), resting orders (`getPerpOrderLocks` gives lock ids that pack `perpId * 65536 + orderId`, then `getOrderV2`), margin fractions, fees, version. Decoders are checked against ethers on raw responses captured live (`test/fixtures/perpl-live-2026-10-11.json`, account 4704 at block 112,390,602, plus 60 real logs).

Fills come from logs. **No event has an indexed parameter**, so a log query can only filter by address and event, never by account: each 90-block request returns every account's events (about 2,200 in one 90-block window on 2026-10-11) and the account is filtered after decoding. The taker-side events carry no account id, so they are attributed to the most recent `OrderRequestV2` in the same transaction. For the page this means: read positions and orders with views (cheap, exact), and take fills from the receipts of our own transactions; a long history scan is expensive and would want an indexer.

## Hedge maths

`src/perpl/hedge.ts`, pure integers, tested:

- `shortSize`: inventory (18 decimals) x ratio (bps) rounded **down** to whole MON; below one MON the lot is 0 and `meetsMinimum` is false (never round up into an over-hedge).
- `marginPlan`: notional rounded up, initial margin = notional x 100 / leverage-hundredths, entry fee from the millionths unit, plus a buffer. The simulated fills deposited 0.5% to 0.85% **more** than notional / leverage (2,700 and 4,200 CNS "pnl collateralized" in two runs, a 100 MON short at 5x). **Cause found in phase 2** (see "Phase 2 findings"): the exchange locks the negative PnL of the fill against the mark price on top, (mark - fill) x size for a short. A buffer of 200 to 300 bps stays as slack.
- `liquidationPricePNS`: the docs' formula `P_entry + s * (C_MMR - C_deposit - C_funding) / L` with `C_MMR = P_entry * L / MMF`, MMF = maintenance hundredths / 100. For 100 MON at 24,913 with 500,960 CNS deposited the estimate is 28,676 (+15%). It ignores dynamic initial margin and price tolerances, so it is indicative only. Funding-aware.
- `fundingCostPerIntervalCNS`: sign convention from the docs (positive rate: longs pay shorts), unit hundred-thousandths of notional per funding event. **Verified in phase 2**, with one correction: an event happens every 8,571 blocks, which is about 43 minutes on Monad today, not one hour (see "Phase 2 findings"). `fundingCostPerDayCNS` and `measuredShortFundingCNS` were added.

## What phase 1 needs

1. **A rule change from the owner**: with Mera the page holds a derived key in memory for one signing session (see the brief). Direct ordering makes this unavoidable, since the page itself signs every Perpl transaction.
2. **Dependencies to approve**: the Mera package and viem (for `toViemAccount` and transaction signing). The encoders and read model here have no dependency and are what the page should call.
3. **A funding spike**: how to execute a Kuru Flow swap (USDC or MON to AUSD) from the page. Only quotes were verified; the transaction format is not.
4. **Pre-sign simulation in the page**: before every signature, run `eth_call` from the user's real address with real state (no overrides): approve first, wait for it, then simulate `createAccount`; then orders with `revertOnFail = true`, `lastExecutionBlock = head + N`, `immediateOrCancel` and a price bound.
5. **Caps in config**, in the same style as Kuru's: maximum deposit, maximum notional of the hedge, leverage ceiling (start at 3x to 5x, the market allows 10x), minimum native MON for gas, hedge only up to the inventory that exists.
6. **Gas**: set explicit limits (about 400,000 for an order, 250,000 for account creation) since Monad bills the limit.
7. **Phase 3** (the owner's own real-money run) is the only thing that can confirm real fills, funding, fees and withdraw limits.

## Unverified

Real transaction behaviour (nonce, replacement, receipts); fills at real prices and sizes beyond one level; withdraw rate limits for larger amounts; the oracle staleness effect on order rejection; whether Perpl's terms allow direct contract use from every jurisdiction; builder fees (the V2 entrypoint `execOrdersV2` carries builder attribution and is not used here); the Kuru Flow swap transaction.

## Files

`src/perpl/abi.ts`, `encode.ts`, `events.ts`, `sim.ts`, `state.ts`, `hedge.ts`, `simulate.ts`; `config/perpl.*.json`; `test/perpl-encode.test.ts`, `perpl-sim.test.ts`, `perpl-state.test.ts`, `perpl-hedge.test.ts`; fixture `test/fixtures/perpl-live-2026-10-11.json`. 87 tests in total (59 before).

## Phase 2 findings (2026-10-11, read-only)

Again read-only: `eth_call`, `eth_getLogs`, `debug_traceCall` with state overrides from a random throwaway address, public docs read in Chrome. No transaction, no key, no account. Head block when measured: 112,428,172 to 112,429,445.

### Funding: unit, interval and real cost

- **Interval.** `getFundingInterval()` returns 8,571 (blocks). The `FundingEventCompleted` events for MON (perp 10) are exactly 8,571 blocks apart: log blocks 112,391,445, 112,400,016, 112,408,587, 112,417,158 and 112,425,729 (the event's own `fundingEventBlock` is 78 blocks later: 112,391,523 ... 112,425,807, because the rate is set up to 143 blocks ahead). Blocks 112,391,523 and 112,425,807 are 34,284 blocks and 10,350 s apart (timestamps), so a block takes 0.3019 s and **an interval is about 2,587 s, 43 minutes** (the market config's 2,580 s was right; the docs' "hourly, 0.42 s blocks" is not how Monad runs today). About 33.4 events a day.
- **Unit.** The event carries `specifiedRatePct100k`, `actualRatePct100k` (the same unless clamped), the funding price and `fundingPaymentPNS`. In all five events `payment = price x rate / 1000` truncated toward zero, for example rate -4 at price 25,473: -101 (-101.89); rate -3 at 24,886: -74 (-74.66). The perpetual's `fundingSumScalingExp` is 2, so the payment is in 1/100 of a price unit per lot: **per funding event a position's funding is rate / 100,000 of its notional** (rate -4 = 0.004%). The cumulative sum (`getFundingSumAtBlock(perpId, block)` returns an int48 sum and the block of the last event) was 76,585 after the -3 event and 76,484 after the -4 event (difference -101).
- **Sign, checked on real closes.** Positions that closed after the -4 event (blocks 112,426,402 to 112,428,820) show `fundingCNS` = lots x 1.01 with the sign: **positive for longs (+3,978 on 3,939 lots), negative for shorts (-82 on 81 lots, -41,797 on 41,383 lots)**. A negative rate therefore makes **shorts pay longs**, as the docs say, and `fundingCNS`/`premiumPnlCNS` are credit-positive. A short's cost is -(sum_now - sum_then) / 100 price units per MON.
- **What it costs.** At the current rate (-4) a short pays 0.004% per event, **about 0.134% of notional a day** (about 49% a year). That rate is not typical: it was 0 in three of the last five events. Measured from the cumulative sum (blocks per day taken as 286,197): over the last 1 day -3.52, 3 days -25.34, 7 days -39.77 and 14 days -65.07 price units per MON (at a price of 25,400 that is **0.014% of notional for the last day, 0.157% for 7 days, 0.256% for 14 days**, so on average about 0.018% a day, 6.7% a year). On a 15 USD hedge that is a fraction of a cent a day. The cost is not what makes a small hedge uneconomic: the spread and fees below are larger.
- Funding is virtual: it is settled only when a position changes size or closes (`PositionDecreased` / `PositionClosed` carry `fundingCNS`), and `getPositionV2.premiumPnlCNS` shows it.

### Why extra collateral is locked (the 0.5% to 0.85%)

The docs say the **mark price is used for "additional collateral requirements when a position is opened or increased if its PnL is negative"**. Rule, confirmed by simulating shorts and a long of 100 to 1,000 lots at three pinned blocks (a scripted check that compares the `PositionOpenedV2` deposit with the formula):

`deposit = ceil(notional x 100 / leverage_hdths) + extra`, `extra = max(0, (mark - fill) x size)` for a short, `max(0, (fill - mark) x size)` for a long, capped at `maxNegPnlCollatBPS` (default 1000 = 10% of notional).

Block 112,429,212, mark 25,264, best bid 25,234, best ask 25,273, 2x: short 100 at 25,234 locks 504,680 + 3,000; short 1,000 locks 5,046,800 + 30,000; long 100 at 25,273 locks 505,460 + 900. Block 112,429,445, mark 25,283: short 560 at 25,248 locks 5,069,440 + 19,600 (= 35 x 560). In every case `PositionOpenedV2.pnlCollateralizedCNS` equals the extra and `depositCNS` is the sum. The extra is not a fee: it is collateral for the immediate paper loss and stays in the position. A short opened at the best bid starts about 0.1% to 0.15% under water because the bid sits under the mark.

### Fees in practice

- `getPerpFeeSchedule(10)` returns schedule id 1021, then eight taker values and eight maker values: taker 345, 300, 250, 210, 175, 150, 125, 0 and maker 45, 25, 15, 0, 0, 0, 0, 0. The field names say "Per100K" but the contract is 1.7.5 and the values are **millionths of notional** (tier 1: taker 3.45 bps, maker 0.45 bps; `getTakerFee(10)` = 345, `getMakerFee(10)` = 45). New accounts start in **tier 1** (the 14-day volume tiers start at 5 million USD).
- The fee is charged **on top of** the collateral: for 100 MON at 25,233, notional 2,523,300, the taker fee is 871 (345.2 per million), collateral 507,360 and the account loses 508,231. For 560 MON at 25,248: fee 4,878 (345.0 per million). It is rounded to the nearest unit (871 vs 870.6, 4,878 vs 4,877.9).
- **Round trip of the minimum hedge (1 MON, about 0.025 AUSD):** two taker fees are 0.0000174 AUSD, the spread (best ask 25,293 minus best bid 25,250) costs 0.000043 AUSD. About **0.24% of notional** at today's book, below a hundredth of a cent. For the capped 15 USD hedge: about 0.036 AUSD. The page shows this as an estimate.
- The first deposit must be at least `getMinAccountOpenCNS()`, 10 AUSD today; there is no fee on deposit or withdrawal in the simulations.

### Immediate-or-cancel behaviour (simulations)

- An order priced beyond the book (a short above the best bid) **succeeds and does nothing**: events `OrderRequestV2` and `OrderBatchCompleted` only. The page must read the receipt, not just the status.
- 400 and 560 lots at the best bid and 1% below it fill completely against one maker (the top bid held more than 560 lots). A short too big for the account (5,000 lots with 15 AUSD) fills 3,960 and then reverts with `TakerOrderSettlementFailed` (the margin does not suffice), so a partial fill cannot be produced by size alone with a small account. Partial fills are therefore tested only against the fake chain and are read from receipts (`PositionOpenedV2.lotLNS`).
- A reverting view (no account) takes the public RPC about a request; the read adapter no longer retries reverts.

### Other facts used by the page

`isHalted()` is false; `getMarginFractions(10, lots)` returns initial 1000 (10x), maintenance 2000 (5%) and dynamic initial 1000 for 1 to 1,000 lots. The liquidation price formula in `liquidationPricePNS` for a 2x short at 25,250 gives about +45% (deposit 50% of notional, maintenance 5%). The estimate ignores the dynamic margin and price tolerances.

### What the real run must still show

Real signing and broadcast, the gas limits (the page sets 1.2 times the estimate), nonce handling, a real fill (price, fee, extra collateral against the real mark at inclusion), how the passkey wallet behaves with these calls, the withdraw limits (`getWithdrawAllowanceData` read zeros for an example account; the 5 AUSD simulation passed) and a funding event while a position is open. See `docs/HEDGE-TEST-RUNBOOK.md`.
