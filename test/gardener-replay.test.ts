// The replay harness on the recorded real windows of 2026-10-11 (test/fixtures/gardener-replay-*.json, read from the
// chain with scripts/gardener-record.ts). Pins what each Gardener would have done so a policy change shows up here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replay, type ReplayFixture } from '../src/gardener/replay.ts';
import { rulesDecider, type Decider } from '../src/gardener/decide.ts';
import type { Answer } from '../src/gardener/policy.ts';

const load = (n: string): ReplayFixture => JSON.parse(readFileSync(new URL(`./fixtures/gardener-replay-${n}.json`, import.meta.url), 'utf8'));
const PASSKEY = load('2026-10-11-passkey');
const METAMASK = load('2026-10-11-metamask');
const TWO_HOURS = load('2026-10-12-two-hours');

test('the fixtures are the real 2026-10-11 windows: the plantings and fills the owner saw', () => {
  const plant = PASSKEY.own.find((e) => e.name === 'FlipOrderCreated')!;
  assert.equal(plant.block, 112_472_044);
  assert.equal(plant.price, '2560000');
  assert.ok(PASSKEY.book.length > 100 && PASSKEY.trades.length > 10);
  const fill = METAMASK.own.filter((e) => e.name === 'Trade');
  assert.deepEqual(fill.map((e) => e.block), [112_418_067, 112_418_068], 'the bid filled over two blocks, as in docs/FINDINGS.md');
});

test('passkey window: flip orders alone leave the bid out of range for 1,294 blocks; the rules Gardener re-places it', async () => {
  const none = await replay(PASSKEY, { decider: null });
  assert.equal(none.blocksOutOfRange, 1294);
  assert.equal(none.txs, 0);
  const rules = await replay(PASSKEY, { decider: rulesDecider });
  assert.equal(rules.blocksOutOfRange, 6);
  assert.equal(rules.failedTxs, 0, 'one tick above the best bid does not lose the race that "right under the ask" lost');
  assert.equal(rules.txs, 3);
  assert.equal(rules.feeWei, 79_183_804_000_000_000n);
  assert.equal(rules.bidFills, 1);
});

test('metamask window: the bid filled at once and the flipped sell sat; there is nothing for the Gardener to do', async () => {
  const rules = await replay(METAMASK, { decider: rulesDecider });
  assert.equal(rules.bidFills, 1);
  assert.equal(rules.txs, 0, 'sells are never touched');
});

test('a Jev that never answers does nothing at all; a confident "keep" behaves like no Gardener', async () => {
  const down: Decider = { name: 'jev', decide: async (qs) => qs.map(() => null) };
  const r = await replay(PASSKEY, { decider: down });
  assert.equal(r.txs, 0);
  assert.ok(r.skipped > 0);
  const keep: Decider = { name: 'jev', decide: async (qs) => qs.map((q) => ({ choice: q.options[0], confidence: 0.95, source: 'jev' }) as Answer) };
  const k = await replay(PASSKEY, { decider: keep });
  assert.equal(k.txs, 0);
  assert.equal(k.blocksOutOfRange, 1294);
});

test('a middling confidence is counted as "would ask the user" and never acted on in the replay', async () => {
  const unsure: Decider = { name: 'jev', decide: async (qs) => qs.map((q) => ({ choice: q.rulesChoice, confidence: 0.7, source: 'jev' }) as Answer) };
  const r = await replay(PASSKEY, { decider: unsure, mandate: (m) => ({ ...m, actAt: 0.85, askAt: 0.6 }) });
  assert.equal(r.txs, 0);
  assert.ok(r.asked > 0);
});

test('a slower inclusion only lengthens the time out of range; the passive placement still never crosses', async () => {
  const out: number[] = [];
  for (const latencyBlocks of [5, 60, 200]) {
    const r = await replay(PASSKEY, { decider: rulesDecider, latencyBlocks });
    assert.equal(r.failedTxs, 0);
    out.push(r.blocksOutOfRange);
  }
  assert.deepEqual(out, [6, 46, 114]);
});

test('two recent hours from a fresh 6 USDC bid: nothing left the range, and the rules make no transaction (no dust harvest)', async () => {
  const none = await replay(TWO_HOURS, { decider: null });
  const rules = await replay(TWO_HOURS, { decider: rulesDecider });
  assert.equal(none.blocks, 24_000);
  assert.equal(rules.bidFills, 2);
  assert.equal(rules.sellFills, 1);
  assert.equal(rules.blocksOutOfRange, 0);
  assert.equal(rules.txs, 0);
  assert.equal(rules.endValueUsdc, none.endValueUsdc);
});
