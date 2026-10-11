// Growth stages as small inline SVG. Fixed strings only (no user data), coloured through the classes in
// garden-style.ts so they follow the page tokens. Every picture is paired with a text label wherever it is shown,
// so the stage is never told by colour or shape alone.
import type { Stage } from '../../src/garden.ts';

const wrap = (label: string, body: string, size: number): string =>
  `<svg class="ga" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${label}" focusable="false">${body}</svg>`;

const soil = '<ellipse class="ga-soil" cx="32" cy="55" rx="23" ry="6.5"/>';

const ART: Record<Stage, { label: string; body: string }> = {
  seed: {
    label: 'A seed resting in the soil',
    body: `${soil}<g class="ga-pulse"><ellipse class="ga-seed" cx="32" cy="49" rx="6" ry="4" transform="rotate(-18 32 49)"/><path class="ga-line" d="M28 46.5c2.5-1.6 5.5-2 8-1.2"/></g>`,
  },
  sprout: {
    label: 'A young sprout',
    body: `${soil}<g class="ga-sway"><path class="ga-stem" d="M32 54V34"/><path class="ga-leaf" d="M32 40c0-6 3.5-9.5 10-9.5 0 6-3.5 9.5-10 9.5z"/><path class="ga-leaf" d="M32 44c0-5-3-8-8.5-8 0 5 3 8 8.5 8z"/></g>`,
  },
  flower: {
    label: 'A flower in bloom',
    body: `${soil}<g class="ga-sway"><path class="ga-stem" d="M32 54V27"/><path class="ga-leaf" d="M32 45c0-5 3-8 8.5-8 0 5-3 8-8.5 8z"/><g class="ga-petal"><circle cx="32" cy="14" r="5.5"/><circle cx="40" cy="20" r="5.5"/><circle cx="37" cy="29" r="5.5"/><circle cx="27" cy="29" r="5.5"/><circle cx="24" cy="20" r="5.5"/></g><circle class="ga-core" cx="32" cy="23" r="5"/></g>`,
  },
  fruit: {
    label: 'A tree carrying fruit',
    body: `${soil}<path class="ga-trunk" d="M32 55V34"/><circle class="ga-canopy" cx="32" cy="23" r="15"/><circle class="ga-fruit ga-bob" cx="25" cy="22" r="3.6"/><circle class="ga-fruit ga-bob b2" cx="38" cy="19" r="3.6"/><circle class="ga-fruit ga-bob b3" cx="33" cy="30" r="3.6"/>`,
  },
  pruned: {
    label: 'A cut stem',
    body: `${soil}<path class="ga-stem" d="M32 54V40"/><path class="ga-cut" d="M27 40l10-6"/><path class="ga-fallen ga-drop" d="M41 50l9 3"/>`,
  },
};

export const stageArt = (stage: Stage, size = 64): string => wrap(ART[stage].label, ART[stage].body, size);
export const STAGE_LABEL: Record<Stage, string> = { seed: 'Seed', sprout: 'Sprout', flower: 'Flower', fruit: 'Fruit', pruned: 'Pruned' };
export const STAGE_EXPLAIN: Record<Stage, string> = {
  seed: 'Planted and resting. Nothing has filled yet.',
  sprout: 'Partly filled.',
  flower: 'One leg is completely filled and the flipped order is waiting.',
  fruit: 'A completed round trip: a leg filled and the flipped leg filled too.',
  pruned: 'Cut: the newest order of this plot was cancelled.',
};
