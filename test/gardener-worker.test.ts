// The Worker's POST /decide with a fake Jev (scripted answers). No network; the "key" is a test string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, type Deps } from '../server/src/app.ts';
import { Limiter } from '../server/src/ratelimit.ts';
import { ALLOWED_ORIGIN } from '../server/src/cors.ts';
import type { Env, KV } from '../server/src/types.ts';

const kv: KV = { get: async () => null, put: async () => {}, delete: async () => {} };
const env = (over: Partial<Env> = {}): Env => ({ KV: kv, MARKET: '0x065c9d28e428a0db40191a54d33d5b7c71a9c394', MARGIN_ACCOUNT: '0x2a68ba1833cdf93fa9da1eebd7f46242ad8e90c5', MARKET_FIRST_BLOCK: '0', JEV_API_KEY: 'test-key-not-real', ...over });
const STATE = { market: { mid_path: [0.0256, 0.02563], spread_bps: 16, checks_apart_seconds: 5 }, money: { free_usdc: 5.99, locked_usdc: 0, budget_usdc: 6, free_mon: 0, idle_minutes: 0 }, recent_failures: 0 };
const BODY = { questions: [{ key: 'recover', id: 'recover', options: ['wait', 'replant'] }], state: STATE };
const GOOD = { model: 'jev-1.13.0', answers: { recover: { type: 'choice', choice: 'replant', probabilities: { wait: 0.1, replant: 0.9 }, confidence: 0.8 } }, usage: { input_tokens: 300, output_tokens: 20 } };

function fakeJev(reply: () => Promise<{ status: number; body: unknown }>) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      reply().then(resolve, reject);
    });
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const deps = (jevFetch: typeof fetch, limiters?: Deps['limiters']): Deps => ({ chain: {} as Deps['chain'], now: () => Date.now(), jevFetch, limiters });
const post = (body: unknown, origin = ALLOWED_ORIGIN) => new Request('https://w.example/decide', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('/decide forwards a valid question to Jev with the secret key and returns the validated answer', async () => {
  const jev = fakeJev(async () => ({ status: 200, body: GOOD }));
  const res = await handle(post(BODY), env(), deps(jev.f));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  const out = await res.json();
  assert.equal(out.answers.recover.choice, 'replant');
  assert.ok(Math.abs(out.answers.recover.confidence - 0.8) < 1e-9, 'recomputed: (0.9 - 0.5) / 0.5');
  assert.equal(out.model, 'jev-1.13.0');
  assert.equal(JSON.stringify(out).includes('test-key-not-real'), false, 'the key never goes back to the page');
  assert.equal(jev.calls.length, 1);
  assert.equal(jev.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(jev.calls[0].headers.authorization, 'Bearer test-key-not-real');
  assert.equal(jev.calls[0].body.model, 'jev-1.13.0');
  assert.deepEqual(Object.keys((jev.calls[0].body.questions as Record<string, { criteria: object }>).recover.criteria), ['wait', 'replant']);
  assert.deepEqual(jev.calls[0].body.state, STATE);
});

test('/decide refuses bad requests without calling Jev', async () => {
  const jev = fakeJev(async () => ({ status: 200, body: GOOD }));
  assert.equal((await handle(post({ ...BODY, questions: [{ key: 'x', id: 'transfer', options: ['a', 'b'] }] }), env(), deps(jev.f))).status, 400);
  assert.equal((await handle(post('not json'), env(), deps(jev.f))).status, 400);
  assert.equal((await handle(post('x'.repeat(9000)), env(), deps(jev.f))).status, 413);
  assert.equal((await handle(new Request('https://w.example/decide', { method: 'GET', headers: { origin: ALLOWED_ORIGIN } }), env(), deps(jev.f))).status, 405);
  assert.equal((await handle(post(BODY, 'https://evil.example'), env(), deps(jev.f))).status, 403);
  assert.equal((await handle(post(BODY), env({ JEV_API_KEY: undefined }), deps(jev.f))).status, 503, 'no secret set');
  assert.equal(jev.calls.length, 0);
});

test('/decide: a Jev error, a malformed answer or a slow answer gives an error, never a made-up choice', async () => {
  const bad = fakeJev(async () => ({ status: 200, body: { answers: { recover: { choice: 'send_all', probabilities: { send_all: 1 } } } } }));
  assert.equal((await handle(post(BODY), env(), deps(bad.f))).status, 502);
  const down = fakeJev(async () => ({ status: 529, body: { error: 'overloaded' } }));
  assert.equal((await handle(post(BODY), env(), deps(down.f))).status, 502);
  const slow = fakeJev(() => new Promise(() => {}));
  const t0 = Date.now();
  assert.equal((await handle(post(BODY), env(), deps(slow.f))).status, 504);
  const took = Date.now() - t0;
  assert.ok(took >= 1900 && took < 3500, `gave up after about 2 s (${took} ms)`);
});

test('/decide has its own rate limit', async () => {
  const jev = fakeJev(async () => ({ status: 200, body: GOOD }));
  const limiters = { read: new Limiter(100), write: new Limiter(100), decide: new Limiter(1) };
  assert.equal((await handle(post(BODY), env(), deps(jev.f, limiters))).status, 200);
  assert.equal((await handle(post(BODY), env(), deps(jev.f, limiters))).status, 429);
});
