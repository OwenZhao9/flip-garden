# Leaderboard service (brief for a second AI working in parallel)

Flip Garden is a web app on Monad (repository root: this folder). Its ledger core in `src/` reads a wallet's Kuru flip-order history from the chain and computes orders, fills and completed round trips. This task is a **small read-only service** that ranks gardens. It lives only in a new folder, `server/`, and is deployed by the owner to Cloudflare Workers. It never holds a key and never sends a transaction.

## What the service does

- `POST /register` with `{ "address": "0x…", "startBlock": 123 }`: a wallet opts in to be ranked. Validate both fields strictly; a start block must not be older than the Kuru MON-USDC market's first block and not in the future.
- `GET /leaderboard`: the ranked list, each row `{ rank, address (shortened as 0x1234…abcd), completedRoundTrips, gardenAgeDays, level, updatedAt }`.
- `GET /garden/:address`: the same figures for one registered wallet.
- A scheduled job (Cron Trigger) that, per registered wallet, **resumes** scanning the chain from a stored cursor and recomputes the figures with the ledger core. Never trust a client-supplied number: every figure comes from chain data.

**Ranking** (decided by the owner): by completed round trips, then by garden age in days. **Not by profit** (small amounts make profit noise and ranking by it rewards risk). A completed round trip is a flipped sell order that filled completely and flipped back into a buy, as counted by the ledger core. Garden age is the number of days since the wallet's first flip-order creation event on the market. Be aware that the full round trip has not yet been seen in our own real tests, so label this in the API as `"verifiedOnRealData": false` until a real example exists.

The level is a pure function of round trips and age (Seed, Sprout, Bloom, Orchard; pick simple thresholds and document them); put it in one function with tests so the web page can import the same code.

## Rules of the platform to design for

- Cloudflare Workers. The Free plan allows 100,000 requests a day, 10 ms CPU per request and 50 outgoing requests per request; the Paid plan ($5 a month) allows 5 minutes CPU and 10,000 outgoing requests per request (read from Cloudflare's docs, 2026-10-11). Design the scan to be **resumable and incremental** (small batches per cron run, a cursor per wallet in Workers KV), so it also works within the Free limits if the work per run is kept small.
- The public RPC `https://rpc.monad.xyz` accepts at most about 100 blocks per `eth_getLogs` call; use at most 90, as the existing scanner does (`src/scan.ts`, `src/rpc.ts`).
- Answer CORS only for `https://owenzhao9.github.io` (and `http://localhost:*` for development). Add basic rate limiting and input limits; cap the number of registered wallets (propose 500) and say so.
- Store only: the public address, the start block, the scan cursor and the computed figures. No personal data, no IP addresses, no keys.

## Deliverables

1. `server/` containing the Worker (TypeScript), `wrangler.toml` without any secret or account id, and a `README.md`.
2. Import the ledger core by relative path from `../src` (do not copy code); do not edit anything outside `server/`, `test/leaderboard-*.test.ts` and `docs/LEADERBOARD*.md`.
3. Tests with `node --test` (no new dependency): validation, ranking and tie-breaks, level thresholds, CORS, the resumable scan against the real-data fixtures in `test/fixtures/` (for example `gate-test-2026-10-10.json`) with a fake KV and a fake RPC. No test calls the real network.
4. `docs/LEADERBOARD-DEPLOY.md` for the owner (not for an AI): step-by-step deployment with `wrangler` run in the macOS Terminal app, including `wrangler login` (browser sign-in by the owner), creating the KV namespace, setting the cron schedule, and checking the three endpoints. Never ask the owner to paste a token or key into a chat.
5. A short section appended to `docs/FINDINGS.md` and the notes file named in `CLAUDE.md`.

## Red lines

- Do not create accounts, deploy, publish, push, change repository settings, or run anything with `--live`. No private key is ever read, printed or stored.
- Read-only chain calls only. Do not touch `web/`, `scripts/`, `lib/`, `state/`, or existing tests; all existing tests must keep passing (`npm test`).
- No new runtime dependency without asking the owner.
- Everything written into the repository (code, comments, docs, commit messages, test names) is English. Reply to the owner in Chinese, conclusion first, explain jargon in one sentence.
- Work in a separate git worktree or branch (for example `leaderboard`) with small commits, and tell the owner when it is ready to merge.
