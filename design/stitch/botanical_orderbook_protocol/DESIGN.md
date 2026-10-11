---
name: Botanical Orderbook Protocol
colors:
  surface: '#10150c'
  surface-dim: '#10150c'
  surface-bright: '#363b31'
  surface-container-lowest: '#0b1008'
  surface-container-low: '#181d14'
  surface-container: '#1c2118'
  surface-container-high: '#272b22'
  surface-container-highest: '#31362c'
  on-surface: '#e0e4d6'
  on-surface-variant: '#c1cab5'
  inverse-surface: '#e0e4d6'
  inverse-on-surface: '#2d3228'
  outline: '#8b9480'
  outline-variant: '#414939'
  surface-tint: '#91da5b'
  primary: '#91da5b'
  on-primary: '#183800'
  primary-container: '#448608'
  on-primary-container: '#ffffff'
  inverse-primary: '#336b00'
  secondary: '#b0d094'
  on-secondary: '#1e370b'
  secondary-container: '#334e1f'
  on-secondary-container: '#9fbf84'
  tertiary: '#f3b5cd'
  on-tertiary: '#4c2336'
  tertiary-container: '#9c677d'
  on-tertiary-container: '#ffffff'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#acf774'
  primary-fixed-dim: '#91da5b'
  on-primary-fixed: '#0b2000'
  on-primary-fixed-variant: '#255100'
  secondary-fixed: '#ccedaf'
  secondary-fixed-dim: '#b0d094'
  on-secondary-fixed: '#0b2000'
  on-secondary-fixed-variant: '#334e1f'
  tertiary-fixed: '#ffd8e5'
  tertiary-fixed-dim: '#f3b5cd'
  on-tertiary-fixed: '#330e20'
  on-tertiary-fixed-variant: '#66394c'
  background: '#10150c'
  on-background: '#e0e4d6'
  surface-variant: '#31362c'
typography:
  headline-xl:
    fontFamily: Space Grotesk
    fontSize: 36px
    fontWeight: '600'
    lineHeight: 44px
  headline-xl-mobile:
    fontFamily: Space Grotesk
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  headline-sm:
    fontFamily: Space Grotesk
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  label-lg:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  label-sm:
    fontFamily: Inter
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 14px
  data-mono-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  data-mono-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  data-mono-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  margin: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

## Brand & Style

This design system expresses a vibrant botanical fintech aesthetic engineered specifically for automated high-velocity on-chain trading. It synthesizes deep, earthy twilight environments with precise, disciplined algorithmic financial tools.

- **Personality**: Calm, sober, sovereign, and deeply organic yet surgically precise.
- **Tone**: Quiet confidence and institutional stability over degen hype or volatile neon clutter.
- **Visual Movement**: Muted botanical precision—pairing the deep, rhythmic depth of nocturnal flora with structural orderbook data tables, restrained luminosity, and tactile container layers.
- **Emotional Intent**: Reassure operators through visual grounding, clear risk-state clarity, zero eye fatigue during extended terminal sessions, and uncompromising information hierarchy.

## Colors

The palette grounds high-throughput trading mechanics in an organic, twilight ecosystem. Surfaces ascend in luminosity as they elevate closer to the user interaction layer.

- **Foundations**:
  - Deep Twilight Background: `#151314` (primary viewport base)
  - Nocturnal Surface: `#221f20` (default container and panel base)
  - Surface Raised: `#373435` (active states, dropdowns, modal cards)
  - Subtle Perimeter Border: `#4d4449` (structural 1px perimeter outlines)
- **Typography & Communication**:
  - Primary Content: `#e8e1e2` (contrast ratio exceeds 12:1 against core surfaces)
  - Secondary/Botanical Mist: `#d0c3c8` (metadata, passive keys, secondary axes)
- **Signal Accents & Execution**:
  - Vibrant Green (`#448608`): Primary system action, automated flip status active, selected tabs.
  - Olive Sage (`#627f4b`): Secondary network state, execution badges, routing markers.
  - Pink Blossom (`#ffc0d8`): Positive delta, order filled, bid-side depth.
  - Pollen Amber (`#ffb4ab`): Fill warning, partial cancel, elevated network latency.
  - Coral Root (`#ffb4ab`): Liquidation proximity, order cancel, ask-side depth.

Strict guardrail: Never apply gradients or chromatic blurs directly beneath tabular financial metrics or numerical strike values. Every balance, price, and slippage rate must sit against a solid, unadulterated surface fill.

## Typography

The typographic hierarchy prioritizes structural discipline and instant analytical readability under rapid order-book state transitions.

- **Headlines (`Space Grotesk`)**: Technical yet organic geometric construction that introduces character in headers, pair titles, and primary modal titles without sacrificing horizontal space.
- **Interface & Text (`Inter`)**: Deployed across body copy, labels, tooltips, and interactive triggers for clinical legibility and neutral phrasing.
- **Numerical Data & Values (`Inter` with OpenType `tnum` + `cv05`)**: All monetary figures, order sizes, limit prices, tick deltas, and timestamps must strictly declare `font-feature-settings: "tnum" 1, "zero" 1`. This prevents column jitter during orderbook ticks and provides instant vertical scanning across multi-level order books.

## Layout & Spacing

This design system uses a mobile-first fluid layout optimized for immediate thumb access and high-density financial metrics.

- **Mobile Viewports (<640px)**:
  - 4-column layout model with `margin: 1rem` (16px) and `gutter: 0.75rem` (12px).
  - Bottom-anchored action zones with pinned navigation controls, ensuring core flip execution triggers fall within natural ergonomic thumb reach.
  - Horizontal swipeable trays for market pairs and active orderbook liquidity bands.
- **Tablet & Compact Desktop (641px - 1024px)**:
  - 8-column layout with `margin: 1.5rem` (24px) and `gutter: 1rem` (16px).
  - Split dashboard structure pairing visual depth charts alongside running terminal logs.
- **Desktop (>1025px)**:
  - 12-column layout capped at 1280px maximum content width.
  - Three-pane financial workspace: pair telemetry on the left, orderbook depth in the center, and automated flip rule orchestration on the right.
- **Rhythm Rules**:
  - Vertical stack cadence relies strictly on `space-xs` (4px) for paired key-values, `space-sm` (8px) for list element separation, and `space-md` (16px) for module interiors.
  - Maintain a strict minimum 44px boundary on all mobile interactive touch surfaces.

## Elevation & Depth

Visual hierarchy rejects exaggerated drop shadows in favor of a tonal surface stack reinforced by botanical illumination and crisp, low-contrast borders.

- **Tier 0 (Base Canvas)**: Solid `#151314`. Contains zero atmospheric glow; acts as the deepest canvas layer.
- **Tier 1 (Resting Cards & Book Shells)**: Solid `#221f20` bounded by a 1px border of `#4d4449`.
- **Tier 2 (Active Containers & Overlays)**: Surface `#373435` accented with a restrained, directional boundary. Outer glow is strictly reserved for primary status triggers: `0 0 16px rgba(68, 134, 8, 0.12)`.
- **Tier 3 (Floating Sheets & Confirmation Trays)**: Surface `#373435` with an ambient diffused shadow: `0 8px 32px rgba(16, 14, 14, 0.65)` enclosed by `#4d4449`.
- **Tactile Botanical Bloom**: Active toggle switches and running flip states emit a localized, low-spread aura (`0 0 8px rgba(255, 192, 216, 0.25)`) indicating live execution without bleeding into numeric reading zones.

## Shapes

The geometric framework is defined by a consistent 16px radius curve (`roundedness: 2`), balancing organic softness with financial order.

- **Cards & Data Modules**: Standard 16px (`1rem`) border radius on all external container vertices.
- **Form Fields & Command Triggers**: 12px to 16px curvature to yield comfortable touch targets that match enclosing card corners.
- **Pills, Order Tags & Badges**: Fully rounded continuous pills (`9999px`) to immediately distinguish categorical statuses from clickable square-cornered surface blocks.
- **Nested Corner Rule**: Enclosed children adopt concentric geometry where inner radius = `outer radius - padding` (e.g., a card with 16px radius and 8px interior padding yields an 8px corner for nested inner segments).

## Components

### Buttons
- **Primary Action (Execute/Deposit Flip)**: Full `#448608` vibrant green fill with light `#e8e1e2` label text (Space Grotesk, bold). 48px minimum height for mobile thumb reliability. Zero background gradients. Hover state elevates brightness by 5%; pressed state applies a slight scale compression (0.98).
- **Secondary Action (Manage Order/Modify)**: Transparent base with `#4d4449` border and `#e8e1e2` label. Hover shifts background to `#373435`.
- **Destructive/Emergency Flip Cancel**: Transparent base with `#ffb4ab` border and text. On active touch, fills with 12% `#ffb4ab` tint.

### Inputs & Number Steppers
- Built strictly with `#221f20` backgrounds, 16px radii, and 1px `#4d4449` perimeters. Minimum height of 48px.
- Typographic layer uses `Inter` with tabular figures enabled.
- Integrated currency toggles and "Max" chips sit inset right, maintaining minimum 44px tap areas with distinct `#373435` chip backings.
- Error state: 1px border swap to `#ffb4ab` with immediate validation feedback below.

### Orderbook Lists & Spread Displays
- Compact rows (32px height on desktop, 40px touch on mobile) with tabular-aligned figures.
- Bid/Ask depth visualizations use horizontal bar fills anchored to right/left with solid low-opacity fills (`rgba(255, 192, 216, 0.12)` for bids, `rgba(255, 180, 171, 0.12)` for asks).
- Text metrics always render in crisp `#e8e1e2`, floating uncompromised on top of depth indicators.

### Status Chips & Badges
- Pill shape (`rounded-full`), 24px height, with a 6px diameter status dot at the leading edge.
- Automated Active: `#ffc0d8` dot with `rgba(255, 192, 216, 0.15)` fill and matching text.
- Paused/Cooling: `#ffb4ab` dot with `rgba(255, 180, 171, 0.15)` fill.
- Terminated: `#ffb4ab` dot with `rgba(255, 180, 171, 0.15)` fill.

### Cards & Container Panels
- Base `#221f20` layer with 16px radii and `#4d4449` 1px border.
- Headers separate title from action menus using a bottom border of 1px `#4d4449` and `space-md` padding.
- Card interiors never use gradients or visual noise that could degrade glanceable data consumption.

### Checkboxes, Radios, and Toggles
- Custom controls utilizing `#151314` wells and `#4d4449` resting rings.
- Active toggle track transitions to `#448608` with a crisp `#151314` slider knob.
- Touch target wrapping bounds must measure at least 44x44px even if the rendered visual control is 20px.