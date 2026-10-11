# Stage D, milestone 2: the planting flow (brief for a Sonnet 5.5 session)

## Goal in one sentence

Let a visitor connect **their own** browser wallet to the live page, preview a small ladder of flip bids, and, only after an explicit confirmation in the wallet pop-up for every single transaction, deposit, plant and later unwind it, then watch the result in the existing ledger. **The page never sees a private key.**

## Why this next

- Today the product is a viewer. Planting is the promise of the whole project ("plant a few dollars as Kuru flip orders") and the part judges will expect to see.
- Every step it needs has been verified on mainnet by our real-funds test: deposit, plant, fill, flip, cancel, withdraw, reconcile with difference 0 (`docs/FINDINGS.md`).

## Existing assets (read these first)

- `docs/FINDINGS.md` (verified facts and open questions), `docs/LEDGER.md`, `docs/DEPLOY.md`, `README.md`, `docs/STAGE-D-BRIEF.md` (milestone 1, done).
- `scripts/gate.cjs`: the reference implementation of deposit, plant and unwind with hard caps. Read it, do not modify it. `lib/units.cjs` has `buildBidLadder`, `quoteForSize`, `parseUnits`, `formatUnits`; port what the page needs into `src/` as TypeScript and add a differential test against `lib/` (do not edit `lib/`).
- `config/kuru.mainnet.json`: contract addresses and the hard caps (max deposit 15 USDC, at most 3 orders and 15 USDC per plant, at least 0.5 MON for gas).
- `web/`: the read-only ledger page. The planting flow lives next to it and reuses it as the result screen.
- The Kuru SDK in `node_modules/@kuru-labs/kuru-sdk` (0.0.95) holds the contract ABIs. The page must not depend on the SDK (it targets ethers 5 and Node).

## Safety boundary (non-negotiable: this is the first time the product can move money)

1. **No private keys anywhere.** The page talks to the user's wallet extension through the standard browser-wallet interface (EIP-1193, `window.ethereum`; EIP-6963 for several wallets if it is easy). It never asks for, reads or stores a key or a seed phrase.
2. **One wallet pop-up per transaction**, each preceded by a plain statement of what it does. No hidden transactions, no automatic re-sending.
3. **Exact-amount approvals only**, never "unlimited".
4. **Only the contracts in the config** (margin account, the MON-USDC market, USDC). Refuse any other target. Refuse any chain except Monad mainnet (chain id 143) and offer to switch.
5. **Hard caps from the config, enforced in code and in tests.** Raising them is the user's decision.
6. **Simulate before every pop-up** (`eth_call` from the user's address). If the simulation fails, say why in plain words and do not open the pop-up. Show the gas estimate in MON; Monad charges the gas limit.
7. **Preview before confirm.** Show exact numbers: each level's bid price, flip price and size, USDC locked, the 200 MON minimum-order check, profit per full round trip as "up to", and the risk in plain words (a bid placed right under the ask is hit at once and can show a paper loss; see the real-funds test in `docs/FINDINGS.md`). Label previews as previews.
8. **Check after every transaction.** Wait for the receipt, re-read chain state and verify the post-conditions (for example the margin balance grew by exactly the deposit; the expected `FlipOrderCreated` events exist). On any mismatch stop and say "cannot explain". Link every transaction to the explorer.
9. **Unwind is always one click away** once something is planted: cancel all orders (`batchCancelFlipOrders`) and withdraw everything (`batchWithdrawMaxTokens` for USDC and native MON).
10. **The AI session must not sign or send any transaction, use any key, or run `gate.cjs --live`.** All tests use a fake wallet provider (a test double that records requests) and read-only simulations. The first real run is done by the user (see deliverable 4).

## Deliverables

1. **The flow**, in `web/` with pure logic in `src/`:
   - Connect wallet; network check and switch (Monad mainnet, RPC `https://rpc.monad.xyz`).
   - Balances: wallet USDC and MON, margin free and locked (reuse the core).
   - Plant panel: budget in USDC (small by default, capped), number of levels (at most 3), placement relative to the best ask with a plain explanation of the trade-off, preview table, risks, confirm.
   - Transaction sequence: approve exact amount, deposit, plant. Derive progress from chain state (allowance, margin balance, open orders) so a page reload resumes correctly.
   - Unwind and a result screen that opens the ledger for the connected wallet from the block before the first transaction.
   - The garden skin from milestone 1 (plots coloured by state). The numbers stay sober and exact.
   - English UI, usable on a phone (single column, touch-friendly). Milestone 1's page was checked at 390 px (no overflow); its weak spots are inline links only about 19 to 24 px tall and a wrapped counterparty row in the fills list. Fix them if it is cheap. Note that the browser's window-resize call does not change the viewport; load the page in a same-origin iframe of the target width to test phone layouts (see `docs/FINDINGS.md`).
2. **Calldata encoding without a dependency**: ABI encoders in `src/` for `approve`, the margin account's deposit, `batchProvisionLiquidity`, `batchCancelFlipOrders` and `batchWithdrawMaxTokens` (read exact signatures from the SDK's ABI files). **Differential tests against `ethers`** (already a root dependency; use it in tests only, never in the page bundle), including function selectors.
3. **Tests** with `node --test`: the ported ladder equals `lib/` on many inputs; caps; encoders; preview math (integers only, no floating point); the transaction state machine against a fake provider (user rejection, wrong chain, failed simulation, a reload half-way, a book that moved).
4. **`docs/PLANT-TEST-RUNBOOK.md`**: how the user (not the AI) does a first real run with a throwaway wallet and about $6 to $15: exact steps, the pop-ups to expect, the numbers to expect, and what to send back (transaction hashes) so the ledger can reconcile it. Mirror `docs/GATE-TEST-RUNBOOK.md`.
5. **Docs**: README (what the planting flow does; state plainly that it is unverified until the user's real run), progress in `docs/FINDINGS.md` and in the notes.

## Known difficulties (think these through first)

- **Preview before the user has deposited.** A simulation needs balance. For the preview, simulate from a throwaway address with a state override (as `scripts/gate.cjs preflight` does) and label it a preview; before each real pop-up, simulate from the user's own address.
- **The book moves.** Quotes refresh several times a second. Re-read the book immediately before opening the pop-up and refuse if a bid would cross. A bid that crosses is silently skipped when `provisionOrRevert` is false (the SDK's choice) and reverts when it is true. Decide deliberately and say why in the code.
- **Wallet differences**: no wallet installed, several wallets, wrong chain, a user who rejects. Each needs a clear message. Never tell the user to install or approve anything beyond the pop-up itself.
- **Not seen on chain yet**: the full cycle in which a flipped sell fills and flips back into a buy (seen only in another account's data), non-zero fees, and several orders in one batch (our own test placed one; the command-line tool simulated one and three). Say so in the UI where it matters and let the ledger say "cannot explain" instead of guessing.

## Red lines

- Everything in the safety boundary above.
- Do not push, deploy or change repository settings without the user's agreement. A push to `main` redeploys the public page (`.github/workflows/pages.yml`), and publishing a page that can move real money is the user's call.
- Ask before adding any runtime dependency; propose the lightest option first.
- Do not modify `state/`, `scripts/gate.cjs`, `lib/`, or the behaviour of existing `src/` code. Extend them. All existing tests must keep passing.
- Everything written into the repository, including UI text, must be in English. Reply to the user in Chinese, conclusion first.

## When finished

1. `npm test` is green; open the page locally in Chrome with a fake-provider test page and walk through every state, at desktop and phone width.
2. Record progress and findings in the notes and in `docs/FINDINGS.md`.
3. Tell the user what is done, what only their own real-money run can verify, and the decisions you need (deploy, raising caps, a funding helper such as a cross-chain bridge link, a Chinese UI).
