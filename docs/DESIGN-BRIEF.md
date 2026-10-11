# Design brief for the Flip Garden interface

Purpose: the prompt given to an AI interface-design tool (or an image model) to redesign the look of the web app. The first version of `web/` was styled only as far as needed to get the numbers right. A restyle will be applied to `web/` after the planting flow (stage D, milestone 2) has merged, so the two do not conflict. The numbers and labels on screen always come from the ledger code; a design only supplies layout, colour, type and components.

How to use a design that comes back (HTML and CSS, or screenshots):

- Keep `web/src/model.ts`, `web/src/pipeline.ts` and every test untouched. Only `web/index.html`, `web/style.css` and the rendering part of `web/src/main.ts` change.
- All amounts stay integers with fixed-point formatting; the design never changes a number or a label's meaning.
- Use the design tokens below as CSS variables.

## The prompt

```text
Design a mobile-first web app called "Flip Garden" (design only, no logic). Output clean, framework-free HTML + CSS (one file per screen, or one file with all screens), with all colors, spacing and type sizes as CSS variables, semantic class names, icons as inline SVG, and no external images.

PRODUCT
Flip Garden lets anyone plant a few dollars as "flip orders" on Kuru (an on-chain order book on the Monad blockchain), watch real fills, and read an honest ledger of every gain and loss. A flip order is a limit order that, once filled, automatically places the opposite order at a price you choose. The garden is a light metaphor: each price level is a plot; a resting buy order is "planted", a filled order is "harvested", a cancelled order is "pruned". The numbers must stay sober, exact and trustworthy. The garden feel lives in small illustrations, icons and plot tiles, never in the numbers. Think calm, premium fintech with a gentle botanical touch, not a cartoon farm game.

BRAND
Logo: a lime-green seedling inside a purple double-arrow loop on a deep violet-black square. Dark theme only.
Tokens: background #14102B, surface #1E1840, surface-raised #261F52, border #2E2760, text #F4F1FF, muted text #A79FD0, brand lime #9BE564, brand purple #836EF9, success mint #5FE3A1, warning amber #FFC857, danger coral #FF6B7A.
Typography: a clean geometric sans (Inter or similar). Money and figures use tabular numerals. Body text at least 16px. Hero numbers large and calm.
Layout: designed for a 390x844 phone first (single column, 16px side margins, touch targets at least 44px), plus a desktop layout (max content width 1080px, two columns where it helps). Rounded corners (16px), soft borders instead of heavy shadows, generous spacing.

SCREENS (use exactly the sample data below; never invent other numbers)
1. Home: the logo and name, a one-line promise, a wallet address field, a "Try the example wallet" button, and a short note: "Read-only: this page never connects a wallet, never asks for a signature and never sends a transaction."
2. Ledger result (the main screen), top to bottom:
   - Reconciliation hero card with three states to show side by side: "Matches the chain" (mint), "Cannot be fully explained" (amber), "Does not match" (coral). Default state: Matches. Text: "All 6 checks agree with the chain to the last raw unit (difference 0) at block 112,211,600." Plus a collapsible "Show the individual checks".
   - The garden: a grid of plot tiles, one per order: a Buy at 0.024761 (Harvested) and a Sell at 0.024786 (Pruned). Legend: Planted = still resting in the order book, Harvested = filled, Pruned = cancelled.
   - Balances: two token cards. USDC: In wallet 2.986345, Free in Kuru 0, Locked in orders 0, Total in Kuru 0. MON: In wallet 239.95705, Free in Kuru 0, Locked in orders 0, Total in Kuru 0. Line: "Wallet + Kuru, at mid price: 8.912924 USDC".
   - Money: Cash change from fills -4.976961 USDC (negative, coral); Coin change from fills +201 MON; Network fees (gas) 0.095135 MON; Kuru trading fees 0; Realized profit 0 USDC; Open position at mid price -0.012563 USDC; Open position if sold now -0.015879 USDC; Growth on capital, after gas -0.25%.
   - Orders and flip chains: Order #122927284, Buy, price 0.024761, flips to 0.024786, size 201, filled 201, status Filled, "Planted by you", blocks 112,210,402 to 112,210,404; and its child, indented with a connector line: #122927286, Sell, price 0.024786, flips to 0.024761, size 201, filled 0, status Cancelled, "Flipped out of #122927284", blocks 112,210,404 to 112,211,494.
   - Fills, seen from the owner's side: Block 112,210,404, "Bought" 201 MON at 0.024761, value 4.976961 USDC, fee 0, order #122927284 flipped into #122927286, transaction 0xa0c7...43ce.
   - A collapsible "How this is calculated" section and a footer: "Read-only. Data from the public Monad RPC."
3. Plant (preview and confirm; a future screen): a budget field in USDC (cap 15), a number of levels (1 to 3), a preview table with one example row (level 1, bid price 0.025127, flip price 0.025153, size 201 MON, USDC locked 5.050527, gross profit per full round trip 0.005226 USDC), a plain-words risk note, a primary "Confirm in your wallet" button, and a 3-step progress indicator (Approve, Deposit, Plant). Everything is labelled "Preview" until confirmed.
4. Hedge (a future screen): MON inventory held from filled buys (201 MON), a hedge slider (0 to 100%), the resulting short size, margin needed in AUSD, and an estimated liquidation price; show these as clearly tagged "Example values". A "Close hedge" button is always visible.
5. Sign in (a future screen): a primary "Sign in with Face ID / passkey" button, one line on what it does ("No seed phrase, no extension"), and a small AUSD balance chip shown after sign-in.

COMPONENTS to define once and reuse: reconciliation badge (3 states), stat card, token balance card, plot tile (3 states), order row with an indented child, fill row, bottom sheet, primary / secondary / destructive buttons, input, progress stepper, accordion.

RULES: English only. No fake logos or partner marks. No gradients behind numbers. Accessible contrast (WCAG AA). Do not add features that are not listed above.
```
