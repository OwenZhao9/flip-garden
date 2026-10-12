// POST /decide: the Gardener's only door to Jev. The Jev API key is a Worker secret (JEV_API_KEY, set by the owner with
// `wrangler secret put JEV_API_KEY`); it never reaches the page. The endpoint accepts only the Gardener's fixed questions
// with a bounded numeric state (src/gardener/questions.ts), builds the Jev request itself, waits at most 2 s, validates
// the typed answer and returns it. It holds no wallet key, sends no transaction and logs nothing about a request.
import { jevRequest, parseAnswers, parseDecideRequest } from '../../src/gardener/questions.ts';
import { corsHeaders } from './cors.ts';
import type { Limiter } from './ratelimit.ts';
import type { Env } from './types.ts';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_TIMEOUT_MS = 2_000;
const MAX_BODY = 8_192;

export type DecideDeps = { now: () => number; jevFetch?: typeof fetch; limiter?: Limiter };

const json = (body: unknown, status: number, origin: string | null): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(origin) } });

export async function handleDecide(req: Request, env: Env, deps: DecideDeps, origin: string | null): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, origin);
  if (!env.JEV_API_KEY) return json({ error: 'The Gardener model is not configured on this server.' }, 503, origin);
  if (deps.limiter && !deps.limiter.allow(deps.now())) return json({ error: 'Too many requests.' }, 429, origin);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: 'Request too large.' }, 413, origin);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Not JSON.' }, 400, origin);
  }
  const parsed = parseDecideRequest(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400, origin);

  const f = deps.jevFetch ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), JEV_TIMEOUT_MS);
  const started = deps.now();
  let answer: unknown;
  try {
    const res = await f(env.JEV_URL ?? JEV_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.JEV_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(jevRequest(parsed.value)),
      signal: ctl.signal,
    });
    if (!res.ok) return json({ error: `The model answered with status ${res.status}.` }, 502, origin);
    answer = await res.json();
  } catch {
    return json({ error: 'The model did not answer in time.' }, 504, origin);
  } finally {
    clearTimeout(timer);
  }
  const answers = parseAnswers(answer, parsed.value);
  if (Object.values(answers).some((a) => a === null)) return json({ error: 'The model answer failed validation.' }, 502, origin);
  const model = (answer as { model?: unknown }).model;
  return json({ model: typeof model === 'string' ? model.slice(0, 40) : null, ms: deps.now() - started, answers }, 200, origin);
}
