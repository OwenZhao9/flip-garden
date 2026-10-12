# Runbook: deposit from another chain with Aurora (the owner's real-money check)

Run this yourself on the deployed page, signed in with your passkey. Use 1 to 5 USDC. You need a wallet on another chain (Base, Arbitrum, Ethereum, Optimism or Polygon) holding USDC and a little of that chain's gas coin. An AI session never signs or sends anything; the page itself signs nothing in this flow.

## What the flow is

Deposit tab: choose the chain, the amount and your wallet address on that chain (where Aurora returns the funds if the deposit fails). Preview asks Aurora for a price without reserving anything. "Get the deposit address" reserves a one-time address. You send USDC there from your own wallet on the other chain; that wallet signs in its own pop-up. The page follows Aurora's status and, when Aurora says SUCCESS, re-reads your Monad USDC balance and compares it with the quoted minimum.

## Steps

1. Sign in, open **Deposit**. Expected: the page shows your passkey address as the destination.
2. Pick **Base**, amount **2**, paste the address of the wallet you will send from. Press **Preview the deposit**. Expected: about 2 USDC, never less than about 1.98 (a small fee is inside), a time estimate.
3. Press **Get the deposit address**. Expected: an address, the exact amount, an expiry time, the warning to send only USDC on that chain once.
4. In your other-chain wallet, send exactly that USDC amount to the address. Expected on the page: "Waiting", then "Deposit seen", then "Funds arrived" with the balance change, within about a minute (Aurora quoted about 37 seconds for Base in a read-only quote on 2026-10-12).
5. Open **Plant**: the USDC is in your account; plant as in `docs/PLANT-TEST-RUNBOOK.md`.
6. Failure paths, only if you want to test them: let a reserved address expire without sending (nothing happens); send less than the amount (Aurora decides: refund to the refund address, shown as "Refunded").

## Send back

Per step, one line of what you saw, the Base transaction link of your deposit and the Monad balance before and after.

## What must not happen

The page asking for a signature or a pop-up for this flow; a quote whose recipient is not your passkey address; an address shown that is not a plain 0x address; "Funds arrived" while your balance did not rise.

## Notes

- The API key in `src/aurora.ts` is not a secret (Aurora's docs say it is safe in public pages). Fees are set per key in Aurora's portal; the read-only quote on 2026-10-12 showed an app fee of 2 basis points (the floor for stablecoins).
- Not covered: non-EVM sources (Solana, Bitcoin), assets other than USDC, deposit-and-execute through Intents Connect.
