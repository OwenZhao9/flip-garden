# Flip Garden leaderboard service

A small, read-only Cloudflare Worker that ranks registered gardens. It never holds a key and never sends a transaction. Every figure is computed from public chain data with the ledger core in `../src` (imported by relative path, not copied).

## Endpoints

| Route | What it does |
|---|---|
| `POST /register` | Body `{ "address": "0x…", "startBlock": 123 }`. Opts a wallet in. The start block must be a whole number, not older than `MARKET_FIRST_BLOCK` and not in the future (checked against the chain head). Registering twice is harmless; the first start block stands. Body limit 512 bytes. |
| `GET /leaderboard` | `{ ranking, updatedAt, rows: [{ rank, address (0x1234…abcd), completedRoundTrips, gardenAgeDays, level, updatedAt }] }`. Served from one precomputed KV key. |
| `GET /garden/:address` | The same figures for one registered wallet, plus `scannedTo` and `catchingUp`. |


## Ranking

By completed round trips (more first), then garden age in days (older first), then by address so the order never flips between runs. Equal round trips and equal age share a rank. **Profit is never an input.** Wallets that have not been scanned yet are not listed.

- A completed round trip is counted by `plotsOf` in `src/garden.ts`: a plot whose flip chain has two completed legs counts one (a leg filled completely, then its flipped opposite leg filled completely). This has not yet been seen on real chain data.
- Garden age is whole days between the timestamp of the block of the wallet's first flip-order creation and the timestamp of the last block scanned, both read from the node. No block time is assumed.
- Level: `levelOf` from `src/garden.ts`, the same function the web page uses. Sprout = one round trip or one day; Bloom = three round trips and three days; Orchard = ten round trips and seven days. These are game design, not measurements.

## The scheduled scan

A Cron Trigger (every 5 minutes) runs `runScheduled`:

1. Wallets are visited oldest-figures first.
2. For each, the scan **resumes from the stored cursor** in windows of at most 90 blocks (the public RPC rejects ranges above about 100), merges logs by `(tx, logIndex)` and moves the cursor only after a window is merged. A failure keeps the windows already merged.
3. One run makes at most `MAX_RPC_CALLS_PER_RUN` outgoing requests in total (default 40, safe for the Free plan's 50). A window costs 2 requests (market and MarginAccount logs), so a long history is caught up over several runs.
4. When new logs arrive, the ledger is rebuilt and the figures recomputed. The board is rewritten at the end of every run.

## What is stored (KV)

| Key | Content |
|---|---|
| `w:<address>` | public address, start block, registration time, scan cursor, `catchingUp`, the first-planting block timestamp, computed figures |
| `s:<address>` | the wallet's own Kuru event logs as returned by the chain (public chain data), needed to recompute the ledger incrementally |
| `index` | list of registered addresses (capped at `MAX_WALLETS`, default 500) |
| `board` | the ranked rows |
| `market` | the market parameters, read once |

No IP address, no user agent, no personal data, no key. The brief asked to store only the address, start block, cursor and figures; the raw logs under `s:` are an addition the incremental ledger needs (see "Decisions" below).

## Platform limits and what they mean

- Free plan: 100,000 requests a day, **10 ms CPU per request**, 50 outgoing requests per invocation. Rebuilding a ledger for a wallet with a long history may exceed 10 ms of CPU; this was **not measured on Cloudflare**. If a cron run is cut off, lower `MAX_RPC_CALLS_PER_RUN` or move to the Paid plan ($5 a month, 5 minutes CPU). Read the figures in `docs/LEADERBOARD-DEPLOY.md`.
- KV is not transactional: two registrations in the same instant can pass the 500 cap by a few. The cron job never ranks more than `MAX_WALLETS`.
- The in-memory rate limiter is per Worker instance and global (it stores no IP). For per-client limits add a Cloudflare rate limiting rule in the dashboard.

## Decisions for the owner

1. Raw logs are stored (`s:` keys) in addition to the figures. They are public on-chain data of a public address. The alternative, storing only figures, would force a full rescan from the start block every run.
2. `MARKET_FIRST_BLOCK` is an **unverified placeholder** (110298080, the earliest block of any Kuru flip-order data we hold). The public RPC does not serve old state, so the market's creation block could not be looked up.

## Tests

`npm test` runs `test/leaderboard-pure.test.ts` (validation, ranking, levels, CORS, limiter) and `test/leaderboard-service.test.ts` (registration, cron, resumability, failure recovery, age from timestamps, limits) on the real recorded logs with a fake KV and a fake chain. No test touches the network.
