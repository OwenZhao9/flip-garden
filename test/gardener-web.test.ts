// The Gardener panel's pure parts: the mandate form, the confirmation summary, and the timeline storage and rendering
// (escaping, validation of stored entries). No DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mandateSummary, parseMandateForm, DECIDE_URL } from '../web/src/gardener.ts';
import { entryHtml, loadTimeline, saveEntry, timelineHtml, timelineKey, MAX_ENTRIES } from '../web/src/gardener-timeline.ts';
import { defaultMandate } from '../src/gardener/mandate.ts';
import type { TimelineEntry } from '../src/gardener/runner.ts';

const USER = '0x39fdc1b554fcf0b7478e58ff671f3d0fea64da38';
const T0 = 1_800_000_000_000;
const base = defaultMandate(USER, T0, { bestBid: 2_561_300n, bestAsk: 2_565_500n }, 100n);
const form = { usdc: '6', ausd: '5', pmin: '0.0243', pmax: '0.0269', band: '0.2', hmin: '30', hmax: '70', hours: '1', tx: '12', fee: '0.5' };

test('the mandate form: human units in, a validated mandate out; caps cannot be exceeded', () => {
  const r = parseMandateForm(form, base, ['requote', 'replant'], T0);
  assert.ok(r.ok);
  assert.equal(r.mandate.usdcBudget, 6_000_000n);
  assert.equal(r.mandate.priceMin, 2_430_000n);
  assert.equal(r.mandate.bandBps, 20n);
  assert.equal(r.mandate.hedgeMaxBps, 7000n);
  assert.equal(r.mandate.expiresMs, T0 + 3_600_000);
  assert.equal(r.mandate.maxFeeWeiPerHour, 5n * 10n ** 17n);
  assert.deepEqual(r.mandate.actions, ['requote', 'replant']);
  const bad = (p: Record<string, string>) => parseMandateForm({ ...form, ...p }, base, ['requote'], T0);
  assert.equal(bad({ usdc: '16' }).ok, false, 'above the 15 USDC planting cap');
  assert.equal(bad({ ausd: '20' }).ok, false);
  assert.equal(bad({ hours: '25' }).ok, false);
  assert.equal(bad({ hours: 'soon' }).ok, false);
  assert.equal(bad({ tx: '2.5' }).ok, false);
  assert.equal(bad({ fee: '5' }).ok, false);
  assert.equal(bad({ pmin: 'abc' }).ok, false);
  assert.equal(bad({ pmin: '0.03', pmax: '0.02' }).ok, false);
  const t = parseMandateForm({ ...form, act: '0.75', ask: '0.55' }, base, ['requote'], T0);
  assert.ok(t.ok);
  assert.equal(t.mandate.actAt, 0.75);
  assert.equal(t.mandate.askAt, 0.55);
  assert.equal(r.mandate.actAt, 0.7, 'the default when the fields are absent');
  assert.equal(bad({ act: '1.5' }).ok, false);
  assert.equal(bad({ act: '0.6', ask: '0.8' }).ok, false, 'ask may not be above act');
  assert.equal(bad({ act: 'high' }).ok, false);
});

test('the summary names every limit; Jev is not offered until the Worker address is set', () => {
  const html = mandateSummary(base, 'rules');
  for (const s of ['6 USDC', '0.0243', '0.2%', 'fixed rules', 'never approves or deposits', 'Stop halts everything']) assert.ok(html.includes(s) || html.replace(/<[^>]+>/g, '').includes(s), s);
  assert.match(DECIDE_URL ?? '', /\/decide$/);
  assert.match(mandateSummary(base, 'jev'), /Jev \(TypeSafe AI\)/);
});

const entry = (p: Partial<TimelineEntry> = {}): TimelineEntry => ({
  atMs: T0, block: 112_473_471, question: 'tend', choice: 'requote', confidence: 1, source: 'rules', route: 'act', action: 'Re-place bid #1.', reason: 'Bid #1 sits more than 20 basis points under the best bid.', outcome: 'Re-placed #1 as #2.', ok: true,
  txs: [{ kind: 'cancel', status: 'confirmed', hash: '0x' + 'ab'.repeat(32), feeWei: '21380300000000000', facts: ['1 order(s) cancelled and gone from the book.'], problems: [] }],
  ...p,
});

test('timeline storage: newest first, capped, and stored entries are re-validated', () => {
  const mem = new Map<string, string>();
  const store = { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => void mem.set(k, v) };
  saveEntry(store, USER.toUpperCase(), entry({ outcome: 'first' }));
  saveEntry(store, USER, entry({ outcome: 'second' }));
  const got = loadTimeline(store, USER);
  assert.deepEqual(got.map((e) => e.outcome), ['second', 'first']);
  assert.equal(timelineKey(USER.toUpperCase()), timelineKey(USER));
  for (let i = 0; i < MAX_ENTRIES + 5; i++) saveEntry(store, USER, entry());
  assert.equal(loadTimeline(store, USER).length, MAX_ENTRIES);
  mem.set(timelineKey(USER), JSON.stringify([{ atMs: 'x' }, entry({ txs: [{ kind: 'plant', status: 'confirmed', hash: 'javascript:alert(1)', feeWei: '1e99', facts: [], problems: [] }] })]));
  const cleaned = loadTimeline(store, USER);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].txs[0].hash, undefined, 'a non-hash is dropped');
  assert.equal(cleaned[0].txs[0].feeWei, '0');
  mem.set(timelineKey(USER), 'not json');
  assert.deepEqual(loadTimeline(store, USER), []);
});

test('timeline rendering: action, reason, choice, confidence, the transaction link and its verification; all escaped', () => {
  const html = entryHtml(entry());
  assert.match(html, /requote/);
  assert.match(html, /confidence 1\.00/);
  assert.match(html, /acted alone/);
  assert.match(html, /monadscan\.com\/tx\/0xabab/);
  assert.match(html, /fee 0\.02138 MON/);
  assert.match(html, /cancelled and gone from the book/);
  const evil = entryHtml(entry({ reason: '<img src=x onerror=alert(1)>', outcome: '"><script>' }));
  assert.doesNotMatch(evil, /<img|<script/);
  assert.equal(timelineHtml([]), '');
  assert.match(timelineHtml([entry()]), /Gardener timeline/);
});
