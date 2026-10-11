# Stage D, milestone 1: the read-only ledger page (brief for a Sonnet 5.5 session)

## Goal in one sentence

Build a **publicly reachable web page** where someone enters a Monad wallet address (or clicks an example) and sees that wallet's Kuru flip-order ledger: balances (free and locked), flip chains, fills, fees and gas, profit and loss (losses included), position growth, and a result that says whether the ledger matches the chain. **Strictly read-only: no wallet connection, no signing, no private keys.**

## Why this first

- The ledger core (`src/`) is done and has 51 tests; what is missing is a way for judges and users to see it.
- The hackathon platform requires a live product link that runs on Monad mainnet or testnet; a read-only page qualifies and is the fastest thing to ship.
- It is the foundation of the later "plant" flow: after placing orders, users will look at exactly this ledger.

## Existing assets (read these first)

- `docs/LEDGER.md` (ledger design), `docs/FINDINGS.md` (verified facts), `README.md`.
- `src/`: the dependency-free TypeScript ledger core. `index.ts` is the entry point; `events.ts` decodes events; `ledger.ts`, `pnl.ts`, `reconcile.ts`; `scan.ts` is the resumable incremental log scanner; `rpc.ts` is the read-only JSON-RPC adapter. **First confirm they have no Node-only dependencies and run in a browser** (a static check found none).
- `test/fixtures/gate-test-2026-10-10.json`: the data of our real-funds test. `test/fixtures/flip-partial-fills-0x52ce.raw.json`: real partial-fill samples from another account.
- `config/kuru.mainnet.json`: contract addresses (MON-USDC market, margin account, USDC).

## Example wallet (the page needs a one-click example)

- Address: `0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38` (our test wallet; public information).
- Start block 112,209,462 (where the test began). End block for the example: 112,211,600 (the test finished at 112,211,503), so only about 2,000 blocks are scanned and the result appears within seconds.
- Expected results (the page must compute the same): USDC net change -4.976961; MON net change +201 after adding back gas; total gas 0.095135 MON; reconciliation difference 0 for USDC and 0 for MON; one bid filled in full, one new-id sell order created by the flip, then cancelled.

## Deliverables

1. **The web app**, in `web/` (its own `package.json` and build; import the core by relative path from `../src`; never copy core code).
   - Home: an address input, a start-block input (with a short explanation of why it is needed), an end block (default: latest), and a "Try the example wallet" button.
   - Ledger view:
     - A reconciliation badge at the top: matches / does not match / cannot explain, with the difference and the reason (the core already produces these).
     - Balances: wallet, free margin, locked in orders, net worth; state which price basis is used.
     - Orders and flip chains: for each order, which order it flipped out of, its status (resting / filled / cancelled), price and size.
     - Fills: block, side **from our maker's point of view** (bought / sold; do not copy `Trade.isBuy`, which is the taker's side), price, size, counterparty (taker contract and originating address, shortened), and the transaction hash linking to the Monadscan explorer.
     - Fees and gas, realized and unrealized profit and loss (label both bases), position growth, inventory imbalance.
     - A collapsible "How this is calculated" section (net-worth identity, rounding rules, unknowns), quoting `docs/LEDGER.md`.
   - A light "garden" skin: each price level is a plot, coloured by state (planted, harvested, pruned). **The numbers must stay sober and exact; the game feel must never outweigh the ledger.**
   - English UI (it is read by judges). Keep the structure ready for a Chinese switch but do not build it yet.
   - Usable on a phone: single column on narrow screens, touch-friendly, text of at least 16 px.
2. **Data layer:** use the core's read-only scanner in the browser with at most 90 blocks per `eth_getLogs` call; show progress; allow cancelling; cache results in the browser (per address and block range); retry failures and explain them in plain words (for example public-node rate limiting).
3. **Tests:** make the step from raw data to displayed values a set of pure functions and test them with `node --test` (all money as integers and fixed-point formatting; no floating-point arithmetic on the page); assert the example wallet's expected numbers from the samples.
4. **Docs:** add a "Live demo" section to `README.md`; append progress to `docs/FINDINGS.md` and to the notes.
5. **Deployment plan (do not deploy yet):** write down the recommended free static hosting (for example GitHub Pages) and the steps, and **ask the user before doing anything**; deploying is publishing and needs their consent.

## Known difficulties (think these through first)

- **Scanning history by address is expensive.** The owner address is not an indexed event field, so you cannot filter by address; you can only scan block ranges. The page must therefore ask the user for a start block (or give a reliable default) and support an end block. Do not promise "any address, full history, instantly". An indexer such as Envio can come later; that is a separate decision.
- The public RPC allows about 100 blocks per `eth_getLogs` call and may rate-limit. Confirm that browser requests work (they are known to work against `https://rpc.monad.xyz`).
- Partial fills and `FlipOrderUpdated` are understood from real samples. Non-zero fees, and fills that produce no new flipped order, have never been seen: show "cannot explain" for them, never compute them by guessing.

## Red lines

- Never connect a wallet, request a signature, send a transaction, use `--live`, or touch a private key.
- Do not modify `state/`; do not break `scripts/gate.cjs`, `lib/`, `src/` or the existing tests (all 51 must keep passing).
- Ask the user before installing any dependency (frontend framework, bundler). Propose the lightest option first (for example Vite with plain TypeScript, or a very small framework) and say why.
- Do not deploy, change repository settings or push unless the user agrees.
- Every number on the page comes from chain data and the core. Nothing is hard-coded; the example expectations above are for tests only.
- Everything you write into the repository, including UI text, must be in English.

## When finished

1. `npm test` is green; open the local page with Claude in Chrome and verify the example wallet against the expected numbers above.
2. Record progress and findings in the notes and in `docs/FINDINGS.md`.
3. Tell the user that milestone 1 is done and list the decisions you need from them (how to deploy, whether to build a Chinese UI, whether the plant flow comes next).
