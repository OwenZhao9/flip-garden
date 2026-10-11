# Flip Garden

Flip Garden is a garden-style game on Monad that lets anyone plant a few dollars as Kuru flip orders, watch real fills, and read an honest ledger of every gain and loss.

> **Status: work in progress.** The on-chain loop is verified with real funds on Monad mainnet (see below). The ledger core (event decoding, flip chains, profit and loss, reconciliation) is built and tested; the game interface comes next.

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
- Mobile layout is written (single column, 16px text) but has only been checked on a desktop browser so far (unverified on a phone).

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
| `lib/units.cjs` | Exact-integer unit conversion and the flip-bid price ladder (BigInt, no floating point) |
| `lib/reconcile.cjs` | Reconciliation of fills, fees and gas against balances |
| `scripts/gate.cjs` | Command-line tool used for the real-funds test: `preflight`, `deposit`, `plant`, `status`, `unwind`, `report`. Dry run by default |
| `scripts/new-wallet.cjs` | Generates a throwaway test wallet, only in an interactive terminal, so the key cannot leak into logs or tool output |
| `web/` | The read-only ledger page (plain TypeScript, bundled with esbuild; imports `../src`, no copied code) |
| `test/` | Unit tests and the real-data fixture |
| `docs/GATE-TEST-RUNBOOK.md` | How to reproduce the real-funds test |
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
