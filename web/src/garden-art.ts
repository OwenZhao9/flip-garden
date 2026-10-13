// Growth stages as small inline SVG, shown when the 3D garden is not available. Fixed strings only (no user data),
// painted with the same palette as the 3D scene: gradients for soil, leaves, petals and fruit, and a soft glow. Every
// picture is paired with a text label wherever it is shown, so the stage is never told by colour or shape alone.
import type { Stage } from '../../src/garden.ts';

// Gradient ids must be unique on the page: a picture inside a hidden card must not be the one the others point to.
let serial = 0;

const wrap = (label: string, body: (id: (k: string) => string) => string, size: number): string => {
  const n = ++serial;
  const id = (k: string): string => `ga${n}${k}`;
  return `<svg class="ga" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${label}" focusable="false">${defs(id)}${body(id)}</svg>`;
};

const stop = (o: number, c: string, a = 1): string => `<stop offset="${o}" stop-color="${c}"${a < 1 ? ` stop-opacity="${a}"` : ''}/>`;

const defs = (id: (k: string) => string): string =>
  `<defs>` +
  `<radialGradient id="${id('s')}" cx="50%" cy="30%" r="70%">${stop(0, '#6a4434')}${stop(1, '#2c1b16')}</radialGradient>` +
  `<linearGradient id="${id('g')}" x1="0" y1="0" x2="0" y2="1">${stop(0, '#7cc75c')}${stop(1, '#2f6a40')}</linearGradient>` +
  `<linearGradient id="${id('l')}" x1="0" y1="1" x2="1" y2="0">${stop(0, '#3f7f3a')}${stop(1, '#b8f07a')}</linearGradient>` +
  `<radialGradient id="${id('p')}" cx="50%" cy="85%" r="90%">${stop(0, '#fff1cf')}${stop(0.35, '#d9d0ff')}${stop(1, '#836ef9')}</radialGradient>` +
  `<radialGradient id="${id('f')}" cx="35%" cy="30%" r="75%">${stop(0, '#ffe39a')}${stop(0.45, '#ffb04a')}${stop(1, '#e8662a')}</radialGradient>` +
  `<radialGradient id="${id('c')}" cx="40%" cy="25%" r="80%">${stop(0, '#b8f07a')}${stop(0.5, '#4fb064')}${stop(1, '#235a3e')}</radialGradient>` +
  `<linearGradient id="${id('b')}" x1="0" y1="0" x2="1" y2="0">${stop(0, '#553423')}${stop(0.5, '#8a5a3c')}${stop(1, '#553423')}</linearGradient>` +
  `<radialGradient id="${id('h')}">${stop(0, '#ffc857', 0.55)}${stop(1, '#ffc857', 0)}</radialGradient>` +
  `<radialGradient id="${id('v')}">${stop(0, '#b3a6ff', 0.5)}${stop(1, '#836ef9', 0)}</radialGradient>` +
  `</defs>`;

// a small mound of earth with a grassy rim, the same under every stage
const ground = (id: (k: string) => string): string =>
  `<ellipse cx="32" cy="56" rx="25" ry="7" fill="url(#${id('g')})"/>` +
  `<ellipse cx="32" cy="55" rx="15" ry="4.6" fill="url(#${id('s')})"/>` +
  `<path d="M10 55l1.5-3 1 3M16 58l1-3.2 1.2 3.2M47 58l1.2-3.4 1 3.4M53 55l1.4-3 1 3" fill="none" stroke="#9be564" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`;

const ART: Record<Stage, { label: string; body: (id: (k: string) => string) => string }> = {
  seed: {
    label: 'A seed resting in the soil',
    body: (id) =>
      `<circle cx="32" cy="48" r="13" fill="url(#${id('h')})" class="ga-pulse"/>${ground(id)}` +
      `<g class="ga-pulse"><path d="M24.5 51.5c0-5 4.4-8.5 9.5-8.5 4 0 6.5 2.6 6.5 5.6 0 3.7-4.6 5.4-9.4 5.4-3.6 0-6.6-.8-6.6-2.5z" fill="url(#${id('f')})"/>` +
      `<path d="M27.5 47.8c2.2-2 5.4-2.8 8.4-2.2" fill="none" stroke="#fff1cf" stroke-opacity=".75" stroke-width="1.4" stroke-linecap="round"/></g>`,
  },
  sprout: {
    label: 'A young sprout',
    body: (id) =>
      `${ground(id)}<g class="ga-sway">` +
      `<path d="M32 55c.6-6-.8-11 0-18" fill="none" stroke="url(#${id('l')})" stroke-width="3" stroke-linecap="round"/>` +
      `<path d="M31.5 38c-1-7-6.5-11.5-15-11.5-.4 7.5 5.5 12.5 15 11.5z" fill="url(#${id('l')})"/>` +
      `<path d="M32.5 38c1-7 6.5-11.5 15-11.5.4 7.5-5.5 12.5-15 11.5z" fill="url(#${id('l')})"/>` +
      `<path d="M30.5 37.2c-3.2-3.6-6.8-6-11.5-7.6M33.5 37.2c3.2-3.6 6.8-6 11.5-7.6" fill="none" stroke="#2f6a40" stroke-opacity=".55" stroke-width="1" stroke-linecap="round"/></g>`,
  },
  flower: {
    label: 'A flower in bloom',
    body: (id) => {
      const petals = Array.from({ length: 8 }, (_, i) => `<ellipse cx="32" cy="11.5" rx="4.6" ry="7.6" fill="url(#${id('p')})" transform="rotate(${i * 45} 32 19)"/>`).join('');
      return (
        `${ground(id)}<g class="ga-sway">` +
        `<path d="M32 55c1.5-8-1.6-15 0-27" fill="none" stroke="url(#${id('l')})" stroke-width="3" stroke-linecap="round"/>` +
        `<path d="M32 45c2-5.5 6.5-8 12-7.5-1.5 5.5-6 8.5-12 7.5z" fill="url(#${id('l')})"/>` +
        `<path d="M31.5 50c-2-4.5-5.8-6.6-10.5-6.2 1.2 4.6 5.2 7 10.5 6.2z" fill="url(#${id('l')})"/>` +
        `<circle cx="32" cy="19" r="17" fill="url(#${id('v')})"/>${petals}` +
        `<circle cx="32" cy="19" r="5.2" fill="url(#${id('f')})"/>` +
        `<circle cx="30.4" cy="17.6" r="1" fill="#e8662a"/><circle cx="33.6" cy="18" r="1" fill="#e8662a"/><circle cx="32" cy="20.6" r="1" fill="#e8662a"/></g>`
      );
    },
  },
  fruit: {
    label: 'A tree carrying fruit',
    body: (id) => {
      const fruit = (x: number, y: number, k: string): string =>
        `<g class="ga-bob${k}"><circle cx="${x}" cy="${y}" r="7" fill="url(#${id('h')})"/><circle cx="${x}" cy="${y}" r="3.9" fill="url(#${id('f')})"/>` +
        `<path d="M${x} ${y - 3.6}c.6-1.4 1.8-2.2 3.2-2.2-.4 1.4-1.6 2.2-3.2 2.2z" fill="#9be564"/></g>`;
      return (
        `${ground(id)}` +
        `<path d="M29.5 55.5c1.2-6 1-12-.5-19h6c-1.5 7-1.7 13-.5 19z" fill="url(#${id('b')})"/>` +
        `<path d="M31 42c-3-2.5-5-5.5-6-9M33.5 40c2.6-2.4 4.4-5.4 5.4-8.6" fill="none" stroke="#7a4f37" stroke-width="2.2" stroke-linecap="round"/>` +
        `<circle cx="20" cy="27" r="10" fill="url(#${id('c')})"/><circle cx="44" cy="26" r="10.5" fill="url(#${id('c')})"/>` +
        `<circle cx="32" cy="20" r="13.5" fill="url(#${id('c')})"/><circle cx="32" cy="31" r="9" fill="url(#${id('c')})"/>` +
        fruit(23, 29, '') + fruit(40, 22, ' b2') + fruit(33, 33, ' b3')
      );
    },
  },
  pruned: {
    label: 'A cut stem',
    body: (id) =>
      `${ground(id)}` +
      `<path d="M24 54.5l1.4-12h13.2l1.4 12z" fill="url(#${id('b')})"/>` +
      `<ellipse cx="32" cy="42.5" rx="6.6" ry="2.6" fill="#e8c08a"/>` +
      `<ellipse cx="32" cy="42.5" rx="4.2" ry="1.6" fill="none" stroke="#c99a64" stroke-width=".8"/><ellipse cx="32" cy="42.5" rx="1.8" ry=".7" fill="#c99a64"/>` +
      `<path d="M21 54l3-1.2.6 1.4zM41.5 53.6l2.8.4-1.4 1.4z" fill="#e8c08a"/>` +
      `<path class="ga-drop" d="M44 39c3-3 7-3.2 9.5-1.6-2.4 3.2-6.4 3.6-9.5 1.6z" fill="#d0b45a"/>`,
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
