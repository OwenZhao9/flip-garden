# Stage D, milestone 8: a living 3D garden with Three.js (brief for a session)

Read first: `CLAUDE.md`, `docs/STAGE-D6-BRIEF.md` (game feel, merged), `docs/DESIGN-BRIEF.md`, `design/stitch/`, `web/src/garden-art.ts`, `garden-style.ts`, `garden-ui.ts`, `garden-view.ts`, `garden-fx.ts`, `garden-fx-dom.ts`, `docs/screens/game-feel-*.png`.

Two other sessions run in parallel: bounties (`docs/STAGE-D7-BOUNTIES-BRIEF.md`) and the Gardener agent (`docs/STAGE-D9-GARDENER-BRIEF.md`). You own `web/src/garden-art.ts`, `garden-style.ts`, `garden-fx*.ts`, `garden-ui.ts` and new files `web/src/garden3d*.ts`; keep any edit elsewhere minimal.

## The problem and the owner's decision

The owner finds the plots ugly: each stage is a tiny flat SVG icon with barely visible motion. The owner decided: **no generated images; native, real-time animation built with Three.js.**

**Dependency approved by the owner (2026-10-12):** `three`, in `web/package.json` only, pinned to an exact version that has been on npm for at least two weeks; record the version and the reason in `docs/STAGE-D3-BRIEF.md` next to the other approved dependencies. Import only the modules you use so the bundle stays as small as possible. No other new dependency.

## What to build

1. **A 3D garden scene** rendered with Three.js inside the garden panel: a ground bed with soft lighting, a gentle sky gradient, soft shadows, the brand palette (background #14102B, surface #1E1840, lime #9BE564, purple #836EF9) with warm accents. Cosy, rounded, low-poly game style.
2. **Plants built from geometry in code** (no image files), one per plot, for every stage: seed (a seed in a small mound, breathing), sprout (stem and two leaves swaying), flower (stem, leaves, petals that open and sway), fruit tree (trunk, canopy, fruits that bob), cut stump (with a falling leaf). Each plant's look is driven only by the existing `GardenView` data; no number is invented.
3. **Motion**: idle sway with per-plant phase so the garden does not move in unison; a grow transition with squash-and-stretch when a stage changes; a prune cut; particles (sparkles on growth, leaves on prune, confetti on the existing celebration moments). Reuse `diffGarden` and the celebration memory from milestone 6.
4. **Interaction**: hovering or tapping a plant highlights it and scrolls to or opens its plot card (the existing DOM card with all text, numbers and the Prune/Move/Harvest buttons stays the source of truth and stays accessible). A slight camera drift is fine; no free camera controls needed.
5. **Fallbacks**: if WebGL is unavailable or fails, keep today's SVG garden. With `prefers-reduced-motion: reduce`, render one still frame and no animation. Pause rendering when the tab is hidden or the scene is off-screen. Cap the pixel ratio at 2 and keep it smooth on a phone.
6. **Performance budget**: report the bundle size before and after, and frame time on desktop and on a phone-sized viewport. If the bundle grows by more than about 250 KB minified, tell the owner before going on.

## Checks

Walk every stage and moment through `web/fake.html` at desktop and 390 px width, with and without reduced motion, and with WebGL disabled; save screenshots to `docs/screens/garden3d-*.png`. All tests keep passing; add tests for any new pure function (for example the mapping from `GardenView` to scene parameters).

## Red lines

Do not touch signing, sending, the guards, the ledger or the pipeline. Do not push, deploy or change repository settings. Everything in the repository is English; texts about the project say only what it is and does. Reply to the owner in Chinese, conclusion first. Work on its own branch in a git worktree with small commits; tell the owner when done.
