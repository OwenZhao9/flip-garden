# Stage D, milestone 7: Envio, Aurora and Mera as the account layer (brief for a session)

Read first: `CLAUDE.md`, `docs/FINDINGS.md`, `docs/STAGE-D2-BRIEF.md` (safety boundary), `docs/STAGE-D3-PHASE1-BRIEF.md` (Mera), `src/scan.ts`, `src/rpc.ts`, `web/src/pipeline.ts`, `server/`, `web/src/passkey.ts`, `web/src/plant.ts`, `web/src/hedge.ts`.

Two other sessions run in parallel: the art pass (`docs/STAGE-D8-ART-BRIEF.md`, owns `web/src/garden-art.ts`, `garden-style.ts`, `garden-fx*.ts`, `design/art/`) and the Gardener agent (`docs/STAGE-D9-GARDENER-BRIEF.md`, owns new files under `src/gardener/` and `web/src/gardener*.ts`, plus one new Worker endpoint). Keep your edits to shared files (`web/src/main.ts`, `web/src/ui.ts`, `web/style.css`, `web/src/plant.ts`, `web/src/hedge.ts`) small.

## Step 0: read the three bounty pages first

Open each sponsor bounty on https://hackathon.monad.xyz/tracks in Chrome (the owner is signed in) and write the exact requirements, judging criteria and deliverables into `docs/BOUNTIES.md`: Envio, Aurora, Mera. Also read the sponsor docs they link. If a requirement cannot be met naturally (for example Aurora does not support a route we need), stop that part and report to the owner instead of forcing it.

## 1. Envio: fast history

Problem today: the public RPC allows about 90 blocks per `eth_getLogs`, so a long ledger read is slow and the leaderboard needed hours to catch up a wallet with an old start block. Use Envio (HyperSync or HyperIndex, whichever the bounty asks for and Monad supports) to fetch a wallet's Kuru events in one go, behind the existing `LogSource` interface in `src/scan.ts`, with the public RPC as the fallback. The ledger must reconcile identically from either source; add a test that the same fixture gives the same ledger. Use it in the web ledger and in the leaderboard Worker. Measure and record the speed-up on the real wallets in `docs/FINDINGS.md`. Any API token belongs in the Worker as a secret set by the owner in the macOS Terminal; never in the page or the chat.

## 2. Aurora: deposit from another chain straight into a garden

Problem today: funding a test wallet meant bridging from BNB Chain with a separate tool and several transfers. Build "deposit from another chain and plant" with Aurora's product as the bounty defines it, so one flow moves funds to the user's Monad account and then hands over to the existing planting preview. Every transaction is still previewed, simulated where possible, confirmed by the user and verified on chain; add the new transaction kinds to the guard with an allow-list and caps. If Aurora's flow sends from a wallet on another chain, that wallet signs in its own pop-up.

## 3. Mera as the whole account layer

The Gardener agent signs with the passkey session; a browser wallet would ask for a pop-up on every transaction. Make Mera (passkey) the account layer of the app: sign-in on first visit, one account for Plant, Hedge, Board and the Gardener. Remove the browser-wallet connect buttons from the user flow (keep the code path only if the bounty text allows it, otherwise remove it and its tests cleanly). Read what the bounty means by a "stateless" test and make the app pass it. The read-only Ledger tab keeps working without signing in.

## Red lines

- The session never signs or sends a transaction, never uses a key, never moves money. Real-money checks are the owner's, described in a runbook.
- No new runtime dependency without asking the owner first (list name, version, size, why).
- Do not change the existing guard caps, the ledger logic or the verified post-conditions; extend them only for new transaction kinds.
- All tests keep passing. Do not push, deploy or change repository settings.
- Everything in the repository is English; texts about the project say only what it is and does. Reply to the owner in Chinese, conclusion first.

## Done means

`docs/BOUNTIES.md` with the requirements; the three features with tests; a runbook for the owner's real-money check of Aurora and of the passkey-only flow; findings and notes updated; work on its own branch in a git worktree with small commits; tell the owner, and the main session merges.
