# First real run of the planting flow

**Status: unverified with real money.** The planting flow has been tested only against a fake wallet and a fake chain, and its encoders against `ethers`. This runbook is how the owner (not an AI session) does the first real run with a throwaway wallet. Mirrors [`GATE-TEST-RUNBOOK.md`](GATE-TEST-RUNBOOK.md), which proved the same steps from the command line.

## Know before you start

- Use a **dedicated throwaway wallet** in a browser wallet extension (import or create a new account for this test; never your main one). The page never asks for a key; the wallet signs.
- Budget: the minimum order on MON-USDC is **200 MON (about $5)**. Plan for **about $7 of USDC** (one level) and **a few MON** for network fees (the page requires at least 0.5 MON in the wallet). The caps are fixed in code: 15 USDC per deposit, 3 orders and 15 USDC per planting.
- Expect the whole test to cost about one to two cents in network fees plus any small mark-to-market loss, as in the command-line test (see `docs/FINDINGS.md`).
- Run it from the page you intend to publish: either the local build (`cd web && npm install && npm run build`, then serve `web/dist/` and open `/#plant`) or the public page `https://owenzhao9.github.io/flip-garden/#plant` once it has been deployed.
- Check the network twice before funding: **Monad mainnet, chain id 143**. A transfer on the wrong network is lost.

## Steps and what to expect

1. Open the page at `#plant`. Press **Connect** for your wallet. Expect one connection pop-up (no money involved). If the wallet is on another network, press **Switch to Monad mainnet**; the wallet asks once.
2. **Balances** should match the wallet. Best bid and ask should look like the Kuru market (about 0.0247 USDC per MON when the command-line test ran).
3. **Plan**: leave budget `6`, one level, "Right under the best ask". Expect a preview table labelled *Preview, nothing sent*: one level, size around 240 MON, USDC locked just under 6, flip price a few ticks above the bid, and the line "Preview simulation: the contract accepts these orders".
4. Press **Plant these orders**. Expect, one after another, each preceded by a statement and a gas figure (about 0.02 to 0.03 MON each) and each needing you to press **Open the wallet pop-up**:
   1. **Approve exactly the amount** (the pop-up should name USDC and the Kuru margin account `0x2A68…90c5`, and show a spending cap equal to the deposit, **not unlimited**). Afterwards the log says the allowance equals the approved amount.
   2. **Deposit** into the margin account. The log says the margin grew by exactly the deposit and the `Deposit` event matches.
   3. **Place the flip bid**. The log says the order(s) were created and the locked USDC equals the preview to the last unit.
5. The **Planted** card appears with a link to the ledger. Open it: the ledger should show the order as *Planted* and, once a taker hits it, *Harvested* with a new flipped sell order. It reads from the block before your first transaction.
6. Wait for a fill if you like (the command-line test filled within about 0.6 seconds because the bid sat right under the ask; it may take longer). Nothing needs to fill for the test to count.
7. **Unwind**: press **Unwind: cancel all and withdraw**. Expect up to two more pop-ups: cancel your live orders (including a flipped sell if a fill happened), then withdraw USDC (and MON if you hold any at Kuru). The log verifies each. The final card says *Unwound*.
8. Open the ledger again: every reconciliation row should show difference 0, as in the command-line test.

## Things that must NOT happen (stop and report if they do)

- A wallet pop-up that shows an **unlimited** approval, another spender, another token or a value of MON being sent.
- More than one pop-up for one step, or a pop-up you did not just ask for.
- The log says **Cannot explain** at any step, or the ledger badge is *Does not match*.
- The page claims *Unwound* while the ledger still shows a resting order.

Reloading the page half-way is safe: it works out the next step from the chain (allowance, margin balance, live orders). The start block is remembered in the browser; if it was lost, the Unwind box asks for it (use the block number from the first transaction's page on the explorer, minus one).

## What to send back

Everything below is public data; **never send a private key or seed phrase**.

- The wallet address.
- The transaction hashes in the order they happened (the page's "What happened" list shows each as a link): approve, deposit, plant, and later cancel and withdraw. Also any fill transaction you see in the ledger.
- A screenshot or the text of any message that said *Stopped*, *Cannot explain* or *simulation failed*.
- The ledger page URL for the wallet (it contains the address and the start block).

With those, the ledger can reconcile the run and the result goes into `docs/FINDINGS.md` as the first real verification of the browser flow.

## What this run cannot show

Not seen on chain yet and not covered by this run unless it happens by luck: the full cycle where a flipped sell fills and flips back into a buy, non-zero fees, and several orders in one batch (plant with 2 or 3 levels, budget about 12 to 15 USDC, as a second run once the first one passed).
