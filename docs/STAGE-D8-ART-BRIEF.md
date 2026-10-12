# Stage D, milestone 8: garden art and animation pass (brief for a session)

Read first: `CLAUDE.md`, `docs/STAGE-D6-BRIEF.md` (game feel, merged), `docs/DESIGN-BRIEF.md`, `design/stitch/`, `web/src/garden-art.ts`, `garden-style.ts`, `garden-ui.ts`, `garden-fx.ts`, `garden-fx-dom.ts`, `docs/screens/game-feel-*.png`.

Two other sessions run in parallel: bounties (`docs/STAGE-D7-BOUNTIES-BRIEF.md`) and the Gardener agent (`docs/STAGE-D9-GARDENER-BRIEF.md`). You own `web/src/garden-art.ts`, `garden-style.ts`, `garden-fx*.ts`, `garden-ui.ts` and the new `design/art/`; keep any edit elsewhere minimal.

## The problem

The owner finds the plots ugly: each stage is a tiny flat SVG icon (a line and a leaf over a dark ellipse), and the motion is barely visible. The garden must look like a game.

## Step 1: illustrations from an image model (the owner generates them)

Write prompts into `design/art/PROMPTS.md` for one consistent set: seed, sprout, flower, fruit tree, cut stump, plus an empty soil bed and a background strip (sky and ground) that tiles horizontally. Style: soft, rounded, cosy game art; the brand palette (background #14102B, surface #1E1840, lime #9BE564, purple #836EF9) and warm accents; transparent background; the subject centred with its base on the bottom edge; 1024 x 1024; no text. Include a short "consistency block" to paste into every prompt and a negative list. Tell the owner in Chinese how to generate them and where to put the files (`design/art/`), then wait. While waiting, do step 2 with placeholders.

## Step 2: make them alive (whole-image animation, no layers needed)

- Idle per stage, pivoting at the base: seed gently breathes, sprout and flower sway a few degrees, fruit tree sways slowly and bobs, stump stays still with a falling leaf particle.
- Stage change: grow from small with a squash-and-stretch pop and a sparkle burst; prune: a cut and a leaf falling.
- Plots become garden beds on a scene (sky, ground strip, soft shadows), larger than today (about 120–160 px art on desktop, still readable at 390 px).
- Keep every text label next to the picture; keep reduced motion fully static; keep celebrations and sound as they are unless they clash.
- Optimise the images (WebP, a few tens of KB each); report the bundle and asset size change.

## Checks

Walk every stage and moment through `web/fake.html` at desktop and 390 px width, with and without reduced motion, and save screenshots to `docs/screens/art-*.png`. All tests keep passing; add tests for any new pure function.

## Red lines

Do not touch signing, sending, the guards, the ledger or the pipeline. No new runtime dependency. Do not push, deploy or change repository settings. Everything in the repository is English; texts about the project say only what it is and does. Reply to the owner in Chinese, conclusion first. Work on its own branch in a git worktree with small commits; tell the owner when done.
