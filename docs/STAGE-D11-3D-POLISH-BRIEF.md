# Stage D, milestone 11: polish the 3D garden (brief for a session)

Read first: `docs/HANDOFF.md`, `CLAUDE.md`, `docs/STAGE-D8-ART-BRIEF.md` (the 3D garden as built), `web/src/garden3d*.ts`, `docs/screens/garden3d-*.png`, `design/broll/reference-garden3d.png`.

## The problem

The owner finds the 3D garden rough: flat low-poly shapes with hard facets, plain colours, simple lighting, a flat bed and spiky grass. It should look like a polished cosy game (think a premium mobile garden game), consistent with the brand palette (background #14102B, surface #1E1840, lime #9BE564, purple #836EF9, warm amber accents).

## What to improve (no new dependency; Three.js and its own `three/examples/jsm` add-ons only)

1. **Shapes**: smooth, rounded forms with enough segments and smooth shading; leaves and petals as curved, tapered shapes (not boxes or flat triangles); a softly bevelled bed with a soil rim and a thin grass layer; soft rounded grass tufts or moss instead of spikes; small details (pebbles, a few flowers, fireflies) placed deterministically.
2. **Materials**: physically based materials with gentle roughness variation, subtle vertex-colour gradients (darker at the base, lighter at the tips), a faint emissive glow on lime and amber elements.
3. **Light and atmosphere**: a key light, a cool purple rim light and a warm fill; soft shadows; tone mapping (ACES) and correct colour space; light fog for depth; a sky gradient with a few stars; subtle bloom on glowing parts if the frame-time budget allows (`UnrealBloomPass` from the Three.js add-ons, disabled on low-end devices).
4. **Motion**: keep the existing idle sway, growth, prune and celebration behaviour; make sway follow the stem (bend from the base), add a slow breathing light and drifting particles.
5. **Camera and framing**: a pleasing three-quarter view with a little depth of field feel (fog or a soft vignette), the bed filling the frame on a phone.

## Budgets and checks

- Bundle growth at most about 60 KB minified over today; report it. Frame time on a phone-sized viewport and in the iOS Simulator: keep it smooth; reduce effects automatically if frames drop.
- Keep reduced motion (one still frame), the SVG fallback when WebGL is missing, pausing when hidden, and every text label and button in the DOM cards.
- Screenshots before and after at 390 px and desktop into `docs/screens/garden3d-polish-*.png`, and a new crop of the scene only (no interface) to `design/broll/reference-garden3d.png` for the pitch video's atmosphere shots.
- All tests keep passing; add tests for any new pure function.

## Red lines

Do not touch signing, sending, the guards, the ledger, the pipeline or the Gardener logic. No new dependency. Work on its own branch in a git worktree with small commits; when done the main session merges, tests, pushes and deploys (pre-approved). Everything in the repository is English; reply to the owner in Chinese, conclusion first.
