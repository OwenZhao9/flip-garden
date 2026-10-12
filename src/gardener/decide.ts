// Deciders: who picks among the options the policy allows. The rules decider always takes the policy's own default with
// full confidence. The Jev decider asks the Worker's POST /decide (which holds the API key) and gives up after 2 s; any
// problem (timeout, HTTP error, malformed answer) means "no answer", and no answer means the Gardener does nothing.
import type { Answer, Observation, Question } from './policy.ts';
import type { Mandate } from './mandate.ts';
import { jevState, parseAnswers, type DecideRequest } from './questions.ts';

export type DecideContext = { obs: Observation; mandate: Mandate; failures: number; checkSeconds: number };
export interface Decider {
  readonly name: 'rules' | 'jev';
  // One answer (or null) per question, same order.
  decide(qs: Question[], ctx: DecideContext): Promise<(Answer | null)[]>;
}

export const rulesDecider: Decider = {
  name: 'rules',
  decide: async (qs) => qs.map((q) => ({ choice: q.rulesChoice, confidence: 1, source: 'rules' as const })),
};

export const DECIDE_TIMEOUT_MS = 2_000;

// One Jev call per question kind present (the Worker evaluates them in parallel). Each question carries its own state
// slice; questions are therefore sent as separate requests and raced against the same deadline.
export function jevDecider(o: { url: string; fetchImpl?: typeof fetch; timeoutMs?: number; onLatency?: (ms: number) => void; now?: () => number }): Decider {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeout = o.timeoutMs ?? DECIDE_TIMEOUT_MS;
  const now = o.now ?? (() => Date.now());
  async function one(q: Question, ctx: DecideContext): Promise<Answer | null> {
    const req: DecideRequest = { questions: [{ key: q.id, id: q.id, options: [...q.options] }], state: jevState(q, ctx.obs, ctx.mandate, ctx.failures, ctx.checkSeconds) };
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const started = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        f(o.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal: ctl?.signal }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl?.abort(); rej(new Error('timeout')); }, timeout); }),
      ]);
      if (!res.ok) return null;
      const body = (await res.json()) as { model?: unknown };
      o.onLatency?.(now() - started);
      const a = parseAnswers(body, req)[q.id];
      return a ? { ...a, source: 'jev', model: typeof body.model === 'string' ? body.model.slice(0, 40) : undefined } : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { name: 'jev', decide: (qs, ctx) => Promise.all(qs.map((q) => one(q, ctx))) };
}
