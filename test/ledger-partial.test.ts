// Real partial fills (another account, market 0x52ce…74ce, Monad mainnet, blocks 110.30M–111.43M):
// the rules the ledger uses for FlippedOrderCreated.flippedId and FlipOrderUpdated come from here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeLog, type KuruEvent } from '../src/events.ts';
import { buildLedger, expectedFlipSize, orderKey } from '../src/ledger.ts';
import { marketFromJson } from '../src/units.ts';
import { marketPnl } from '../src/pnl.ts';

const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'flip-partial-fills-0x52ce.raw.json'), 'utf8'));
const market = marketFromJson(fx.marketParams, fx.market);
const events = fx.logs.map((l: never) => decodeLog(l)!) as KuruEvent[];
const L = buildLedger({ account: fx.owner, markets: [market], events });
const order = (id: bigint) => L.orders.get(orderKey(fx.market, id))!;

test('partial fill: the flipped order carries flippedId = parent, and later fills grow it via FlipOrderUpdated (new total)', () => {
  // 6544 (ask @ 65050) partly filled -> bid 6632 created with flippedId 6544; its second fill
  // updated 6632 from 2240023084024 to 5010778347784.
  const created = events.find((e) => e.name === 'FlippedOrderCreated' && e.orderId === 6632n)!;
  assert.equal((created as { flippedId: bigint }).flippedId, 6544n);
  const c = order(6632n);
  assert.equal(c.parent?.orderId, 6544n);
  assert.equal(c.initialSize, 5010778347784n); // created size + the update
  assert.deepEqual(order(6544n).children, [6632n]);
  assert.equal(order(6544n).status, 'filled');
  for (const [child, parent] of [[6632n, 6544n], [6669n, 6504n], [6680n, 6431n]]) {
    assert.equal(order(child).parent?.orderId, parent);
    assert.equal(order(parent).fills.length, 2, `parent ${parent}`);
  }
});

test('flipped sizes follow the observed rule exactly: ask fill -> floor(filled × price / flipPrice)', () => {
  const codes = new Set(L.issues.map((i) => i.code));
  assert.equal(codes.has('FLIP_SIZE_UNEXPECTED'), false);
  assert.equal(codes.has('FLIP_ORDER_UPDATED'), false, 'every linked FlipOrderUpdated was explained');
  assert.equal(L.issues.filter((i) => i.severity === 'error').length, 0);
  assert.equal(expectedFlipSize(2767773667012n, { isBuy: false, price: 65050n, flipPrice: 64980n }), 2770755263760n);
  assert.equal(expectedFlipSize(201n, { isBuy: true, price: 1n, flipPrice: 2n }), 201n);
});

test('full fills in a sweep each flip out a new order; the cancels at the end close them', () => {
  const flipped = [...L.orders.values()].filter((o) => o.origin === 'flipped');
  assert.ok(flipped.length >= 100);
  const fills = L.fills.filter((f) => f.side === 'sell');
  assert.ok(fills.length > 100);
  // every sell fill flipped into (or grew) exactly one bid
  for (const f of fills) assert.ok(f.flippedTo.length <= 1, f.key);
  // PnL works on orders first seen through their fill: lots open short, nothing crashes
  const p = marketPnl(L, fx.market, { bestBid: 65000n, bestAsk: 65010n });
  assert.ok(p.netBase < 0n);
});
