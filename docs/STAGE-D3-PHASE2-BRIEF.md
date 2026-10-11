# Stage D, milestone 3, phase 2: the Perpl hedge (brief for a Sonnet 5.5 session)

Read first: `docs/STAGE-D3-BRIEF.md`, `docs/PERPL-ONCHAIN.md` (direct on-chain ordering works in simulation), `docs/AGORA-FEASIBILITY.md`, `docs/STAGE-D2-BRIEF.md` (the safety boundary), `docs/FINDINGS.md`, `docs/PASSKEY-TEST-RUNBOOK.md`.

## Goal

A visitor who holds MON from filled flip bids can offset that inventory with a short on Perpl's MON perpetual, see exactly what it costs and risks, and close it again, signing either with a browser wallet or with the passkey wallet. Every number shown comes from the chain or from verified documentation.

## First task: verify three open facts, read-only, before any UI

1. **The funding unit and interval.** The MON rate read on 2026-10-11 was -4. The docs say funding applies roughly hourly (every 8,571 blocks at an assumed 0.42 s) while the market config says 2,580 s. Measure it: read the cumulative funding sum (`getFundingSumAtBlock` or the equivalent in `config/perpl.exchange.abi.json`) at blocks on both sides of a funding event, relate it to the rate that was set, and derive the real cost per day for a short of a given notional. Write the result with block numbers in `docs/PERPL-ONCHAIN.md`.
2. **Why the exchange locks 0.5% to 0.85% more collateral than notional divided by leverage** (found in phase 0). Find the rule in the docs or the contract views and state it.
3. **Fees in practice**: units of `maker_fee` and `taker_fee`, the tier used for a new account, and the round-trip cost of opening and closing the minimum hedge.

If funding turns out to make a hedge uneconomic at small size, still deliver the mechanics, show the daily cost prominently, and say so in the findings.

## Deliverables

1. **Guard**: new transaction kinds with their own allow-list in `src/plant.ts` (or a new module like `src/swapguard.ts`): AUSD `approve` to the Perpl exchange only, exact amount, cap 15 AUSD; account creation with the deposit (at least the minimum read from the contract, at most 15 AUSD); open a **short** on market id 10 only, sized so the notional stays at or below 15 USD and leverage at or below 2x; close only (reduce-only) for the closing order; withdraw to the owner's own address. Decode the calldata of every call; refuse anything else. Negative tests for each refusal.
2. **Flow**: reuse `sendStep`, so each transaction is simulated, announced, confirmed once, and verified against the chain (position side and size, collateral change within the documented tolerance, expected events). Orders are marketable limit orders with immediate-or-cancel and an explicit slippage bound (see PERPL-ONCHAIN.md); state clearly what happens when the order only partly fills. Works through both the wallet-extension path and the Mera wallet (both speak EIP-1193 to the engine).
3. **Hedge page** (`#hedge`, reusing the restyled components): MON inventory (wallet plus Kuru), a hedge ratio control (default 50%, whole MON, at least 1), the short size, margin needed at 2x, estimated liquidation price (`src/perpl/hedge.ts`), the verified funding cost per day, a plain risk note (a short loses if MON rises; liquidation can lose the margin), and a **Close hedge** button that is always visible once a position exists. States: no account, account without a position, position open, closing. No invented numbers; anything not verified is labelled "estimate".
4. **Tests** (`node --test`): the state machine against the fake chain extended for Perpl, guard negatives, hedge maths, post-conditions, wrong chain, rejection, reload half-way. No test sends anything real.
5. **Docs**: `docs/HEDGE-TEST-RUNBOOK.md` for the owner's first real run (budget: at least 10 AUSD for the account plus a few MON; expected pop-ups; what must not happen; what to send back), README section, progress in `docs/FINDINGS.md` and the notes.

## Red lines

- The AI session never signs or sends a transaction, never uses a key, never creates a Perpl account, never enrolls an API key. Read-only calls and `eth_call` simulations only.
- Keep edits to shared files (`web/src/main.ts`, `web/src/ui.ts`, `web/style.css`, `web/index.html`) small and append-only; another session (garden game layer) edits `web/src/plant.ts` and adds garden files in parallel. Put your page in new files.
- No new runtime dependency. All 144 existing tests keep passing. Do not push, deploy or change repository settings.
- Everything written into the repository is English. Reply to the user in Chinese, conclusion first.
