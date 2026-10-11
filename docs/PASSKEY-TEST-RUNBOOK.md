# Passkey test runbook: the first real run (for the owner, not for an AI session)

**Goal:** prove, with a real passkey and a few dollars, that the Passkey tab signs you in, shows your AUSD balance and swaps a few dollars of USDC into AUSD, and that the Plant tab works through the same session. Nothing in this repository's tests has used a real passkey, key or money, so this run is the first real evidence.

**Rules for this run**

- Use a **new, throwaway passkey account** and at most about **$8**: about 6 USDC and about 1 MON (for network fees; each transaction costs roughly 0.02 MON). Never fund it with more.
- **An AI session must not do any step below.** You press every button yourself. Never paste a seed phrase, a key or the passkey's secret anywhere; none of them is shown by the page.
- The account is bound to the host. Use the live page `https://owenzhao9.github.io/flip-garden/` (only after the owner has merged and published this phase). A local copy runs on another host and makes a different account.

## What you need

| Where | Needs |
|---|---|
| iPhone | iOS 18 or later, Safari (or Chrome on iOS), iCloud Keychain on with passkeys allowed |
| Desktop Chrome | Google Password Manager as the passkey provider (Chrome's own "this device" profile has no PRF, so the page will say the passkey cannot derive a secret) |

## Steps

1. Open the page, tap **Passkey** in the tab bar. Read the key rule and the "Not yet verified" notice.
2. Tap **Create passkey**. **Expected:** the system shows one prompt (create a passkey for `owenzhao9.github.io`), and possibly a second one right after (some authenticators need a second ceremony to read the secret). Confirm with Face ID, Touch ID or the PIN. If the page says the browser cannot derive a secret from a passkey, stop and report which device and browser it was; nothing is stored in that case.
3. **Expected:** a green bar "Signed in with a passkey as 0x…" with a **Lock** button, and a Balances card with MON, USDC and AUSD (all 0). Copy your address from the Passkey account card.
4. Send about 6 USDC and 1 MON to that address on **Monad mainnet (chain 143)** from an exchange or another wallet. The page does not bridge. Press **Refresh balances** until they show.
5. In the swap card keep 5 USDC and press **Preview the swap**. **Expected:** "You pay exactly 5 USDC and receive about 4.99x AUSD, never less than about 4.98x AUSD", the router link `0xb3e6…13cb`, and a button "Start: approve 5 USDC".
6. Press it. **Expected:** a card "Ready: sign with your passkey session" that says "Approve exactly 5 USDC", names the router, shows a network fee (about 0.02 MON), and the line "Simulation passed". There is **no system pop-up** on this path. Press **Sign and send**. **Expected:** after a few seconds the log says "Approval: 0x… · the allowance for the Flow router is exactly the approved amount".
7. **Expected:** the page asks Kuru Flow for a fresh route and shows a second card "Swap exactly 5 USDC for AUSD" with "Simulation passed … a trace shows exactly where the tokens would go". Press **Sign and send**. **Expected:** the log says "Swap: 0x… · USDC fell by exactly 5 and AUSD rose by 4.99x, at least the promised 4.98x", and the Balances card shows the new AUSD.
8. Open both transaction links on the explorer. **Expected:** the first is `approve` on USDC, the second goes to `0xb3e6…13cb`; the swap's AUSD arrived at your address.
9. Press **Lock**. **Expected:** the bar changes to "Locked." and the balances and swap cards disappear. Press **Sign in with passkey** again (one prompt). **Expected:** the same address as before.
10. Plant tab (optional, after the swap worked): with the leftover USDC (at least about 5.5 USDC for one level) press **Connect Passkey (Mera)** and follow `docs/PLANT-TEST-RUNBOOK.md` from its step 3. Expect the same cards, worded "sign with your passkey session" instead of "wallet pop-up".
11. Idle test: sign in, leave the page open and untouched for 5 minutes. **Expected:** it locks by itself with "Locked after 5 minutes without activity." Also try: sign in, switch to another app or tab for a moment and come back (some browsers fire "page hidden"): if it says "Locked because the page was hidden", that is correct behaviour.
12. Reload test: sign in, reload the page. **Expected:** you are signed out and must use the passkey again.

## Things that must NOT happen (stop and report if they do)

- Any system prompt other than the passkey prompts at create and sign-in. A prompt at "Sign and send" is not expected.
- A transaction other than the exact approve and the swap listed above, an approval that is not the exact amount, or any spender other than `0xb3e6…13cb`.
- The page showing a seed phrase, a private key or the passkey secret anywhere, or asking you to type one.
- The log saying **Cannot explain**, or AUSD received being below the promised minimum.
- After **Lock**, a transaction going through, or the lock bar still saying "Signed in".
- A different address after signing in again on the same device and host.
- Your browser's Application tab (desktop) showing anything under Local storage, Session storage or IndexedDB that looks like a key or a long hex secret. (It will contain only the ledger cache and a planting note.)

## What to send back

Public data only; **never** a key or seed phrase.

- The device, OS and browser (for example "iPhone 15, iOS 18.2, Safari") and which passkey provider (iCloud Keychain, Google Password Manager, 1Password).
- The address, and the transaction hashes of the approval and the swap.
- Screenshots or the exact text of any message that said Stopped, Cannot explain, "cannot derive a secret" or "simulation failed".
- Whether step 2 showed one or two prompts, and whether steps 11 and 12 behaved as described.

With these, the result goes into `docs/FINDINGS.md` as the first real verification of the passkey path.

## What this run cannot show

The Perpl hedge (a later phase), other browsers and providers than the ones you used, the native iOS app (it would need a file at the host root that a GitHub project page cannot serve), and how a different passkey provider behaves with a second device.
