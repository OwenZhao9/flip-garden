# Stage D, milestone 3: the Agora path (Mera login, AUSD, Perpl hedge)

Context: the owner decided to pursue the Agora "Best Mobile Trading App on Monad" bounty. Read `docs/AGORA-FEASIBILITY.md` first (what is verified, what is not). The product idea, which is ours and unvalidated, is the **hedged garden**: the MON that flip orders pile up is offset by a short on Perpl's MON perpetual, so the three required integrations serve one story. The app is a mobile-first web app (PWA); whether the bounty accepts a web app is unconfirmed and the owner chose to proceed anyway.

## Phases

| Phase | What | Who | Depends on |
|---|---|---|---|
| 0 | Perpl direct on-chain spike (read-only): decide relay or direct, build tested encoders | its own session (Sonnet 5.5) | nothing; runs in parallel with milestone 2 |
| 1 | Mera login, a signer abstraction shared with the planting flow, AUSD funding through Kuru Flow, PWA shell | new session | milestone 2 merged |
| 2 | Perpl account, deposit, hedge order, unwind; hedge view in the garden and the ledger | new session | phases 0 and 1 |
| 3 | The owner's own real-money run (runbook), an independent review against the safety rules, merge, push, demo script | owner and main session | phase 2 |

Only phase 0 is specified below. Phases 1 and 2 get their own briefs when phase 0 has answered the open questions.

## Phase 0: Perpl direct on-chain spike (read-only)

### Goal

Find out whether the page can talk to Perpl **directly on chain** (a signed transaction to the exchange contract through the public Monad RPC) so that no relay server is needed, and deliver tested building blocks either way. Background: Perpl's REST and WebSocket interfaces refuse a third-party web page (verified, see the feasibility doc), while the Monad RPC and Kuru Flow accept one. Perpl's order primitives are on-chain (OpenLong, OpenShort, CloseLong, CloseShort), about 100k gas to post.

### Deliverables

1. **The contract interface**, with its source recorded (URL and commit): signatures and events for account creation and deposit, posting the four order types, cancel and change, withdraw, and the views needed to read an account, its positions and its open orders. Read `github.com/PerplFoundation/dex-sdk` (Rust; the interface is in or generated from the crates), `github.com/PerplFoundation/api-docs`, and `docs.perpl.xyz` (append `/llms-full.txt` for the whole text). Mainnet exchange: `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`, AUSD: `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` (6 decimals), MON market id 10 (size in whole MON, 6 price decimals). Store what you need under `config/` and `src/perpl/`.
2. **Dependency-free TypeScript encoders** in `src/perpl/` for AUSD `approve`, account creation with the minimum deposit (10 AUSD on mainnet, read it from `GET /api/v1/pub/context` or the contract, never hard-code), the four order types, cancel, and withdraw. **Differential tests against `ethers`** (already a root dependency; tests only, never in a bundle) including selectors.
3. **Read-only simulations** with `eth_call` from a throwaway address with state overrides (AUSD balance and allowance), in the style of `scripts/gate.cjs preflight`: account creation succeeds; an OpenShort on the MON market succeeds; controls fail as expected (no account, below the minimum, a price outside limits). Put the output in `docs/PERPL-ONCHAIN.md` with dates and block numbers.
4. **A read model** (`src/perpl/state.ts`): how to read a wallet's account, positions, open orders and fills from the public RPC (logs are limited to about 100 blocks per request) with the existing resumable scanner where it helps. Tests with fixtures taken from live read-only calls.
5. **Hedge maths** as pure integer functions with tests: given a MON inventory (18 decimals), a hedge ratio in basis points and the market config, return the short size (whole MON, at least 1), the margin needed at a chosen leverage, and an estimated liquidation price; fees and funding as stated by the docs, with the fee units verified from the docs or the contract before use.
6. **The decision**, written in `docs/PERPL-ONCHAIN.md`: direct on-chain works or does not, with the evidence. If it does not, outline the smallest relay (only forwards signed requests, cannot sign, holds no secret) but **do not build or deploy it**.

### Red lines

- No transaction, no key, no `--live`. Do not create an account on Perpl, enroll an API key, or call any authenticated endpoint. Public reads and `eth_call` simulations only.
- Do not touch `web/` (milestone 2 is working there), `scripts/gate.cjs`, `lib/`, `state/`, or the behaviour of existing `src/` code. Add new files only; all existing tests must keep passing.
- No new runtime dependency (ask first if you think one is unavoidable).
- Do not push, deploy or change repository settings.
- Everything written into the repository is English. Reply to the user in Chinese, conclusion first.

### When finished

`npm test` is green; findings recorded in `docs/PERPL-ONCHAIN.md` and `docs/FINDINGS.md` (append a short section) and in the notes; tell the user whether direct on-chain works, what it means for hosting, and what phase 1 needs.

## Safety rules that change in phase 1 (approved by the owner on 2026-10-11)

With Mera the page holds a derived key in memory during one signing session. The rule in `docs/STAGE-D2-BRIEF.md` ("the page never sees a private key") becomes, for the Mera path only: **the key exists only in memory for one signing session and is never stored, logged or sent, and every transaction still needs a preview, a simulation and the owner's explicit confirmation.** Hard caps stay in force, the guard on every decoded call stays, and the AI sessions still never sign or send anything. The wallet-extension path keeps the original rule.

New dependencies approved by the owner on 2026-10-11 for phase 1: `@category-labs/mera`, `viem`, `@scure/bip32` and `@scure/bip39` (the two small packages the Mera recipe uses). Pin exact versions (no `^` or `~`), commit the lockfile, and check each version's publish date and changelog before choosing it. No other dependency without asking.
