# Stage D, milestone 6: game feel (brief for a Sonnet 5.5 session)

Read first: `CLAUDE.md` (rules, including the rule that texts about the project state only what it is and does), `docs/STAGE-D5-BRIEF.md` (the garden layer this builds on), `docs/DESIGN-BRIEF.md` and `design/stitch/` (look and tokens), `docs/STAGE-D2-BRIEF.md` (the safety boundary), `web/src/garden-art.ts`, `garden-style.ts`, `garden-ui.ts`, `garden-view.ts`, `garden-live.ts`, `web/style.css`, `src/garden.ts`.

## Goal

The page has no motion today (no keyframes, no effects, no sound). Make the garden feel like a game: things grow, react and celebrate, without touching the honesty of the numbers. Everything is derived from chain facts each time; effects only present data that already exists and never change a number, a label of a number, or a transaction.

## Deliverables

1. **Living plots**: CSS-only idle motion per stage (seed pulses, sprout and flower sway, fruit bobs, a pruned stem drops a leaf). Extend `garden-art.ts` / `garden-style.ts`; keep the text label next to every picture.
2. **Stage-change moment**: when a live refresh finds that a plot's stage changed, play a short grow animation with a sparkle ring on that plot. Write the comparison as one pure function (`diffGarden(prev, next)` returning events such as `stage-changed`, `achievement-earned`, `level-up`, `first-fill`) with tests in `test/`.
3. **Celebrations**: confetti for a first fill, an earned achievement and a level-up; a toast "Achievement unlocked" with its icon. Do not replay for something already celebrated: remember what was shown per wallet address in `localStorage` (a per-viewer convenience; wrap every access in try/catch and work without it). On the first load of a page nothing replays.
4. **Level progress**: two thin progress bars to the next level (completed round trips and garden age), using only the numbers in `src/garden.ts`. No invented points or experience.
5. **Feedback and polish**: button press feel, card entrance fades, balance numbers tween to the newly read value (the displayed final value is always the chain value), a pulse on the live indicator.
6. **Garden scene**: soil strip and sky background behind the plots on the planting page and the ledger's garden card, built from existing tokens.
7. **Sound**: a few short WebAudio tones for celebrations, **off by default**, with a visible toggle remembered in `localStorage`.
8. **Reduced motion**: with `prefers-reduced-motion: reduce`, every animation, confetti and tween is off and the page is static. Test it.
9. **Fake walk-through**: extend `web/fake.html` so each moment (stage change, first fill, achievement, level-up) can be triggered against the fake chain and watched. Check the result in a browser at phone width and take screenshots into `docs/screens/`.
10. **Docs**: README section; the progress and the decisions in `docs/FINDINGS.md` and the notes file named in `CLAUDE.md`.

## Red lines

- No change to anything that signs or sends: `src/plant.ts`, `src/flow.ts`, `src/perpl/*`, `src/swap*.ts`, the guards, `web/src/mera-provider.ts`, `session.ts`. No change to ledger logic or `web/src/pipeline.ts`.
- No game number is ever mixed into a ledger number; effects never block a button, never cover a confirmation card, and never run while a confirmation card is open.
- No new runtime dependency (CSS, SVG, canvas and WebAudio only). The page stays one small bundle; report the size change.
- All 226 existing tests keep passing. Do not push, deploy or change repository settings.
- Everything written into the repository is English; texts about the project state only what it is and does. Reply to the owner in Chinese, conclusion first.

## Workflow

Work in a separate git worktree on its own branch with small commits ending with the Co-Authored-By line given in the session. When done, write progress into the notes and tell the owner; the main session reviews and merges.
