// Replays every recorded window (test/fixtures/gardener-replay-*.json) with no Gardener, the rules-only Gardener and,
// when a Worker address is given, the Jev Gardener through that Worker's POST /decide. Read-only: no chain access, no
// key (the Jev key stays a Worker secret). Usage:
//   node scripts/gardener-replay.ts                       # none and rules
//   node scripts/gardener-replay.ts https://<WORKER>      # none, rules and Jev
import { readFileSync, readdirSync } from 'node:fs';
import { replay, type ReplayFixture, type ReplayMetrics } from '../src/gardener/replay.ts';
import { jevDecider, rulesDecider, type Decider } from '../src/gardener/decide.ts';
import { formatUnits } from '../src/units.ts';

const worker = process.argv[2];
const latencies: number[] = [];
const deciders: (Decider | null)[] = [null, rulesDecider];
// Jev through the Worker. The page's 2 s timeout applies; the Worker allows about 120 requests a minute, so the replay
// paces itself to stay under it.
if (worker) {
  const jev = jevDecider({ url: worker.replace(/\/$/, '') + '/decide', onLatency: (ms) => latencies.push(ms) });
  deciders.push({ name: 'jev', decide: async (qs, ctx) => { await new Promise((r) => setTimeout(r, 600 * qs.length)); return jev.decide(qs, ctx); } });
}

const dir = 'test/fixtures';
const rows: ReplayMetrics[] = [];
for (const file of readdirSync(dir).filter((f) => /^gardener-replay-.*\.json$/.test(f)).sort()) {
  const f = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as ReplayFixture;
  for (const d of deciders) rows.push(await replay(f, { decider: d }));
}
const head = ['window', 'gardener', 'blocks', 'bid fills', 'round trips', 'blocks out of range', 'blocks idle', 'txs', 'failed', 'fees MON', 'asked', 'no answer', 'value change USDC'];
console.log('| ' + head.join(' | ') + ' |');
console.log('|' + head.map(() => '---').join('|') + '|');
for (const r of rows) {
  console.log('| ' + [r.label, r.gardener, r.blocks, r.bidFills, r.sellFills, r.blocksOutOfRange, r.blocksIdle, r.txs, r.failedTxs, formatUnits(r.feeWei, 18, 4), r.asked, r.skipped, formatUnits(r.endValueUsdc - r.startValueUsdc, 6)].join(' | ') + ' |');
}
if (latencies.length) {
  const s = [...latencies].sort((a, b) => a - b);
  console.log(`\nJev through the Worker: ${s.length} answers, median ${s[Math.floor(s.length / 2)]} ms, slowest ${s[s.length - 1]} ms.`);
}
