# Stage D, milestone 5: the garden game layer and fixes (brief for a Sonnet 5.5 session)

Read first: `docs/STAGE-D4-BRIEF.md` and `docs/DESIGN-BRIEF.md` (look and rules), `design/stitch/` (the design), `docs/STAGE-D2-BRIEF.md` (the safety boundary), `docs/FINDINGS.md` (especially "First real run of the browser planting flow" and the milestone 2 and 4 sections), `docs/LEDGER.md`, `web/src/plant.ts`, `web/src/main.ts`, `web/src/ui.ts`, `web/style.css`.

## Goal

Make the page feel like a garden without touching the honesty of the numbers: plots that grow with fills, per-plot actions, a few achievements and a level, live refresh, and three fixes found in the first real run. Everything is derived from chain facts each time the page loads; nothing is stored, and no game number is ever mixed into a ledger number.

## Deliverables

1. **Growth stages** for each plot, as small inline SVG, driven only by ledger state: planted (seed, resting), partly filled (sprout), filled (flower), and a completed round trip (fruit: a flipped sell that filled and flipped back into a buy). Pruned orders show as cut stems. Define the mapping in one pure function with tests.
2. **Per-plot actions** through the existing engine and guard (no new transaction kinds): **Prune** (cancel one or several chosen live orders, `batchCancelFlipOrders`), **Harvest** (withdraw what is free at Kuru, `batchWithdrawMaxTokens`; say plainly it returns free money, not profit), **Move** (prune, then plant a new bid at a price chosen from the current book, two steps, each with its own simulation and confirmation). Only orders that the chain says belong to the connected account can be selected.
3. **Achievements and a level**, pure functions over the ledger output in a new `src/garden.ts`, with tests: first planting, first fill, first completed round trip, a garden of three plots, a garden that has existed for 7 days, first prune, first harvest. The level (for example Seed, Sprout, Bloom, Orchard) comes from completed round trips and garden age and says nothing about profit. Anything that depends on a completed round trip is labelled "not yet seen on real data" until one exists in a fixture. Nothing is persisted.
4. **Live refresh**: re-read the chain every few seconds while the tab is visible, pause when hidden, reuse the scanner's windows so the public node is not hammered, and show when the data was last read.
5. **Three fixes**: (a) pressing "Plant these orders" must refresh the book and rebuild the preview itself instead of reusing a stale one; (b) the Unwind lookup error "Cannot convert undefined to a BigInt" seen in the browser (not reproduced in Node; suspect state saved in `localStorage` or a bid or id that is undefined): find the cause, fix it, add a regression test; (c) update the notices that still say the planting flow is "unverified with real money" to say it was verified once on 2026-10-11 with MetaMask, one level, and keep what is still unverified (phone, other wallets, a completed round trip).
6. **Look**: new elements use the existing tokens and components; no wording taken from the Stitch mock.
7. **Docs**: README section, progress in `docs/FINDINGS.md` and the notes; extend `web/fake.html` so every new action can be walked through against the fake chain.

## Red lines

- The AI session never signs or sends a transaction and never uses a key; tests use the fake wallet and chain.
- Do not change the guard's allow-list, caps, or the engine's order of steps; do not change `web/src/model.ts`, `web/src/pipeline.ts` or ledger logic. All 144 existing tests keep passing.
- Another session adds the Perpl hedge page in new files and may append to `web/src/main.ts`, `web/src/ui.ts` and `web/style.css`; keep your edits to those small and put new code in new files.
- No new runtime dependency. Do not push, deploy or change repository settings.
- Everything written into the repository is English. Reply to the user in Chinese, conclusion first.
