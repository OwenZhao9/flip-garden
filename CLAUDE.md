# Flip Garden: notes for Claude working in this repository

A Monad hackathon project: a gamified retail liquidity tool built on Kuru flip orders. The user is not technical; treat them as an executive who wants the conclusion first.

## Language
- **Reply to the user in Chinese.** Everything written into the repository (code, comments, docs, commit messages, README, UI text, test names) and everything submitted to the hackathon platform must be in **English**. Never put Chinese text into a file of this repository.
- Start every reply with the conclusion. Give one recommendation at a time (at most two, with a clear pick). Do not narrate process or pile up tables. Explain jargon in one sentence the first time it appears.
- Do not talk about deadlines or days remaining. Do not invent precision (scores, probabilities, percentages). Label anything unverified as unverified.
- If the user is in the middle of an action, do not start new research; answer their question first.

## Texts about the project (platform, pitches, progress updates)
- State only what the project is, what it does and what concretely exists or happened. No evaluative commentary: no "not yet verified", "not tested", "honest note", "bugs found", "hypothesis". Keep caveats and bug history in `docs/FINDINGS.md` and in chat, never in submitted text. Do not imply anything that did not happen.

## Funds and keys (hard rules)
- Private keys never enter the conversation: never read, print or store them. Never run a command with `--live`, and never make a transfer, swap, withdrawal or any other on-chain write for the user.
- Give any command that involves a private key as a ```text block only (never ```bash: the Run button in the chat executes it in the app's own terminal and the output lands in the conversation) and tell the user to paste it into the macOS Terminal app. Never read the user's terminal panel.
- Read-only commands (`preflight`, `status`, `report`, balance checks) may be run on the user's behalf.
- Ask before installing any dependency. Ask before deploying, publishing, changing repository settings or inviting anyone.

## Where things stand
- Verified on-chain facts and test results: `docs/FINDINGS.md`. Ledger design: `docs/LEDGER.md`.
- Full progress notes (the user's own, kept outside the repository): `~/.claude/skills/hackathon-idea/SKILL.md`. It is long; read only from line 428 to the end (the execution plan and what followed).
- Done: the real-funds gate test (stage B), the TypeScript ledger core in `src/` (stage C), the read-only ledger page in `web/` (stage D, milestone 1, live at https://owenzhao9.github.io/flip-garden/), the planting flow (milestone 2, merged into local `main`, run once with real money on 2026-10-11 and reconciled, see `docs/FINDINGS.md`; repeat with `docs/PLANT-TEST-RUNBOOK.md`) and the read-only Perpl spike (milestone 3, phase 0, `docs/PERPL-ONCHAIN.md`); 121 tests in total. The repository is public: https://github.com/OwenZhao9/flip-garden
- Current tasks, run in parallel from the merged `main`: the Perpl hedge (`docs/STAGE-D3-PHASE2-BRIEF.md`), the garden game layer and fixes (`docs/STAGE-D5-BRIEF.md`), and the leaderboard service in `server/` (`docs/LEADERBOARD-BRIEF.md`, may be done by a second AI). Phase 1 (Mera login, shared signer, AUSD swap, PWA shell) and the restyle are merged.
- Earlier current task (done): milestone 3 phase 1 (Mera login, shared signer, AUSD funding, PWA shell), see `docs/STAGE-D3-PHASE1-BRIEF.md`. The restyle (milestone 4) is merged and live. Anything that holds a key or sends a transaction keeps the safety boundary in `docs/STAGE-D2-BRIEF.md`. Run sessions on Sonnet 5.5. A push to `main` redeploys the public page.
- Also planned: stage D, milestone 4, restyling `web/` with the Stitch design (`docs/STAGE-D4-BRIEF.md`; the design export goes into `design/stitch/`). Do not run it in parallel with milestone 3 phase 1, both rewrite the page.
- Also planned: stage D, milestone 3, the Agora path (Mera login, AUSD, Perpl hedge). Phase 0, a read-only Perpl spike that runs in parallel and touches only new files under `src/perpl/`, is specified in `docs/STAGE-D3-BRIEF.md`; background in `docs/AGORA-FEASIBILITY.md`.
- Workflow: each stage runs in its own session inside a git worktree, with small commits on its own branch. Commit messages end with `Co-Authored-By: Claude <model name> <noreply@anthropic.com>`. Do not push unless the user asks. When done, write progress into the notes and tell the user; the main session merges.
- Node 22.18 or newer. The core runs `.ts` files directly with `node --test` (type stripping, no build step).
