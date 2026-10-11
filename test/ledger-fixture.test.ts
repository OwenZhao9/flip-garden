// Ground truth: the real 2026-10-10 gate test on Monad mainnet, decoded from raw log bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromGateJson, TOPICS } from '../src/events.ts';
import { keccak256 } from '../src/keccak.ts';
import { buildLedger } from '../src/ledger.ts';
import { reconcile } from '../src/reconcile.ts';
import { marketPnl, accountView } from '../src/pnl.ts';
import { floor, add, mul, q, sub } from '../src/rational.ts';
import { priceRaw } from '../src/units.ts';
import { fx, raw, events, txs, market, WALLET, USDC, MON, chainAt } from './helpers/gate.ts';

const ledgerAt = (block?: number, extra: Partial<Parameters<typeof buildLedger>[0]> = {}) =>
  buildLedger({ account: WALLET, markets: [market], events, txs, untilBlock: block, ...extra });

test('keccak256 matches known vectors and the ethers topic for Trade', () => {
  assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('Transfer(address,address,uint256)'), '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  // ethers.utils.id(...) from ethers 5.7.1, computed 2026-10-11
  assert.equal(TOPICS.Trade, '0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581');
  // A 200-byte input crosses the 136-byte rate boundary.
  assert.equal(keccak256('a'.repeat(200)).length, 66);
});

test('raw mainnet logs decode to exactly the events recorded by the gate script', () => {
  const recorded = fx.events.map((e: never) => fromGateJson({ ...(e as object), address: raw.market } as never));
  const market = events.filter((e) => e.address === raw.market);
  assert.equal(market.length, recorded.length);
  for (let i = 0; i < recorded.length; i++) assert.deepEqual(market[i], recorded[i]);
  const margin = events.filter((e) => e.name === 'Deposit' || e.name === 'Withdrawal');
  assert.deepEqual(
    margin.map((e) => [e.name, (e as { token: string }).token, (e as { amount: bigint }).amount]),
    [
      ['Deposit', USDC, 6000000n],
      ['Withdrawal', USDC, 1023039n],
      ['Withdrawal', MON, 201000000000000000000n],
    ],
  );
});

test('orders and the flip chain: bid filled in full, new-id ask flipped out of that fill, then cancelled', () => {
  const L = ledgerAt();
  assert.deepEqual(L.issues, []);
  const bid = L.orders.get(`${raw.market}:122927284`)!;
  const ask = L.orders.get(`${raw.market}:122927286`)!;
  assert.equal(bid.status, 'filled');
  assert.equal(bid.origin, 'placed');
  assert.deepEqual(bid.children, [122927286n]);
  assert.equal(ask.origin, 'flipped');
  assert.equal(ask.parent?.orderId, 122927284n);
  assert.equal(ask.status, 'cancelled');
  assert.equal(ask.price, bid.flipPrice);
  assert.equal(ask.flipPrice, bid.price);
  assert.equal(L.fills.length, 1);
  const f = L.fills[0];
  assert.equal(f.side, 'buy');
  assert.equal(f.quote.value, 4976961n);
  assert.equal(f.base.value, 201n * 10n ** 18n);
  assert.equal(f.quote.exact && f.base.exact, true);
  assert.deepEqual(f.flippedTo, [122927286n]);
  assert.equal(f.txOrigin, '0xc88db3f7ea78f2dde27297e2934de3cfe4d42e5a');
});

test('every snapshot: ledger free / locked equal the chain exactly', () => {
  for (const s of fx.snapshots) {
    const L = ledgerAt(s.block);
    const u = L.balances.get(USDC)!;
    const m = L.balances.get(MON)!;
    assert.equal(u.free, BigInt(s.marginUsdc), `${s.name} free USDC`);
    assert.equal(u.locked, BigInt(s.lockedQuote), `${s.name} locked USDC`);
    assert.equal(m.free, BigInt(s.marginMon), `${s.name} free MON`);
    assert.equal(m.locked, BigInt(s.lockedBase), `${s.name} locked MON`);
    const r = reconcile(L, chainAt(s.name));
    assert.equal(r.ok, true, `${s.name}: ${JSON.stringify(r.diffs.filter((d) => !d.ok), (_, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    for (const d of r.diffs) assert.equal(d.diff, 0n);
  }
});

test('whole wallet: baseline -> every later snapshot changes by exactly fills - fees - gas', () => {
  const b = chainAt('baseline');
  const L0 = ledgerAt(b.block);
  for (const name of ['afterDeposit', 'afterPlant', 'afterFill', 'afterCancel', 'final']) {
    const c = chainAt(name);
    const r = reconcile(ledgerAt(c.block), c, { ledger: L0, chain: b });
    const w = r.diffs.filter((d) => d.check === 'WALLET');
    assert.equal(w.length, 2);
    for (const d of w) assert.equal(d.diff, 0n, `${name} ${d.token}`);
  }
  const L = ledgerAt();
  assert.equal(L.gas.totalWei, BigInt(fx.expected.gasTotalWei));
});

test('PnL: one buy, no cycle yet; unrealized at mid and at the best bid; identity with flows', () => {
  const L = ledgerAt();
  const book = { bestBid: 2472400n, bestAsk: 2472500n }; // a book after the price moved down
  const p = marketPnl(L, raw.market, book);
  assert.equal(p.cycles.length, 0);
  assert.equal(p.realized.n, 0n);
  assert.equal(p.netBase, 201n * 10n ** 18n);
  // 201 MON at mid 0.02472450 = 4.9696245 USDC; cost 4.976961 -> -0.0073365 USDC
  assert.equal(floor(p.unrealized.mid.value!), -7337n); // -7336.5 rounded down
  // at the best bid 0.024724: 4.969524 -> -0.007437
  assert.equal(floor(p.unrealized.executable.value!), -7437n);
  assert.match(p.unrealized.executable.note, /depth ignored/);
  // identity: total(mid) = Σquote + Σbase × mid − fees
  const pMid = priceRaw(q(book.bestBid + book.bestAsk, 2n), market);
  assert.deepEqual(p.total.mid, add(q(p.flows.quote), mul(q(p.flows.base), pMid)));

  const v = accountView(L, raw.market, book);
  assert.equal(v.gas.wei, BigInt(fx.expected.gasTotalWei));
  assert.equal(v.growth.base, 201n * 10n ** 18n);
  assert.equal(v.growth.quote, -4976961n);
  // capital = peak net deposit = 6 USDC; net = PnL at mid − gas valued at mid
  assert.deepEqual(v.growth.capitalQuoteEquivMid, q(6000000n));
  const gasMid = mul(q(BigInt(fx.expected.gasTotalWei)), pMid);
  assert.deepEqual(v.growth.netQuoteEquivMid, sub(p.total.mid!, gasMid));
  // −0.0073365 USDC − 0.095135113 MON × 0.0247245 ≈ −0.00969 USDC on 6 USDC ≈ −16.2 bps
  assert.equal(v.growth.growthBps, -17n);
});

test('PnL while the ask was resting: inventory is all base inside Kuru', () => {
  const L = ledgerAt(Number(fx.snapshots.find((s: { name: string }) => s.name === 'afterFill').block));
  const book = { bestBid: 2476000n, bestAsk: 2476100n };
  const v = accountView(L, raw.market, book);
  // equity: 201 MON (locked in the ask) + 1.023039 USDC free
  assert.equal(v.inventory.quoteValue, 1023039n);
  assert.ok(v.inventory.baseShareBps! > 8000n && v.inventory.baseShareBps! < 8400n);
  assert.equal(v.inventory.imbalanceBps, 2n * v.inventory.baseShareBps! - 10000n);
  // capital = 6 USDC deposited; growth = PnL at mid − gas
  assert.ok(v.growth.growthBps! < 0n);
});

test('NEGATIVE: reading Trade.isBuy as the maker side is caught (known orders)', () => {
  const L = ledgerAt(undefined, { tradeIsBuy: 'maker' });
  assert.ok(L.issues.some((i) => i.code === 'TRADE_SIDE_MISMATCH' && i.severity === 'error'));
  const r = reconcile(L, chainAt('final'));
  assert.equal(r.ok, false);
});

test('NEGATIVE: with only fills and margin events, the maker reading fails reconciliation and is diagnosed', () => {
  const only = events.filter((e) => e.name === 'Trade' || e.name === 'Deposit' || e.name === 'Withdrawal');
  const good = buildLedger({ account: WALLET, markets: [market], events: only, txs });
  const rGood = reconcile(good, chainAt('final'));
  assert.equal(rGood.diffs.filter((d) => d.check === 'EQUITY').every((d) => d.ok), true);
  assert.ok(good.issues.some((i) => i.code === 'ORDER_NOT_SEEN'));

  const bad = buildLedger({ account: WALLET, markets: [market], events: only, txs, tradeIsBuy: 'maker' });
  const r = reconcile(bad, chainAt('final'));
  assert.equal(r.ok, false);
  const usdc = r.diffs.find((d) => d.check === 'EQUITY' && d.token === USDC)!;
  assert.equal(usdc.ok, false);
  assert.equal(usdc.diff, -2n * 4976961n);
  assert.ok(usdc.hints.includes('trade-side-reversed'));
});

test('idempotent: feeding every event twice changes nothing', () => {
  const once = ledgerAt();
  const twice = buildLedger({ account: WALLET, markets: [market], events: [...events, ...events].reverse(), txs: [...txs, ...txs] });
  assert.deepEqual([...twice.balances], [...once.balances]);
  assert.equal(twice.fills.length, once.fills.length);
  assert.equal(twice.gas.totalWei, once.gas.totalWei);
});
