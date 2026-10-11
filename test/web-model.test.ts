// The page's view model, built from the real 2026-10-10 mainnet data (the example wallet).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView, friendlyError, fmt, type Bundle } from '../web/src/model.ts';
import { raw, market, txs, chainAt, WALLET } from './helpers/gate.ts';

const bundleAt = (name: string, over: Partial<Bundle> = {}): Bundle => {
  const chain = chainAt(name);
  return {
    account: WALLET,
    market,
    symbols: { base: 'MON', quote: 'USDC' },
    marginAccount: '0x2a68ba1833cdf93fa9da1eebd7f46242ad8e90c5',
    startBlock: 112209462,
    endBlock: chain.block,
    logs: raw.logs,
    txs,
    chain,
    book: { bestBid: 2472400n, bestAsk: 2472500n },
    ...over,
  };
};

test('example wallet: numbers the page must show (final state)', () => {
  const v = buildView(bundleAt('final'));
  assert.equal(v.status, 'match');
  assert.ok(v.checks.length > 0);
  for (const c of v.checks) {
    assert.equal(c.ok, true, c.label);
    assert.match(c.diff, /^[+-]?0 /, `${c.label} difference is zero`);
  }
  assert.equal(v.money.quoteChange, '-4.976961 USDC');
  assert.equal(v.money.baseChange, '+201 MON');
  assert.equal(v.money.gas, '0.095135 MON');
  assert.equal(v.money.fees, '0');
  assert.equal(v.money.cycles, 0);
  assert.equal(v.money.realized, '0 USDC');
  assert.equal(v.money.unrealizedMid, '-0.007337 USDC'); // −0.0073365 rounded down
});

test('example wallet: one bid filled in full, one flipped sell, then cancelled', () => {
  const v = buildView(bundleAt('final'));
  assert.equal(v.orders.length, 2);
  const [bid, ask] = v.orders;
  assert.deepEqual([bid.id, bid.depth, bid.side, bid.status], ['122927284', 0, 'Buy', 'filled']);
  assert.deepEqual([ask.id, ask.depth, ask.side, ask.status], ['122927286', 1, 'Sell', 'cancelled']);
  assert.equal(ask.origin, 'Flipped out of #122927284');
  assert.deepEqual(v.tiles.map((t) => t.state), ['harvested', 'pruned']);
  assert.equal(v.fills.length, 1);
  const f = v.fills[0];
  assert.equal(f.sideLabel, 'Bought'); // our side as maker, not Trade.isBuy
  assert.equal(f.base, '201');
  assert.equal(f.quote, '4.976961');
  assert.equal(f.flippedTo, '#122927286');
  assert.equal(f.initiator, '0xc88db3f7ea78f2dde27297e2934de3cfe4d42e5a');
});

test('balances while the ask rests: 201 MON locked, nothing in the wallet beyond gas', () => {
  const v = buildView(bundleAt('afterFill'));
  const mon = v.balances.find((r) => r.symbol === 'MON')!;
  assert.equal(mon.locked, '201');
  assert.equal(mon.free, '0');
  assert.equal(v.orders.find((o) => o.id === '122927286')!.status, 'open');
  assert.equal(v.tiles.find((t) => t.orderId === '122927286')!.state, 'planted');
  assert.equal(v.status, 'match');
});

test('a wrong chain state is shown as a mismatch, with a cause', () => {
  const b = bundleAt('final');
  b.chain = { ...b.chain, margin: { ...b.chain.margin, [market.quoteAsset]: b.chain.margin[market.quoteAsset] + 5n } };
  const v = buildView(b);
  assert.equal(v.status, 'mismatch');
  assert.ok(v.checks.some((c) => !c.ok));
  assert.match(v.detail, /differ/);
});

test('an empty range says so instead of showing zeros as truth', () => {
  const v = buildView(bundleAt('final', { logs: [], txs: [] }));
  assert.equal(v.status, 'empty');
});

test('no order book: market-value fields say n/a', () => {
  const v = buildView(bundleAt('final', { book: null }));
  assert.equal(v.money.unrealizedMid, 'n/a');
  assert.equal(v.netWorth, null);
});

test('fixed-point formatting never uses floating point', () => {
  assert.equal(fmt(123456789012345678901234567890n, 18, 6), '123456789012.345678');
  assert.equal(fmt(-1n, 6), '-0.000001');
  assert.equal(fmt(10n ** 18n, 18), '1');
});

test('error messages are plain language', () => {
  assert.match(friendlyError(new Error('eth_getLogs: 429 Too Many Requests')), /rate-limiting/);
  assert.match(friendlyError(new TypeError('Failed to fetch')), /Could not reach/);
});
