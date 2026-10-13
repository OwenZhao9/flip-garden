// Aurora deposit: request shape, quote checks, status mapping and the arrival check. A fake fetch built from a real dry
// quote (2026-10-12, 5 USDC Base to Monad). Nothing here signs or sends anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AURORA_API, AURORA_API_KEY, MONAD_USDC_ASSET, SOURCES, checkDepositQuote, fetchDepositQuote, fetchDepositStatus, parseDepositAmount, parseStatus, quoteBody, verifyArrival, isEvmAddress, type QuoteInput } from '../src/aurora.ts';

const ME = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';
const ORIGIN_WALLET = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x76b4c56085ED136a8744D52bE956396624a730E8';
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const base = SOURCES.find((s) => s.id === 'base')!;
const input = (over: Partial<QuoteInput> = {}): QuoteInput => ({ source: base, amount: 5_000_000n, recipient: ME, refundTo: ORIGIN_WALLET, dry: false, now: () => NOW, ...over });

function answer(over: { quote?: Record<string, unknown>; req?: Record<string, unknown> } = {}): unknown {
  return {
    quoteRequest: { dry: false, originAsset: base.asset, destinationAsset: MONAD_USDC_ASSET, amount: '5000000', recipient: ME, refundTo: ORIGIN_WALLET, ...over.req },
    quote: { timeEstimate: 37, amountIn: '5000000', amountOut: '4997287', minAmountOut: '4947314', depositAddress: DEPOSIT, deadline: new Date(NOW + 3600_000).toISOString(), ...over.quote },
  };
}

test('amounts: between 1 and 15 USDC, plain messages otherwise', () => {
  assert.deepEqual(parseDepositAmount('5'), { ok: true, amount: 5_000_000n });
  assert.equal(parseDepositAmount('0.5').ok, false);
  assert.equal(parseDepositAmount('15.01').ok, false);
  assert.equal(parseDepositAmount('abc').ok, false);
  assert.equal(parseDepositAmount('15').ok, true);
});

test('the request asks for exactly: USDC on the chosen chain into USDC on Monad, to the signed-in account', () => {
  const b = quoteBody(input());
  assert.equal(b.originAsset, base.asset);
  assert.equal(b.destinationAsset, MONAD_USDC_ASSET);
  assert.equal(b.recipient, ME);
  assert.equal(b.recipientType, 'DESTINATION_CHAIN');
  assert.equal(b.refundTo, ORIGIN_WALLET);
  assert.equal(b.refundType, 'ORIGIN_CHAIN');
  assert.equal(b.amount, '5000000');
  assert.equal(b.swapType, 'EXACT_INPUT');
  assert.equal(b.dry, false);
  assert.equal(b.deadline, new Date(NOW + 6 * 3600_000).toISOString());
});

test('a good quote is accepted; a dry quote needs no deposit address', () => {
  const r = checkDepositQuote(answer(), input());
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.quote.depositAddress, DEPOSIT);
    assert.equal(r.quote.minAmountOut, 4_947_314n);
    assert.equal(r.quote.timeEstimateSeconds, 37);
  }
  const dry = checkDepositQuote(answer({ quote: { depositAddress: undefined, deadline: undefined } }), input({ dry: true }));
  assert.ok(dry.ok);
});

test('every doubt is refused with a message, and nothing is shown to send to', () => {
  const refused = (a: unknown, i = input()): string => {
    const r = checkDepositQuote(a, i);
    assert.equal(r.ok, false);
    return r.ok ? '' : r.message;
  };
  assert.match(refused(answer({ req: { recipient: '0x2222222222222222222222222222222222222222' } })), /recipient/);
  assert.match(refused(answer({ req: { destinationAsset: 'nep141:other' } })), /different assets/);
  assert.match(refused(answer({ req: { originAsset: 'nep141:other' } })), /different assets/);
  assert.match(refused(answer({ req: { amount: '6000000' } })), /different amount/);
  assert.match(refused(answer({ req: { refundTo: '0x3333333333333333333333333333333333333333' } })), /refund/);
  assert.match(refused(answer({ quote: { amountIn: '4000000' } })), /usable amounts/);
  assert.match(refused(answer({ quote: { minAmountOut: '3000000', amountOut: '4000000' } })), /price looks off/);
  assert.match(refused(answer({ quote: { amountOut: '4000000', minAmountOut: '4900000' } })), /inconsistent/);
  assert.match(refused(answer({ quote: { depositAddress: 'near-account.near' } })), /deposit address/);
  assert.match(refused(answer({ quote: { depositAddress: undefined } })), /deposit address/);
  assert.match(refused(answer({ quote: { deadline: new Date(NOW - 1000).toISOString() } })), /deadline/);
  assert.match(refused(answer({ quote: { deadline: new Date(NOW + 8 * 86400_000).toISOString() } })), /deadline/);
  // Aurora's real answer: the asked deadline plus three days.
  assert.equal(checkDepositQuote(answer({ quote: { deadline: new Date(NOW + 6 * 3600_000 + 3 * 86400_000).toISOString() } }), input()).ok, true);
  assert.match(refused({ nope: true }), /recognise/);
});

test('fetchDepositQuote posts to the quote endpoint with the key in the path, and survives errors', async () => {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const ok = (async (url: string, init?: { body?: string }) => {
    seen.push({ url, body: JSON.parse(init!.body!) });
    return { ok: true, status: 200, json: async () => answer() };
  }) as never;
  const r = await fetchDepositQuote(ok, input());
  assert.ok(r.ok);
  assert.equal(seen[0].url, `${AURORA_API}/api/quote/${AURORA_API_KEY}`);
  assert.equal(seen[0].body.recipient, ME);
  const refused = (async () => ({ ok: false, status: 400, json: async () => ({ message: 'amount too low' }) })) as never;
  const r2 = await fetchDepositQuote(refused, input());
  assert.equal(r2.ok, false);
  assert.match(r2.ok ? '' : r2.message, /amount too low/);
  const down = (async () => { throw new Error('network secret-text'); }) as never;
  const r3 = await fetchDepositQuote(down, input());
  assert.equal(r3.ok, false);
  assert.ok(!/secret-text/.test(r3.ok ? '' : r3.message));
});

test('status: only SUCCESS, REFUNDED and FAILED end the wait; unknown answers keep waiting', async () => {
  assert.equal(parseStatus({ status: 'SUCCESS' }).state, 'success');
  assert.equal(parseStatus({ status: 'REFUNDED' }).state, 'refunded');
  assert.equal(parseStatus({ status: 'FAILED' }).state, 'failed');
  assert.equal(parseStatus({ status: 'PROCESSING' }).state, 'processing');
  assert.equal(parseStatus({ status: 'PENDING_DEPOSIT' }).state, 'waiting');
  assert.equal(parseStatus({ status: 'SOMETHING_NEW' }).state, 'waiting');
  assert.equal(parseStatus(null).state, 'waiting');
  const notFound = (async () => ({ ok: false, status: 404, json: async () => ({ message: 'not found' }) })) as never;
  assert.equal((await fetchDepositStatus(notFound, DEPOSIT)).state, 'waiting');
  let url = '';
  const good = (async (u: string) => { url = u; return { ok: true, json: async () => ({ status: 'SUCCESS' }) }; }) as never;
  assert.equal((await fetchDepositStatus(good, DEPOSIT)).state, 'success');
  assert.ok(url.includes(`depositAddress=${DEPOSIT}`));
});

test('arrival: the Monad USDC balance must rise by at least the quoted minimum', () => {
  const q = { amountIn: 5_000_000n, amountOut: 4_997_287n, minAmountOut: 4_947_314n, timeEstimateSeconds: 37, depositAddress: DEPOSIT, deadline: null };
  assert.equal(verifyArrival(1_000_000n, 1_000_000n + 4_997_287n, q).ok, true);
  assert.equal(verifyArrival(1_000_000n, 1_000_000n + 4_947_314n, q).ok, true);
  const short = verifyArrival(1_000_000n, 1_000_000n + 4_000_000n, q);
  assert.equal(short.ok, false);
  assert.match(short.message, /only 4 USDC/);
  assert.equal(verifyArrival(1_000_000n, 900_000n, q).ok, false);
});

test('the chosen sources are EVM USDC assets and addresses are validated', () => {
  assert.ok(SOURCES.length >= 4);
  for (const s of SOURCES) assert.match(s.asset, /^nep(141|245):/);
  assert.equal(isEvmAddress(ORIGIN_WALLET), true);
  assert.equal(isEvmAddress('near.near'), false);
  assert.equal(isEvmAddress('0x123'), false);
});
