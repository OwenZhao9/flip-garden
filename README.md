# Flip Garden

Flip Garden is a garden-style game on Monad that lets anyone plant a few dollars as Kuru flip orders, watch real fills, and read an honest ledger of every gain and loss.

> **Status: work in progress.** The on-chain loop is verified with real funds on Monad mainnet (see below). The ledger core and the read-only ledger page are built, tested and live. The browser planting flow was run once with real money on 2026-10-11 (MetaMask, one level, about 6 USDC) and reconciled with the chain; it has not been run on a phone, with other wallets, or through a full flip-back cycle. The passkey login with the AUSD swap is built and tested against fakes, but **unverified with a real passkey and real money until its first real run** (see below).

## The idea

[Kuru](https://docs.kuru.io) is a fully on-chain order book on Monad. Its **flip orders** are limit orders that, once filled, automatically place the opposite order at a price you choose, so every completed round trip earns the spread without running a bot.

Flip Garden turns that into something a beginner can understand:

- **Plant**: spread a small budget across price levels, preview the orders, then confirm to place real ones.
- **Harvest**: fills appear as they happen; Monad blocks arrive roughly every 0.3 seconds.
- **Ledger**: a sober, always-on record of real fills, fees, gas and profit or loss, losses included, reconciled against on-chain balances.
- **Prune**: cancel, move or shrink orders when your inventory drifts to one side.

There are no custom contracts: everything goes through Kuru's own contracts.

## Live demo (read-only ledger page)

`web/` is a static page that reads any wallet's Kuru flip-order history straight from the public Monad RPC and shows the ledger: balances, flip chains, fills, fees, gas, realized and unrealized profit and loss, and a reconciliation badge ("Matches the chain" / "Cannot be fully explained" / "Does not match"). It never connects a wallet, requests a signature or sends a transaction.

- Press **Try the example wallet** to replay the real-funds test above (about 2,100 blocks, 24 requests of at most 90 blocks, roughly 15 seconds the first time; the scan is saved in the browser).
- Wallets cannot be looked up directly on the chain, so you give a **start block** and the page reads every block from there.
- Public link: **https://owenzhao9.github.io/flip-garden/**, published by a GitHub Action from `main` (see [`docs/DEPLOY.md`](docs/DEPLOY.md)). To run it locally: `cd web && npm install && npm run build`, then serve `web/dist/` with any static file server.
- Mobile layout: checked at 390 px width in a desktop browser (no horizontal scroll, 16px text, tables become stacked cards); not yet tried on a real phone.

## Planting flow (verified once with real money, 2026-10-11)

`#plant` on the same page lets a visitor connect **their own** browser wallet (EIP-6963 or `window.ethereum`), preview a ladder of up to three flip bids, and deposit, plant and later unwind it. Safety rules, enforced in code and tests:

- No private key ever reaches the page; the wallet signs. The page can only call the Kuru margin account, the MON-USDC market and USDC on Monad mainnet (chain id 143), checked on the decoded calldata of every transaction.
- One wallet pop-up per transaction, always after a plain statement, a successful simulation from the visitor's own address and a gas figure. Approvals are for the exact amount, never unlimited.
- Hard caps from `config/kuru.mainnet.json`: 15 USDC per deposit, 3 orders and 15 USDC per planting, 0.5 MON kept for fees.
- The order book is re-read before the simulation and again right before the pop-up; a bid that would cross is refused. Bids are sent with `provisionOrRevert = true`, so either the whole confirmed ladder is created or nothing is.
- After every transaction the page reads the chain at the receipt's block and verifies the result (allowance equals the approval, margin grew by exactly the deposit, the expected `FlipOrderCreated` events and locked USDC match the preview, orders gone after cancel, margin empty after withdraw). Any mismatch stops with "Cannot explain".
- Progress is derived from chain state, so a reload half-way resumes correctly. Unwind (cancel all, withdraw all) is always one button away.
- Calldata encoders are dependency-free (`src/abi.ts`) and tested against `ethers` and the SDK ABI. The flow runs against a fake wallet and fake chain in tests and in `web/fake.html`; nothing in this repository's tests signs or sends anything.

The first real run, with every transaction hash and the reconciliation, is recorded in [`docs/FINDINGS.md`](docs/FINDINGS.md); how to repeat it: [`docs/PLANT-TEST-RUNBOOK.md`](docs/PLANT-TEST-RUNBOOK.md).

## The garden game layer (built and tested against fakes; not yet run with real money)

The planting page turns your ledger into a garden, derived from chain facts every time the page reads them (nothing is stored, and no game number is ever mixed into a ledger number):

- **Plots that grow.** Each planted order is a plot: a seed (resting), a sprout (partly filled), a flower (one leg completely filled), fruit (a completed round trip) or a cut stem (the newest order was cancelled). The mapping is one pure function, `stageOf` in [`src/garden.ts`](src/garden.ts), tested on our own real run and on another account's real fills. The ledger page shows the same plots read-only for any wallet.
- **Per-plot actions**, through the same guard and one-transaction-at-a-time engine as planting: **Prune** (cancel chosen resting orders), **Harvest** (withdraw what is free at Kuru; it returns free money, not profit) and **Move** (prune a bid, then plant a new one at a price chosen from the current book: two steps, each simulated and confirmed on its own). Only orders the chain shows as resting and owned by the connected account can be chosen.
- **Level and achievements.** Seed, Sprout, Bloom and Orchard come from completed round trips and the garden's age (read from block timestamps); seven achievements (first planting, first fill, first round trip, a garden of three, seven days old, first prune, first harvest). They say nothing about profit.
- **Live refresh** every 10 seconds while the tab is visible, using the scanner's cache so only new blocks are read.
- **Honest label.** A completed round trip (a leg fills and the flipped leg fills too) has not been seen on real chain data yet, so everything that depends on one is labelled "not yet seen on real data"; a test fails when a fixture proves otherwise and the flag is not updated.

Walk through every state without a wallet or real money on `web/fake.html` (build with `npm run build:fake` in `web/`, serve the folder, open `fake.html`). Screenshots: [`docs/screens/`](docs/screens/).

## Passkey login, AUSD and the PWA shell (built, not yet verified with a real passkey or real money)

`#passkey` on the same page signs a visitor in with a **passkey** (Face ID, Touch ID or a device PIN) through [Mera](https://mera.category.xyz), Monad's passkey login. The passkey gives the page 32 secret bytes (the WebAuthn PRF feature); an ordinary Monad address is derived from them with the recipe in Mera's docs, so the same passkey on the same host always gives the same address.

**The key rule, in plain words** (approved by the owner for this path only): the secret and the derived key exist only in the page's memory, for one signing session. They are never written to storage, logged or sent anywhere. The session ends on the Lock button, after 5 minutes without activity, when the page is hidden, and on reload; after that, signing fails. Because signing happens inside the page there is no wallet pop-up on this path: every transaction is preceded by a plain statement, a simulation from the user's own address and (for the swap) a trace of where each token would go, and it is sent only when the visitor presses that transaction's button. The wallet-extension path is unchanged and still never sees a key.

- **AUSD balance** next to MON and USDC (AUSD is Agora's dollar stablecoin, 6 decimals).
- **Swap USDC to AUSD through Kuru Flow**: an exact-amount approval to the Flow router, then the swap, at most 15 USDC. The quote's transaction is decoded and guarded (router address, tokens, amount, a minimum output), simulated, traced (the only token leaving the user is exactly the USDC amount and at least the minimum AUSD arrives at the user), and afterwards the balances are re-read and must match.
- **Planting with a passkey**: after signing in, the Plant tab offers "Passkey (Mera)" next to the browser wallets; the engine is the same.
- **PWA shell**: a web manifest, icons made from the logo and a service worker that caches only the page's own static files (never the RPC or any API). The page can be added to the home screen.
- A passkey account is bound to the page's host (`owenzhao9.github.io`); it is never to be changed once accounts exist.
- Tests use a stub passkey with fixed bytes and the fake chain; signed transactions are compared with `ethers`. **Nothing has been tried with a real passkey or real money**: [`docs/PASSKEY-TEST-RUNBOOK.md`](docs/PASSKEY-TEST-RUNBOOK.md) is the first real run. A test page with a stub passkey: `web/passkey-fake.html` (build with `npm run build:passkey-fake` in `web/`).

## The hedge (built, not yet verified with real money)

`#hedge` offsets the MON that flip orders leave you holding with a **short on Perpl's MON perpetual**, and closes it again. The visitor picks a hedge ratio (default 50%, whole MON, at least 1); the page shows the short size, the collateral needed at 2x, an estimated liquidation price, the funding cost, and the cost of opening and closing, each labelled as measured, from the chain, or an estimate. Orders are immediate-or-cancel with a 1% price bound; before every signature the transaction is simulated from the user's own address and traced, and afterwards the receipt and the chain are compared with the plan, including a partial or empty fill. Hard caps: 15 USD of hedge, 2x, 15 AUSD deposited, shorts on the MON market only; everything else is refused by a decoder-based guard. It signs with a browser wallet or the passkey session. The things we measured about funding (every 8,571 blocks, about 43 minutes, rate / 100,000 of notional), collateral (mark-price rule) and fees are in [`docs/PERPL-ONCHAIN.md`](docs/PERPL-ONCHAIN.md); the first real run: [`docs/HEDGE-TEST-RUNBOOK.md`](docs/HEDGE-TEST-RUNBOOK.md). Tests use a fake wallet and a fake Perpl chain; a test page is `web/fake-hedge.html`.

## Verified on Monad mainnet with real funds (2026-10-10)

One flip order, end to end, on Kuru's MON-USDC market:

1. A 201 MON flip bid was placed one tick below the best ask.
2. About 0.6 seconds (two blocks) later a taker filled it completely.
3. In the same block Kuru created the opposite sell order for the same size, 0.1% higher, under a **new order id**. No keeper or bot was involved.
4. We cancelled the sell order and withdrew everything.
5. Ledger against chain: wallet + free margin + value locked in orders changed by exactly what the fills and fees explain. **USDC difference 0, MON difference 0.**

The five transactions we sent cost 0.095135 MON in network fees in total (about $0.002). The whole test, including a small mark-to-market loss after the fill, cost under two cents.

| Step | Transaction | Block |
|---|---|---|
| Approve exactly 6 USDC | [`0xf2db05f0…3473f6`](https://monadscan.com/tx/0xf2db05f02ad32ae4328f71d73b0ed52c70e7b51ebc874817b61bffa36b3473f6) | 112,209,469 |
| Deposit 6 USDC into Kuru margin account | [`0xb4ffee50…62fd14`](https://monadscan.com/tx/0xb4ffee502b6f7a642844adb79bdb8de6af99e52f0d79902b507e75476862fd14) | 112,209,491 |
| Place the flip bid (201 MON) | [`0x103f12c1…420130`](https://monadscan.com/tx/0x103f12c198e7ecc9e33bb134758dc40fdb91913e33ac1f09ed9d2c16e8420130) | 112,210,402 |
| Taker fills it; Kuru creates the opposite sell order (taker’s transaction) | [`0xa0c74eea…7843ce`](https://monadscan.com/tx/0xa0c74eea7815db940c4009be76efa1d4d64e842d3a5a6f5f1b6bfc4a0b7843ce) | 112,210,404 |
| Cancel the sell order | [`0xe9655226…9fb411`](https://monadscan.com/tx/0xe9655226bb20b0691aa2904d3eadea86fdd38b325005adf1f490c3e0049fb411) | 112,211,494 |
| Withdraw all margin balances | [`0x1abba8c7…b54002`](https://monadscan.com/tx/0x1abba8c725c9e4bd06a9c4b5ef16cc508905793ee417404b7eff7306ecb54002) | 112,211,503 |

Test wallet: [`0x39Fd…DA38`](https://monadscan.com/address/0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38) (a throwaway wallet, public on-chain data only). Explorer: Monadscan, listed in the official Monad docs.

The same data lives in [`test/fixtures/gate-test-2026-10-10.json`](test/fixtures/gate-test-2026-10-10.json) and is asserted by the test suite.

### What we learned on-chain

- The minimum order on MON-USDC is 200 MON (about $5 at the time), so every price level costs at least roughly $5.
- `Trade.isBuy` describes the **taker's** side, not the maker order's. A resting bid hit by a seller shows `isBuy = false`.
- A filled flip order produces a **new order id** for the opposite order; its size equals the filled size and its own flip price is the original price, so the loop continues.
- Monad charges gas by the gas limit: receipts report `gasUsed == gasLimit`, and the wallet's MON balance fell by exactly the sum of `gasLimit x gasPrice`.
- Cancelling an order that came out of a flip works with Kuru's flip-cancel method (`batchCancelFlipOrders`).
- Maker and taker fees read 0 bps on the two markets we saw. Partial fills and `FlipOrderUpdated` were not part of our own test, but a seven-day read-only scan found one other account using flip orders on Monad, and its real transactions pin both behaviors down (see [`docs/LEDGER.md`](docs/LEDGER.md)). Behavior with non-zero fees is still unverified.

### The ledger invariant

`net worth = wallet + free margin + value locked in open orders`

Depositing, withdrawing, placing and cancelling only move value between those three buckets, so net worth changes only through fills, fees and gas. [`lib/reconcile.cjs`](lib/reconcile.cjs) checks exactly that, and [`test/fixture.test.cjs`](test/fixture.test.cjs) proves it against the real data above.

## Repository

| Path | What it is |
|---|---|
| `src/` | The ledger core in TypeScript, dependency-free: event decoding, exact-rational units, order and flip-chain tracking, balances (free and locked), fills, fees, gas, realized and unrealized profit and loss, reconciliation, and a resumable log scanner. Runs directly on Node, no build step |
| `docs/LEDGER.md` | Ledger design: data model, formulas, rounding rules, event semantics and the list of what is still unknown |
| `src/abi.ts`, `src/plant.ts`, `src/flow.ts` | Planting: calldata encoders, hard caps, ladder and preview maths, the transaction guard, and the engine (simulate, announce, one pop-up, receipt, verify) |
| `lib/units.cjs` | Exact-integer unit conversion and the flip-bid price ladder (BigInt, no floating point) |
| `lib/reconcile.cjs` | Reconciliation of fills, fees and gas against balances |
| `scripts/gate.cjs` | Command-line tool used for the real-funds test: `preflight`, `deposit`, `plant`, `status`, `unwind`, `report`. Dry run by default |
| `scripts/new-wallet.cjs` | Generates a throwaway test wallet, only in an interactive terminal, so the key cannot leak into logs or tool output |
| `web/` | The page: the read-only ledger and the planting flow (plain TypeScript, bundled with esbuild; imports `../src`, no copied code). `web/fake.html` is a test page with a fake wallet |
| `test/` | Unit tests and the real-data fixture |
| `docs/GATE-TEST-RUNBOOK.md` | How to reproduce the real-funds test |
| `docs/PLANT-TEST-RUNBOOK.md` | How the owner does the first real run of the browser planting flow |
| `docs/FINDINGS.md` | Verified facts and open questions, with the evidence for each |
| `CLAUDE.md`, `docs/STAGE-C-BRIEF.md` | Working notes for the AI-assisted development of this repository |

## Try it (read-only, no keys needed)

Requires Node 22.18 or newer (the TypeScript core runs directly, no build step).

```bash
npm install
npm test
export ADDRESS=0xYourWalletAddress   # optional, only to show balances
node scripts/gate.cjs preflight
node scripts/gate.cjs plant --sim-funds   # preview and simulate an order without any funds
```

`preflight` and the dry runs only read the chain. Anything that sends a transaction needs `--live`, a typed `YES`, and a private key in an environment variable (see the runbook). Hard caps on deposit size and order count live in [`config/kuru.mainnet.json`](config/kuru.mainnet.json). Keys are never stored: `state/` and `.env*` are git-ignored.
