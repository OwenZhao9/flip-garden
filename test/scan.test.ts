// Incremental scanner: window size, resume after a crash, idempotence, confirmations, relevance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newScanState, planWindows, sync, eventsOf, candidateOwnTxs, type LogFilter, type LogSource } from '../src/scan.ts';
import type { RawLog } from '../src/events.ts';
import { buildLedger } from '../src/ledger.ts';
import { raw, market, txs, WALLET } from './helpers/gate.ts';

const MA = raw.marginAccount;

// A fake chain holding the real gate-test logs plus a stranger's log in the same block range.
function fakeSource(head: number, failAt?: number): LogSource & { calls: LogFilter[] } {
  const stranger: RawLog = {
    ...raw.logs[1],
    data: raw.logs[1].data.replace(WALLET.slice(2).toLowerCase(), '00000000000000000000000000000000000000ff'),
    logIndex: '0x1',
  };
  const all: RawLog[] = [...raw.logs, stranger];
  const calls: LogFilter[] = [];
  return {
    calls,
    async blockNumber() {
      return head;
    },
    async getLogs(f) {
      calls.push(f);
      if (failAt !== undefined && f.fromBlock <= failAt && failAt <= f.toBlock) throw new Error('rpc down');
      return all.filter((l) => {
        const b = Number(BigInt(l.blockNumber));
        return l.address.toLowerCase() === f.address && b >= f.fromBlock && b <= f.toBlock && f.topics[0].includes(l.topics[0]);
      });
    },
  };
}

const fresh = () => newScanState({ account: WALLET, markets: [raw.market], marginAccount: MA, startBlock: 112209400 });

test('planWindows never exceeds the block limit and covers the range exactly', () => {
  const w = planWindows(100, 1000, 90);
  assert.equal(w[0][0], 100);
  assert.equal(w[w.length - 1][1], 1000);
  for (const [a, b] of w) assert.ok(b - a + 1 <= 90);
  for (let i = 1; i < w.length; i++) assert.equal(w[i][0], w[i - 1][1] + 1);
  assert.deepEqual(planWindows(5, 4, 90), []);
});

test('sync keeps only our logs, respects 90 blocks and confirmations, and the ledger matches the fixture', async () => {
  const src = fakeSource(112211505);
  const st = fresh();
  const r = await sync(st, src, { confirmations: 2 });
  assert.equal(r.scannedTo, 112211503);
  for (const c of src.calls) assert.ok(c.toBlock - c.fromBlock + 1 <= 90);
  assert.equal(Object.keys(st.logs).length, raw.logs.length); // the stranger's order is dropped
  const L = buildLedger({ account: WALLET, markets: [market], events: eventsOf(st), txs });
  assert.equal(L.balances.get(raw.quoteToken)!.equity, 0n);
  assert.equal(L.fills.length, 1);
  // gas candidates: deposit, plant, cancel, withdraw (approve has no Kuru event)
  assert.equal(candidateOwnTxs(st).length, 4);
});

test('a failure mid-scan keeps the cursor before the failed window; resuming finishes without duplicates', async () => {
  const st = fresh();
  await assert.rejects(sync(st, fakeSource(112211600, 112210404)));
  assert.ok(st.nextBlock <= 112210404 && st.nextBlock > 112209400);
  const before = Object.keys(st.logs).length;
  assert.ok(before >= 1 && before < raw.logs.length);
  await sync(st, fakeSource(112211600));
  assert.equal(Object.keys(st.logs).length, raw.logs.length);
});

test('re-scanning from the start is idempotent', async () => {
  const st = fresh();
  await sync(st, fakeSource(112211600));
  const snapshot = JSON.stringify(st.logs);
  st.nextBlock = st.startBlock;
  const r = await sync(st, fakeSource(112211600));
  assert.equal(r.added, 0);
  assert.equal(JSON.stringify(st.logs), snapshot);
});

test('state survives a JSON round trip (it is what gets saved to disk)', async () => {
  const st = fresh();
  await sync(st, fakeSource(112211600), { maxWindows: 20 });
  const back = JSON.parse(JSON.stringify(st));
  await sync(back, fakeSource(112211600));
  assert.equal(Object.keys(back.logs).length, raw.logs.length);
});
