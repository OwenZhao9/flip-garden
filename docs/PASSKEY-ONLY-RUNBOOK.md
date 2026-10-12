# Runbook: the passkey-only flow (the owner's real-money check)

Run this yourself, in Safari on macOS or iPhone with iCloud Keychain (the browser that worked on 2026-10-11), on the deployed page. Use a few dollars. An AI session never signs, never holds a key and never sends a transaction.

## What changed

Plant, Hedge and Board now use one account: the passkey (Mera). The browser-wallet connect buttons are gone. A "Not signed in" bar with **Sign in with passkey** and **Create passkey (first time)** sits at the top of every page; the Ledger tab still reads without signing in. Locking (button, 5 minutes idle, page hidden, reload) returns Plant and Hedge to their sign-in prompt.

## Steps

1. Open the page in a private window (nothing stored). Do not sign in. Open **Ledger**, paste a wallet address and start block, read. Expected: it works with no prompt.
2. Open **Plant**. Expected: a sign-in prompt, no "Connect wallet" button anywhere.
3. Press **Sign in with passkey**. Expected: one system sheet, then "Signed in: 0x…" and the same address as before for the same passkey.
4. Plant as in `docs/PLANT-TEST-RUNBOOK.md` (preview, press **Sign and send**). Expected: no wallet pop-up, one confirmation card per transaction.
5. Stateless test, three ways. After each, open **Plant** and sign in: the address must be identical.
   - Press **Lock**, then reload.
   - Clear all site data for the page (Safari: Settings, Advanced, Website Data) and reload.
   - Open the page on a second device signed in to the same iCloud account.
   Expected: the same account and the same garden (balances and orders come from the chain). The browser's local note of your planting (start block) may be gone; the ledger link and the board then need the start block typed again.
6. Idle for five minutes on the Plant page. Expected: the lock message appears and the page returns to the sign-in prompt; nothing was sent.
7. Open **Board** while signed in. Expected: the address field is pre-filled with your account.

## Send back

For each step: what you saw, in one line, and any message that looked wrong. If the first sign-in on a device shows a sheet with no passkey offered, use **Create passkey (first time)** instead and say so.

## What must not happen

A wallet extension pop-up, a request for a seed phrase or an email, a sign-in prompt on the Ledger tab, a different address for the same passkey on the same site.
