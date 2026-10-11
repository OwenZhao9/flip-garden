# Flip Garden: notes for Claude working in this repository

A Monad hackathon project: a gamified retail liquidity tool built on Kuru flip orders. The user is not technical; treat them as an executive who wants the conclusion first.

## Language
- **Reply to the user in Chinese.** Everything written into the repository (code, comments, docs, commit messages, README, UI text, test names) and everything submitted to the hackathon platform must be in **English**. Never put Chinese text into a file of this repository.
- Start every reply with the conclusion. Give one recommendation at a time (at most two, with a clear pick). Do not narrate process or pile up tables. Explain jargon in one sentence the first time it appears.
- Do not talk about deadlines or days remaining. Do not invent precision (scores, probabilities, percentages). Label anything unverified as unverified.
- If the user is in the middle of an action, do not start new research; answer their question first.

## Funds and keys (hard rules)
- Private keys never enter the conversation: never read, print or store them. Never run a command with `--live`, and never make a transfer, swap, withdrawal or any other on-chain write for the user.
- Give any command that involves a private key as a ```text block only (never ```bash: the Run button in the chat executes it in the app's own terminal and the output lands in the conversation) and tell the user to paste it into the macOS Terminal app. Never read the user's terminal panel.
- Read-only commands (`preflight`, `status`, `report`, balance checks) may be run on the user's behalf.
- Ask before installing any dependency. Ask before deploying, publishing, changing repository settings or inviting anyone.

## Where things stand
- Verified on-chain facts and test results: `docs/FINDINGS.md`. Ledger design: `docs/LEDGER.md`.
- Full progress notes (the user's own, kept outside the repository): `~/.claude/skills/hackathon-idea/SKILL.md`. It is long; read only from line 428 to the end (the execution plan and what followed).
- Done: the real-funds gate test (stage B), the TypeScript ledger core in `src/` (stage C), and the read-only ledger page in `web/` (stage D, milestone 1), live at https://owenzhao9.github.io/flip-garden/ with 59 tests in total. The repository is public: https://github.com/OwenZhao9/flip-garden
- Current task: stage D, milestone 2, the planting flow (wallet connection and real orders, so the safety boundary in the brief is binding). See `docs/STAGE-D2-BRIEF.md`. Run it on Sonnet 5.5. A push to `main` redeploys the public page.
- Workflow: each stage runs in its own session inside a git worktree, with small commits on its own branch. Commit messages end with `Co-Authored-By: Claude <model name> <noreply@anthropic.com>`. Do not push unless the user asks. When done, write progress into the notes and tell the user; the main session merges.
- Node 22.18 or newer. The core runs `.ts` files directly with `node --test` (type stripping, no build step).
