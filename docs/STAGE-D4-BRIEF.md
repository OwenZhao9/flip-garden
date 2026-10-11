# Stage D, milestone 4: restyle the interface with the Stitch design (brief for a Sonnet 5.5 session)

## Goal

Replace the look of `web/` (the ledger page and the planting page) with the design made in Google Stitch (design system "Botanical Orderbook Protocol"), **without changing any number, the meaning of any label, any behaviour, or any test**.

## Inputs

- `design/stitch/`: the exported screens of the Stitch design (HTML and CSS, or screenshots): Home, Ledger result, Plant, Hedge, Sign in, and the design-system tile (colours and type). Put there by the main session.
- `docs/DESIGN-BRIEF.md`: the prompt that produced the design, the colour tokens taken from the logo, and the sample data.
- The current `web/` code, and the rules in `docs/STAGE-D-BRIEF.md` and `docs/STAGE-D2-BRIEF.md` (the safety statements shown before each wallet pop-up stay word for word).

## Decisions already made (the owner may change them)

1. **Layout, components and spacing come from the Stitch design; colours come from the logo**: violet-black surfaces (`#14102B`, `#1E1840`, `#261F52`), lime `#9BE564` as the primary accent, purple `#836EF9` as the secondary accent, plus mint `#5FE3A1`, amber `#FFC857` and coral `#FF6B7A` for success, warning and danger. The Stitch palette drifted away from the logo (most of its screens are dark green; only the first is violet), and the logo is already on the hackathon platform.
2. **Readable text**: body text at least 16 px, small uppercase labels at least 12 px, touch targets at least 44 px. The mock's tiny microcopy must be enlarged.
3. **Take no wording from the mock.** It contains claims that are untrue or unverified for this app ("Zero Signer Required", "Private keys never leave your secure enclave", "Secured by WebAuthn hardware enclave and Monad native account abstraction", "Zero Slippage", "Autonomous Liquidity Telemetry", "Zero-latency execution enclave") and invented numbers (for example "Funding rate 0.01% / 8h", the liquidation price and margin figures on the Hedge screen). All wording stays as in `web/src/i18n.ts` and the existing pages; labels may be shortened to fit but keep their meaning. Example numbers from the mock are never used.
   One addition to the wording, for safety: the first screen of the Plant page (before any wallet is connected) shows the sentence "Not yet verified with real money: use a throwaway wallet and a few dollars." It is the notice that today appears only in the risk list of the preview.
4. **The Hedge and Sign-in screens belong to later milestones.** Build the shared tokens and components they will need, but do not add those screens, any tab for them, or any feature. The mock's bottom tab bar keeps only tabs for features that exist today (Ledger and Plant).

## Deliverables

1. `web/style.css` rewritten around CSS variables (the tokens above), reusable components (reconciliation badge in three states, stat card, token balance card, plot tile in three states, order row with an indented child, fill row, buttons, input, progress stepper, accordion), dark theme only, 390 px first with a two-column desktop layout where it helps.
2. `web/index.html` and the rendering parts of `web/src/main.ts` and `web/src/plant.ts` updated to the new markup. **No change** to `web/src/model.ts`, `web/src/pipeline.ts`, or anything under `src/`: every number still comes from them.
3. Fonts: the system font stack by default. If the owner wants Space Grotesk and Inter, self-host the woff2 files inside `web/` (both are under the SIL Open Font License); no CDN requests. Ask the owner before adding font files.
4. Icons as inline SVG, no external images. The garden plots (planted, harvested, pruned) as small SVG tiles.
5. Verification: `npm test` stays green (121 tests); open the page locally in Chrome; compare each screen with the mock at 390 px by loading the page in a same-origin iframe of that width (the browser's window-resize call does not change the viewport; see `docs/FINDINGS.md`) and at desktop width; check no horizontal scroll, font sizes, and contrast (WCAG AA) with a script; the example wallet still gives six checks with difference 0 and the same figures; the `web/fake.html` planting walkthrough still works.

## Red lines

- No change to logic, numbers, caps, or the meaning of a label. No new runtime dependency. A PWA shell is not part of this milestone.
- Do not push, deploy or change repository settings; a push to `main` redeploys the public page.
- Everything written into the repository is English. Reply to the user in Chinese, conclusion first.

## When finished

Record what changed and what was not matched to the mock (and why) in `docs/FINDINGS.md` and the notes, and tell the user with screenshots of the 390 px and desktop views.
