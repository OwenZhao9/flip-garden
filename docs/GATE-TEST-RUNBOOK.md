# Reproducing the real-funds gate test

The gate test proves the whole loop on Monad mainnet with a few dollars: deposit to Kuru's margin account, place a flip order, see it fill and flip, cancel, withdraw, and check that the ledger matches the chain.

## Know before you start

- The minimum order on MON-USDC is **200 MON (about $5)**. Plan for about **$7 of USDC** and **a few MON** for network fees, in a dedicated test wallet. Never use your main wallet.
- Every command is a **dry run** unless it carries `--live`. A live command also asks you to type `YES`.
- The private key lives only in an environment variable of the terminal you type it into. It is never written to a file and must never be pasted into a chat or a tool that logs output.

## Setup

```bash
npm install
```

Create a throwaway wallet. The script refuses to run outside an interactive terminal (and inside AI-tool sessions), so the key cannot leak into logs. Run it in a plain terminal window, store the private key in a password manager, then press Enter to wipe it from the screen:

```bash
node scripts/new-wallet.cjs
```

Fund the printed address on **Monad mainnet** with about 7 USDC and a few MON. Check the network twice before sending: a transfer on the wrong network is lost.

Dry runs need only the public address:

```bash
export ADDRESS=0xYourTestWalletAddress
node scripts/gate.cjs preflight
```

All checks should print a tick. Live commands need the private key instead (type it at a hidden prompt, and unset `ADDRESS` first):

```bash
unset ADDRESS; read -rs "PRIVATE_KEY?Paste the test wallet private key (hidden): " && export PRIVATE_KEY && echo
```

## Run

```bash
node scripts/gate.cjs deposit --usdc 6 --live
```

Approves exactly 6 USDC, then deposits it into Kuru's margin account.

```bash
node scripts/gate.cjs plant --orders 1 --live
```

Simulates the order with your real balance first, then places one flip bid (201 MON, one tick below the best ask, flipping about 0.1% higher).

```bash
node scripts/gate.cjs status --watch
```

Watches for fills; safe to stop with Ctrl+C and resume later because state is kept in `state/`.

```bash
node scripts/gate.cjs unwind --live
```

Cancels every live order and withdraws all margin balances back to the wallet.

```bash
node scripts/gate.cjs report
```

Prints the reconciliation report (read-only): balance changes, fills, fees and gas, and whether computed and on-chain numbers match.

## Pass criteria

You can read, from chain data alone: the order's creation, its fill, the opposite order that Kuru creates (a new order id), the cancellation and the withdrawal, and `report` shows USDC and MON both reconciling with at most rounding dust. The run recorded in this repository reconciles with a difference of exactly 0 (see `test/fixtures/gate-test-2026-10-10.json`).
