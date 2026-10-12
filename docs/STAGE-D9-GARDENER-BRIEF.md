# Stage D, milestone 9: the Gardener agent with Jev (brief for a session)

Read first: `CLAUDE.md`, `docs/GARDENER-AGENT-PLAN.md` (the design and the review it went through), `docs/FINDINGS.md` (real-money runs), `docs/STAGE-D2-BRIEF.md` (safety boundary), `src/flow.ts`, `src/plant.ts`, `src/perpl/`, `web/src/plant.ts`, `web/src/hedge.ts`, `web/src/session.ts`, `server/`.

Two other sessions run in parallel: bounties (`docs/STAGE-D7-BOUNTIES-BRIEF.md`, makes Mera the only account layer) and art (`docs/STAGE-D8-ART-BRIEF.md`). Put your code in new files (`src/gardener/`, `web/src/gardener*.ts`, one new Worker endpoint) and keep edits to shared files small.

## Decisions already taken by the owner

- Authorisation changes from "confirm every transaction" to **a mandate the user confirms once**: amounts (USDC and AUSD, within the existing caps), a price range, allowed actions, an expiry (default 1 hour, at most 24 hours), a maximum number of transactions and of network fees per hour, and a Stop button that halts everything at once. Inside the mandate the Gardener acts; anything outside becomes the normal confirmation card.
- The Gardener runs only while the page is open and the passkey session is signed in, and the page says so plainly.
- Safety is code, not the model: mandate, amounts, prices, stop conditions (stale data, wide spread, low balance, budget or time exhausted) are deterministic code. Jev only chooses among options the code allows; its confidence only decides "act now" versus "ask the user". The existing guard, simulation and on-chain verification stay the last gate, unchanged.
- Jev is used only if it beats a rules-only Gardener on the same recorded real market data. If it does not, ship the rules-only Gardener and say so to the owner.

## Scope (what flip orders cannot do by themselves)

1. Recover after a failed move or plant (the 2026-10-11 Move lost a race with the market).
2. Re-place an order that has left the user's price range.
3. Keep the hedge ratio inside the range the user set.
4. Harvest idle money.
5. Keep enough MON for the network fees of cancels and hedge closes.

## Steps

1. Read the Jev docs (docs.typesafe.ai: quick start, request and response format, confidence, limits, terms, data handling) in Chrome and write the facts with dates into `docs/JEV.md`. Decide which fields of state are sent; send nothing that is not needed.
2. Rules-only Gardener: a pure policy (mandate checks, stop conditions, cool-downs) and the decision questions with fixed options, each turned into an exact transaction by code. Tests first.
3. Replay harness on the recorded real data (`test/fixtures/`, and the 2026-10-11 wallets read from the chain): what each Gardener would have done block by block; metrics: fills, time an order spent out of range, failed transactions, network fees.
4. Jev behind a new Worker endpoint (`POST /decide`), the API key as a Worker secret that the owner sets in the macOS Terminal (`wrangler secret put JEV_API_KEY`), never in the page, a file or the chat. Validate every answer; time out at 2 s; on any problem do nothing.
5. Compare rules versus Jev in the replay; write the numbers into `docs/FINDINGS.md`.
6. UI: a Gardener switch, the mandate card, status (watching, acting, waiting for you, stopped), remaining budget and expiry, Stop, and a Gardener timeline in the ledger (action, reason, option chosen, confidence, transaction link, verification).
7. A runbook for the owner's real-money round: a mandate of at most 5 USD for 1 hour.

## Red lines

- The session never signs or sends a transaction and never uses a key; the fake wallet and fake chain are used in tests, plus a fake Jev with scripted answers.
- Do not change the guard caps, the allow-lists, the ledger or the verified post-conditions; the Gardener goes through `sendStep` like every other transaction.
- No new runtime dependency without asking the owner. Do not push, deploy or change repository settings (deploying the Worker endpoint is the owner's step).
- Everything in the repository is English; texts about the project say only what it is and does. Reply to the owner in Chinese, conclusion first. Work on its own branch in a git worktree with small commits; tell the owner when done.
