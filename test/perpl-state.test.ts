// Read model: decoders checked against ethers on raw responses captured from the live exchange
// (test/fixtures/perpl-live-2026-10-11.json, read-only eth_call / eth_getLogs), and the event scanner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  PerplReader, decodeAccount, decodeMarginFractions, decodeOrder, decodeOrderLocks, decodePerpetualInfo, decodePosition,
  eventsOfAccount, feePpm, newAccountEvents, perpIdsWithPosition, scanAccountEvents,
} from '../src/perpl/state.ts';
import { decodePerplLog, fieldOf, type RawLog } from '../src/perpl/events.ts';
import type { LogFilter, LogSource } from '../src/scan.ts';

const require = createRequire(import.meta.url);
const { ethers } = require('ethers');
const root = path.join(import.meta.dirname, '..');
const abi = JSON.parse(fs.readFileSync(path.join(root, 'config', 'perpl.exchange.abi.json'), 'utf8'));
const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'perpl-live-2026-10-11.json'), 'utf8'));
const iface = new ethers.utils.Interface(abi);
const res = (k: string): string => fx.calls[k].result;
const big = (x: { toString(): string }): bigint => BigInt(x.toString());
const dec = (fn: string, k: string) => iface.decodeFunctionResult(fn, res(k));

test('account: decoder equals ethers and the position bitmap lists the perpetuals', () => {
  const a = decodeAccount(res('getAccountById'));
  const e = dec('getAccountById', 'getAccountById')[0];
  assert.equal(a.accountId, big(e.accountId));
  assert.equal(a.balanceCNS, big(e.balanceCNS));
  assert.equal(a.lockedBalanceCNS, big(e.lockedBalanceCNS));
  assert.equal(a.address.toLowerCase(), e.accountAddr.toLowerCase());
  assert.deepEqual(a.positionBanks, [e.positions.bank1, e.positions.bank2, e.positions.bank3, e.positions.bank4].map(big));
  assert.equal(a.accountId, BigInt(fx.account));
  // bank1 = 0x4010040000401004010080100402: perpetuals 1 and 10 (and others) hold a position
  assert.ok(perpIdsWithPosition(a).includes(10));
  assert.deepEqual(perpIdsWithPosition({ positionBanks: [0b101n, 0n, 1n, 0n] }), [0, 2, 512]);
});

test('position: decoder equals ethers', () => {
  const p = decodePosition(res('getPositionV2_10'));
  const e = dec('getPositionV2', 'getPositionV2_10');
  const i = e[0];
  assert.deepEqual(
    [p.accountId, p.depositCNS, p.pricePNS, p.lotLNS, p.entryBlock, p.pnlCNS, p.deltaPnlCNS, p.premiumPnlCNS, p.priceResiduePNSQ16, p.markPricePNS],
    [i.accountId, i.depositCNS, i.pricePNS, i.lotLNS, i.entryBlock, i.pnlCNS, i.deltaPnlCNS, i.premiumPnlCNS, i.priceResiduePNSQ16, e.markPricePNS].map(big),
  );
  assert.equal(p.positionType, i.positionType);
  assert.equal(p.markPriceValid, e.markPriceValid);
});

test('perpetual info (dynamic tuple with strings): every field equals ethers', () => {
  const p = decodePerpetualInfo(res('getPerpetualInfoV2_10'));
  const i = dec('getPerpetualInfoV2', 'getPerpetualInfoV2_10')[0];
  for (const k of Object.keys(p) as Array<keyof typeof p>) {
    assert.equal(BigInt(p[k] as bigint | number), big(i[k]), String(k));
  }
  assert.equal(p.priceDecimals, 6);
  assert.equal(p.lotDecimals, 0);
  assert.ok(p.fundingRatePct100k >= -100000n && p.fundingRatePct100k <= 100000n);
});

test('order locks and resting order: decoders equal ethers; lock id = perpId * 65536 + orderId', () => {
  const locks = decodeOrderLocks(res('getOrderLocks'));
  const e = dec('getOrderLocks', 'getOrderLocks')[0];
  assert.equal(locks.length, e.length);
  locks.forEach((l, i) => {
    assert.equal(l.orderLockId, e[i].orderLockId);
    assert.equal(l.lotLNS, big(e[i].lotLNS));
    assert.equal(l.amountCNS, big(e[i].amountCNS));
    assert.equal(l.orderType, e[i].orderType);
    assert.equal(l.perpId * 65536 + l.orderId, l.orderLockId);
  });
  const first = locks[0];
  assert.equal(first.perpId, fx.calls.getOrderV2_first.perp);
  assert.equal(first.orderId, fx.calls.getOrderV2_first.oid);
  const o = decodeOrder(res('getOrderV2_first'));
  const eo = dec('getOrderV2', 'getOrderV2_first')[0];
  assert.deepEqual([o.accountId, o.priceONS, o.lotLNS, o.expiryBlock, o.leverageHdths, o.orderId], [eo.accountId, eo.priceONS, eo.lotLNS, eo.expiryBlock, eo.leverageHdths, eo.orderId].map(big));
  assert.equal(o.accountId, BigInt(fx.account)); // the lock belongs to the account that owns the order
});

test('margin fractions, minimum deposit, fee and version', () => {
  const m = decodeMarginFractions(res('getMarginFractions_10'));
  const e = dec('getMarginFractions', 'getMarginFractions_10');
  assert.deepEqual([m.initHdths, m.maintHdths, m.dynamicInitHdths, m.oiMaxLNS], [e[0], e[1], e[2], e[3]].map(big));
  assert.equal(m.initHdths, 1000n); // 10x
  assert.equal(m.maintHdths, 2000n); // factor 20 = 5% of notional
  assert.equal(BigInt(res('getMinAccountOpenCNS')), 10_000_000n); // 10 AUSD
  assert.equal(BigInt(res('getTakerFee_10')), 345n); // 3.45 bps in millionths
  const v = iface.decodeFunctionResult('getContractVersion', res('getContractVersion')).map(big);
  assert.deepEqual(v, [1n, 7n, 5n]);
  // fee unit: millionths from v1.7.5 (dex-sdk version.rs PPM_FEE_UNIT), hundred-thousandths before
  assert.equal(feePpm(345n, [1n, 7n, 5n]), 345n);
  assert.equal(feePpm(345n, [1n, 7n, 4n]), 3450n);
  assert.equal(feePpm(345n, [1n, 8n, 0n]), 345n);
});

test('PerplReader treats a reverting view as "not found" and rethrows other failures', async () => {
  const mk = (err: string) => new PerplReader({ call: async () => { throw new Error(err); } } as never, '0x00000000000000000000000000000000000000aa');
  assert.equal(await mk('eth_call: {"code":3,"message":"execution reverted"}').account('0x00000000000000000000000000000000000000bb'), null);
  assert.equal(await mk('eth_call: {"code":3,"message":"execution reverted"}').position(10, 1n), null);
  await assert.rejects(mk('fetch failed').account('0x00000000000000000000000000000000000000bb'), /fetch failed/);
  const ok = new PerplReader({ call: async () => fx.calls.getAccountById.result } as never, '0x00000000000000000000000000000000000000aa');
  assert.equal((await ok.account('0x00000000000000000000000000000000000000bb'))?.accountId, BigInt(fx.account));
});

// ---- events ----
const logs: RawLog[] = fx.logs;
const acct = BigInt(fx.logAccount);

test('the event table decodes every captured log it claims to know, equal to ethers', () => {
  let known = 0;
  for (const l of logs) {
    const mine = decodePerplLog(l);
    if (!mine) continue;
    known++;
    const e = iface.parseLog(l);
    assert.equal(mine.name, e.name);
    const names = e.eventFragment.inputs.map((i: { name: string }) => i.name).filter((n: string) => n in mine.fields);
    assert.ok(names.length > 0);
    for (const n of names) {
      const v = e.args[n];
      const m = mine.fields[n];
      if (typeof m === 'bigint') assert.equal(m, big(v), `${e.name}.${n}`);
      else if (typeof m === 'boolean') assert.equal(m, v);
      else assert.equal(String(m).toLowerCase(), String(v).toLowerCase());
    }
  }
  assert.ok(known > 20);
});

test('eventsOfAccount keeps the account\'s events and the taker-side events that follow its requests', () => {
  const got = eventsOfAccount(logs, acct);
  // independent expectation: walk each tx with ethers and track the current requester
  const want: string[] = [];
  const txs = new Map<string, RawLog[]>();
  for (const l of logs) txs.set(l.transactionHash, [...(txs.get(l.transactionHash) ?? []), l]);
  for (const arr of txs.values()) {
    let cur = -1n;
    for (const l of arr.sort((a, b) => Number(BigInt(a.logIndex) - BigInt(b.logIndex)))) {
      let e;
      try { e = iface.parseLog(l); } catch { continue; }
      if (e.name === 'OrderRequestV2') cur = big(e.args.accountId);
      const own = e.args.accountId !== undefined && big(e.args.accountId) === acct;
      const takerSide = ['TakerOrderFilledV2', 'OrderPlaced', 'OrderCancelled', 'OrderChanged', 'OrderBatchCompleted'].includes(e.name) && cur === acct;
      if (own || takerSide) want.push(`${l.transactionHash}:${l.logIndex}`);
    }
  }
  assert.ok(want.length >= 3);
  assert.deepEqual(got.map((e) => `${e.log.transactionHash}:${e.log.logIndex}`).sort(), want.sort());
  assert.ok(got.some((e) => e.name === 'OrderRequestV2' && fieldOf(e, 'accountId') === acct));
  assert.ok(got.every((e) => e.name !== 'MakerOrderFilledV2' || fieldOf(e, 'accountId') === acct));
});

function fakeSource(head: number, failAt?: number): LogSource & { calls: LogFilter[] } {
  const calls: LogFilter[] = [];
  return {
    calls,
    async blockNumber() { return head; },
    async getLogs(f) {
      calls.push(f);
      if (failAt !== undefined && f.fromBlock <= failAt && failAt <= f.toBlock) throw new Error('rpc down');
      return logs.filter((l) => {
        const b = Number(BigInt(l.blockNumber));
        return b >= f.fromBlock && b <= f.toBlock && f.topics[0].includes(l.topics[0]) && l.address.toLowerCase() === f.address.toLowerCase();
      });
    },
  };
}

test('scanAccountEvents: windows stay within the limit, a failure resumes without duplicates', async () => {
  const [from, to] = fx.logsRange as [number, number];
  const x = fx.exchange as string;
  const src = fakeSource(to + 2, from + 45);
  const st = newAccountEvents(acct, from);
  await assert.rejects(scanAccountEvents(src, x, st, { maxBlocks: 20 }), /rpc down/);
  assert.ok(st.nextBlock > from && st.nextBlock <= from + 45, 'cursor stopped before the failing window');
  const ok = fakeSource(to + 2);
  await scanAccountEvents(ok, x, st, { maxBlocks: 20 });
  assert.equal(st.nextBlock, to + 1); // head - 2 confirmations
  assert.ok([...src.calls, ...ok.calls].every((c) => c.toBlock - c.fromBlock + 1 <= 20));
  const keys = st.events.map((e) => `${e.log.transactionHash}:${e.log.logIndex}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys.sort(), eventsOfAccount(logs, acct).map((e) => `${e.log.transactionHash}:${e.log.logIndex}`).sort());
  const again = await scanAccountEvents(fakeSource(to + 2), x, st, { maxBlocks: 20 });
  assert.equal(again.events.length, keys.length); // idempotent
});
