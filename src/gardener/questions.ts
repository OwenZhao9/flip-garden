// The Gardener's questions for Jev and the minimal state sent with them. Shared by the page (which builds the state) and
// the Worker (which validates it and builds the Jev request itself), so the Worker can only ever ask these questions.
// Pure functions, no I/O. See docs/JEV.md for the request format and why each field is sent.
import { OPTIONS, gardenMon, lockedUsdc, spreadBps, type Observation, type Question, type QuestionId } from './policy.ts';
import type { Mandate } from './mandate.ts';
import { formatUnits } from '../units.ts';

export const JEV_MODEL = 'jev-1.13.0'; // pinned: the thresholds were set against this version (docs/JEV.md)

type Def = { instructions: string; criteria: Record<string, string> };
export const DEFS: Record<QuestionId, Def> = {
  tend: {
    instructions:
      'A small market maker has a resting limit buy (a flip bid) on the MON-USDC order book that now sits further under the best bid than the owner allows (`bid.distance_bps`). Given the recent mid-price path, what should happen to this bid now?',
    criteria: {
      keep: 'Leave it: the price is likely to come back down to the bid soon, or the move is noise.',
      requote: 'Cancel it and place the same size again one tick above the best bid, because the market has moved up and away.',
      prune: 'Cancel it and leave the money free, because the market looks unstable or one-directional and buying now is unwise.',
    },
  },
  recover: {
    instructions:
      'A small market maker has USDC free on the exchange and no buy order resting, usually after a failed or interrupted order. Given the recent mid-price path, spread and recent failures, should a new buy be placed one tick above the best bid now?',
    criteria: {
      wait: 'Not now: the market is moving fast, the spread is unusual, or recent attempts failed, so wait for calmer conditions.',
      replant: 'Yes: conditions are ordinary, place the buy now.',
    },
  },
  hedge: {
    instructions:
      'A small market maker holds MON bought by its orders and a short position on a perpetual market that offsets part of it. The hedge ratio (`hedge.ratio_pct`, short divided by MON held) is outside the owner range (`hedge.range_pct`). Should the short be adjusted back to the middle of the range now?',
    criteria: {
      hold: 'Not now: the imbalance is likely to correct itself soon (for example a resting sell is about to fill), or the market is too fast to trade.',
      adjust: 'Yes: bring the hedge back into the range now.',
    },
  },
  harvest: {
    instructions: 'A small market maker has money sitting idle on the exchange with no order using it. Should it be withdrawn to the wallet now?',
    criteria: {
      leave: 'Leave it on the exchange: it is likely to be used for a new order soon.',
      harvest: 'Withdraw it: it has been idle and nothing in the state suggests it will be used soon.',
    },
  },
};

// --- the state: numbers only, in human units, nothing that identifies the user --------------------------------------

export type JevState = {
  market: { mid_path: number[]; spread_bps: number; checks_apart_seconds: number };
  bid?: { distance_bps: number; owner_limit_bps: number };
  money?: { free_usdc: number; locked_usdc: number; budget_usdc: number; free_mon: number; idle_minutes: number };
  hedge?: { mon_held: number; short_mon: number; ratio_pct: number | null; range_pct: [number, number] };
  recent_failures: number;
};

const n = (x: bigint, d: number, frac = 6): number => Number(formatUnits(x, d, frac));

export function jevState(q: Question, o: Observation, m: Mandate, failures: number, checkSeconds: number): JevState {
  const pd = Math.round(Math.log10(Number(o.market.pricePrecision)));
  const s: JevState = {
    market: { mid_path: o.mids.slice(-20).map((x) => n(x, pd, 8)), spread_bps: Number(spreadBps(o.book)), checks_apart_seconds: checkSeconds },
    recent_failures: failures,
  };
  if (q.id === 'tend') s.bid = { distance_bps: Number(q.facts.distanceBps ?? 0n), owner_limit_bps: Number(m.bandBps) };
  if (q.id === 'recover' || q.id === 'harvest' || q.id === 'tend') {
    s.money = { free_usdc: n(o.marginUsdc, 6), locked_usdc: n(lockedUsdc(o), 6), budget_usdc: n(m.usdcBudget, 6), free_mon: n(o.marginMon, 18, 4), idle_minutes: Math.floor((q.facts.idleMs ?? 0) / 60_000) };
  }
  if (q.id === 'hedge') {
    const r = q.facts.ratioBps;
    s.hedge = { mon_held: Number(gardenMon(o)), short_mon: Number(o.hedge?.shortLot ?? 0n), ratio_pct: r === null || r === undefined ? null : Number(r) / 100, range_pct: [Number(m.hedgeMinBps) / 100, Number(m.hedgeMaxBps) / 100] };
  }
  return s;
}

// --- validation, run by the Worker on what the page sends --------------------------------------------------------------

export type DecideRequest = { questions: { key: string; id: QuestionId; options: string[] }[]; state: JevState };

const isNum = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const onlyKeys = (o: unknown, keys: string[]): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));

export function parseDecideRequest(body: unknown): { ok: true; value: DecideRequest } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!onlyKeys(body, ['questions', 'state'])) return bad('Unexpected fields.');
  const qs = body.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return bad('Between 1 and 4 questions.');
  const seen = new Set<string>();
  for (const q of qs) {
    if (!onlyKeys(q, ['key', 'id', 'options'])) return bad('A question has unexpected fields.');
    if (typeof q.key !== 'string' || !/^[a-z]{1,12}$/.test(q.key) || seen.has(q.key)) return bad('Question keys must be short, lower-case and unique.');
    seen.add(q.key);
    if (typeof q.id !== 'string' || !(q.id in OPTIONS)) return bad('Unknown question.');
    const allowed = OPTIONS[q.id as QuestionId] as readonly string[];
    if (!Array.isArray(q.options) || q.options.length < 2 || !q.options.every((x) => typeof x === 'string' && allowed.includes(x)) || new Set(q.options).size !== q.options.length) return bad('Options must be at least two of the fixed options for the question.');
  }
  const s = body.state;
  if (!onlyKeys(s, ['market', 'bid', 'money', 'hedge', 'recent_failures'])) return bad('Unexpected state fields.');
  if (!onlyKeys(s.market, ['mid_path', 'spread_bps', 'checks_apart_seconds'])) return bad('Bad market state.');
  const mk = s.market;
  if (!Array.isArray(mk.mid_path) || mk.mid_path.length < 1 || mk.mid_path.length > 20 || !mk.mid_path.every((x) => isNum(x, 0, 1e6))) return bad('Bad mid-price path.');
  if (!isNum(mk.spread_bps, 0, 10_000) || !isNum(mk.checks_apart_seconds, 0, 3600)) return bad('Bad market numbers.');
  if (!isNum(s.recent_failures, 0, 100) || !Number.isInteger(s.recent_failures)) return bad('Bad failure count.');
  if (s.bid !== undefined && !(onlyKeys(s.bid, ['distance_bps', 'owner_limit_bps']) && isNum(s.bid.distance_bps, 0, 10_000) && isNum(s.bid.owner_limit_bps, 0, 10_000))) return bad('Bad bid state.');
  if (s.money !== undefined) {
    const x = s.money;
    if (!(onlyKeys(x, ['free_usdc', 'locked_usdc', 'budget_usdc', 'free_mon', 'idle_minutes']) && isNum(x.free_usdc, 0, 1e6) && isNum(x.locked_usdc, 0, 1e6) && isNum(x.budget_usdc, 0, 1e6) && isNum(x.free_mon, 0, 1e9) && isNum(x.idle_minutes, 0, 1e6))) return bad('Bad money state.');
  }
  if (s.hedge !== undefined) {
    const x = s.hedge;
    if (!(onlyKeys(x, ['mon_held', 'short_mon', 'ratio_pct', 'range_pct']) && isNum(x.mon_held, 0, 1e9) && isNum(x.short_mon, 0, 1e9) && (x.ratio_pct === null || isNum(x.ratio_pct, 0, 1e6)) && Array.isArray(x.range_pct) && x.range_pct.length === 2 && x.range_pct.every((v) => isNum(v, 0, 100)))) return bad('Bad hedge state.');
  }
  return { ok: true, value: { questions: qs as DecideRequest['questions'], state: s as unknown as JevState } };
}

// The Jev request for a validated decide request: only the offered options of each fixed question.
export function jevRequest(r: DecideRequest): { state: JevState; model: string; questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> } {
  const questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> = {};
  for (const q of r.questions) {
    const d = DEFS[q.id];
    questions[q.key] = { type: 'choice', instructions: d.instructions, criteria: Object.fromEntries(q.options.map((o) => [o, d.criteria[o]])) };
  }
  return { state: r.state, model: JEV_MODEL, questions };
}

// --- validating an answer (the Worker on Jev's reply, the page again on the Worker's reply) -------------------------------

export type ChoiceAnswer = { choice: string; probabilities: Record<string, number>; confidence: number };

// The confidence is recomputed from the probabilities with the documented formula ((p_max - 1/n) / (1 - 1/n)), so a
// reported number never counts for more than the distribution behind it.
export function parseChoice(a: unknown, options: string[]): ChoiceAnswer | null {
  if (!a || typeof a !== 'object') return null;
  const x = a as { type?: unknown; choice?: unknown; probabilities?: unknown };
  if (x.type !== undefined && x.type !== 'choice') return null;
  if (typeof x.choice !== 'string' || !options.includes(x.choice)) return null;
  const p = x.probabilities;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const entries = Object.entries(p as Record<string, unknown>);
  if (!entries.every(([k, v]) => options.includes(k) && isNum(v, 0, 1))) return null;
  const probs: Record<string, number> = Object.fromEntries(options.map((o) => [o, (p as Record<string, number>)[o] ?? 0]));
  const sum = Object.values(probs).reduce((s, v) => s + v, 0);
  if (Math.abs(sum - 1) > 0.02) return null;
  const top = Math.max(...Object.values(probs));
  if (probs[x.choice] < top - 1e-9) return null; // the named choice must be the most probable one
  const k = options.length;
  const confidence = Math.max(0, Math.min(1, (top - 1 / k) / (1 - 1 / k)));
  return { choice: x.choice, probabilities: probs, confidence };
}

export function parseAnswers(body: unknown, r: Pick<DecideRequest, 'questions'>): Record<string, ChoiceAnswer | null> {
  const answers = (body && typeof body === 'object' ? (body as { answers?: unknown }).answers : undefined) as Record<string, unknown> | undefined;
  const out: Record<string, ChoiceAnswer | null> = {};
  for (const q of r.questions) out[q.key] = answers && typeof answers === 'object' ? parseChoice(answers[q.key], q.options) : null;
  return out;
}
