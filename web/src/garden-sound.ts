// A few short WebAudio tones for celebrations. Off by default; the choice is remembered in localStorage (per viewer).
// The audio context is only created after the visitor switches sound on (a click), so no browser autoplay rule is hit.
import { defaultStore, SOUND_KEY, type StoreLike } from './garden-fx.ts';

export type Cue = 'stage' | 'first-fill' | 'achievement' | 'level-up';

// Note frequencies in Hz and the gap between notes, in seconds.
const CUES: Record<Cue, { notes: number[]; gap: number }> = {
  stage: { notes: [523.25, 659.25], gap: 0.09 },
  'first-fill': { notes: [523.25, 783.99], gap: 0.12 },
  achievement: { notes: [523.25, 659.25, 783.99], gap: 0.11 },
  'level-up': { notes: [523.25, 659.25, 783.99, 1046.5], gap: 0.12 },
};

type Ctx = { currentTime: number; destination: unknown; createOscillator(): any; createGain(): any; resume?(): Promise<void> };

export type Sound = { enabled(): boolean; set(on: boolean): void; play(cue: Cue): void };

export function createSound(store: StoreLike | null = defaultStore(), makeCtx?: () => Ctx | null): Sound {
  let on = false;
  try {
    on = store?.getItem(SOUND_KEY) === '1';
  } catch {
    on = false;
  }
  let ctx: Ctx | null = null;
  const context = (): Ctx | null => {
    if (ctx) return ctx;
    try {
      const make = makeCtx ?? (() => { const C = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext; return C ? new C() : null; });
      ctx = make();
    } catch {
      ctx = null;
    }
    return ctx;
  };
  const play = (cue: Cue): void => {
    if (!on) return;
    const c = context();
    if (!c) return;
    try {
      void c.resume?.();
      const { notes, gap } = CUES[cue];
      notes.forEach((hz, i) => {
        const t = c.currentTime + i * gap;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        osc.connect(gain);
        gain.connect(c.destination);
        osc.start(t);
        osc.stop(t + 0.22);
      });
    } catch {
      // sound is a nicety; never let it break the page
    }
  };
  return {
    enabled: () => on,
    set(v) {
      on = v;
      try {
        store?.setItem(SOUND_KEY, v ? '1' : '0');
      } catch {
        // not remembered
      }
      if (v) play('stage'); // a short sample so the visitor hears what they switched on
    },
    play,
  };
}
