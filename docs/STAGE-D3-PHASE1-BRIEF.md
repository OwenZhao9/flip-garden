# Stage D, milestone 3, phase 1: Mera login, a shared signer, AUSD funding, PWA shell (brief for a Sonnet 5.5 session)

Context: read `docs/STAGE-D3-BRIEF.md` (the plan and the owner's approvals), `docs/AGORA-FEASIBILITY.md` (what is verified) and `docs/PERPL-ONCHAIN.md`. The owner reports that the organizers confirmed a web app counts as a mobile application for this bounty (not independently verified by us); an iOS TestFlight build is a later bonus, not part of this phase.

## Goal

A visitor opens the page on a phone, signs in with a passkey (Face ID or Touch ID) through Mera, sees an **AUSD balance** next to MON and USDC, swaps a few dollars of USDC into AUSD, and can still plant and unwind exactly as today. The page can be installed to the home screen. **Nothing about the planting flow changes for visitors who use a wallet extension.**

## Approved by the owner (2026-10-11)

- The rule for the Mera path only: the key exists only in memory for one signing session and is never stored, logged or sent; every transaction still needs a preview, a simulation and the owner's explicit confirmation in the page. Caps, the guard on every decoded call and the "AI sessions never sign or send anything" rule stay.
- Four dependencies, exact versions, lockfile committed, inside `web/package.json` only: `@category-labs/mera`, `viem`, `@scure/bip32`, `@scure/bip39`. Check each version's publish date and changelog before choosing it. Nothing else without asking.

## Existing assets

`src/flow.ts` takes a wallet that speaks EIP-1193 (`request({method, params})`) and calls `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `wallet_switchEthereumChain`, `eth_sendTransaction`. `src/plant.ts` has the caps and `guardTx`. `web/` is the restyled page (`ui.ts`, `plant.ts`, `main.ts`). Mera's recipes: `mera.category.xyz/getting-started/` and `/recipes/send-a-transaction-with-viem/`. The relying-party id is the page's host; keep it `owenzhao9.github.io` (a passkey account is bound to it, so never change the host once accounts exist).

## Deliverables

1. **A Mera provider that speaks EIP-1193**, so the planting engine stays unchanged: `eth_requestAccounts` runs the passkey ceremony (create the passkey the first time, `getPasskeyPrfOutput` after), derives the account at `m/44'/60'/0'/0/0` as in the recipe, and opens a signing session; `eth_sendTransaction` signs with `toViemAccount` and broadcasts through the public RPC; chain methods answer for Monad mainnet only. The session ends (`session.end()`) on an explicit Lock button, after a short idle time (propose 5 minutes), on page hide, and on reload; the PRF output and the key are never written to storage, logs or the network. A visible "Signed in as 0x…, Lock" bar.
2. **Tests** with `node --test`: a stub passkey (fixed PRF bytes) gives a fixed address; signed transactions equal what `ethers` signs for the same key and fields (differential); the session ends on each trigger and signing afterwards fails; nothing sensitive reaches `localStorage`, `sessionStorage` or `fetch`; the existing engine tests run against the Mera provider with the fake chain. No test uses a real passkey, key or network write.
3. **AUSD**: show the AUSD balance (token `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 decimals) in the balances. **Swap USDC to AUSD through Kuru Flow** (`ws.kuru.io/api/quote` returns a ready transaction; both it and the Monad RPC accept calls from the page): first a read-only probe that decodes the returned transaction and records its target, function and approvals in `docs/FINDINGS.md`; then extend `guardTx` with the minimum extra allow-list (the router address from the Flow response, checked against `config/kuru.mainnet.json`'s router, exact USDC approval, caps of 15 USDC), the same simulate, announce, send, verify sequence (AUSD balance rose by at least `minOut`, USDC fell by exactly the amount), and the same one-pop-up-per-transaction discipline. If the probe shows the transaction cannot be checked safely, stop and report instead of widening the guard.
4. **PWA shell**: web manifest, icons generated from `design/logo/flip-garden-logo.png` (192, 512, maskable), `theme_color` from the tokens, and a service worker that caches only the static shell (never RPC or API calls) with a version that changes on deploy. Test installability with Chrome's own checks.
5. **UI** in the restyled components: a "Passkey" tab with sign-in, the lock bar, the AUSD balance and the swap form with preview. No Hedge screen yet.
6. **Docs**: README (what the passkey path is, its key rule in plain words, still unverified with a real passkey and real money), a runbook `docs/PASSKEY-TEST-RUNBOOK.md` for the owner's first real run on an iPhone (iOS 18 or later, Safari, iCloud Keychain) and in desktop Chrome with Google Password Manager (steps, expected prompts, what must not happen, what to send back), progress in `docs/FINDINGS.md` and the notes.

## Red lines

- The AI session never signs or sends a transaction, never uses a real passkey or key, and never runs `scripts/gate.cjs --live`.
- Do not change the behaviour of the wallet-extension path, the caps, or existing guards other than the minimal allow-list addition above. All 121 existing tests keep passing.
- No dependency beyond the four. Do not push, deploy or change repository settings (a push to `main` redeploys the public page).
- Everything written into the repository is English. Reply to the user in Chinese, conclusion first.

## Known risks to think through first

- Passkey PRF support differs by browser and authenticator (see Mera's support table); fail with a plain message, never fall back to anything that stores a secret.
- A third-party package now runs in a page that holds a key in memory: pin versions, keep the bundle free of other network calls, and list every host the bundle contacts in `docs/FINDINGS.md`.
- Native iOS (TestFlight) would need an `apple-app-site-association` file at the host's root, which a GitHub project page cannot serve; that is a later decision and out of scope here.

## When finished

`npm test` green; local walk-through in Chrome with the stub passkey on `web/fake.html`-style test page at desktop and 390 px; findings and notes written; tell the user what is done, what only their own real run can verify, and the decisions needed.
