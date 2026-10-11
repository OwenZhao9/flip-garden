// Differential tests of the dependency-free Perpl encoders against ethers (tests only), including
// selectors, and of the event table against the exchange ABI recorded in config/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { rng, randBig } from './helpers/sim.ts';
import { selector, topic0 } from '../src/perpl/abi.ts';
import {
  ORDER_TYPE, SIGNATURES, cancelOrder, changeOrder, closeLong, closeShort, encodeAllowOrderForwarding, encodeApprove,
  encodeCreateAccount, encodeDepositCollateral, encodeExecOrder, encodeExecOrders, encodeWithdrawCollateral,
  increasePositionCollateral, openLong, openShort, orderDesc, type OrderDesc,
} from '../src/perpl/encode.ts';
import { EVENT_SIGNATURES, EVENT_TOPICS } from '../src/perpl/events.ts';

const require = createRequire(import.meta.url);
const { ethers } = require('ethers');
const root = path.join(import.meta.dirname, '..');
const abi = JSON.parse(fs.readFileSync(path.join(root, 'config', 'perpl.exchange.abi.json'), 'utf8'));
const errors = JSON.parse(fs.readFileSync(path.join(root, 'config', 'perpl.errors.json'), 'utf8')).errors as string[];
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'perpl.mainnet.json'), 'utf8'));
const iface = new ethers.utils.Interface(abi);
const erc20 = new ethers.utils.Interface(['function approve(address,uint256) returns (bool)']);

const toTuple = (d: OrderDesc): unknown[] => [
  d.orderDescId, d.perpId, d.orderType, d.orderId, d.pricePNS, d.lotLNS, d.expiryBlock, d.postOnly, d.fillOrKill,
  d.immediateOrCancel, d.maxMatches, d.leverageHdths, d.lastExecutionBlock, d.amountCNS, d.maxNegPnlCollatBPS,
];

test('selectors of every function we encode match ethers and the recorded ABI', () => {
  for (const [name, sig] of Object.entries(SIGNATURES)) {
    if (name === 'approve') {
      assert.equal(selector(sig), erc20.getSighash('approve'));
      continue;
    }
    assert.equal(selector(sig), iface.getSighash(name), name);
  }
  // known selectors from the live capture (docs/PERPL-ONCHAIN.md): createAccount(uint256)
  assert.equal(selector(SIGNATURES.createAccount), iface.getSighash('createAccount'));
});

test('simple calls equal ethers output', () => {
  const r = rng(7);
  for (let i = 0; i < 200; i++) {
    const amount = randBig(r, 0n, 10n ** 12n);
    assert.equal(encodeCreateAccount(amount), iface.encodeFunctionData('createAccount', [amount]));
    assert.equal(encodeDepositCollateral(amount), iface.encodeFunctionData('depositCollateral', [amount]));
    assert.equal(encodeWithdrawCollateral(amount), iface.encodeFunctionData('withdrawCollateral', [amount]));
    assert.equal(encodeAllowOrderForwarding(i % 2 === 0), iface.encodeFunctionData('allowOrderForwarding', [i % 2 === 0]));
    assert.equal(encodeApprove(cfg.exchange, amount), erc20.encodeFunctionData('approve', [cfg.exchange, amount]));
  }
});

function randomDesc(r: () => number): OrderDesc {
  const flags = Math.floor(r() * 4); // post-only | fok | ioc | none, never combined
  return orderDesc({
    orderDescId: randBig(r, 0n, 1n << 64n),
    perpId: randBig(r, 0n, 200n),
    orderType: Math.floor(r() * 7),
    orderId: randBig(r, 0n, 65535n),
    pricePNS: randBig(r, 0n, 1n << 40n),
    lotLNS: randBig(r, 0n, 1n << 40n),
    expiryBlock: randBig(r, 0n, 1n << 32n),
    postOnly: flags === 0,
    fillOrKill: flags === 1,
    immediateOrCancel: flags === 2,
    maxMatches: randBig(r, 0n, 1000n),
    leverageHdths: randBig(r, 0n, 2000n),
    lastExecutionBlock: randBig(r, 0n, 1n << 32n),
    amountCNS: randBig(r, 0n, 1n << 70n),
    maxNegPnlCollatBPS: randBig(r, 0n, 10000n),
  });
}

test('execOrder and execOrders equal ethers for random descriptors and batches', () => {
  const r = rng(11);
  for (let i = 0; i < 300; i++) {
    const d = randomDesc(r);
    assert.equal(encodeExecOrder(d), iface.encodeFunctionData('execOrder', [toTuple(d)]));
    const batch = Array.from({ length: Math.floor(r() * 5) }, () => randomDesc(r));
    for (const revert of [true, false]) {
      assert.equal(encodeExecOrders(batch, revert), iface.encodeFunctionData('execOrders', [batch.map(toTuple), revert]), `batch of ${batch.length}`);
    }
  }
});

test('order builders produce the descriptors the contract expects', () => {
  const base = { perpId: 10, pricePNS: 24913, lotLNS: 100, leverageHdths: 500 };
  assert.equal(openLong(base).orderType, ORDER_TYPE.OpenLong);
  assert.equal(openShort(base).orderType, ORDER_TYPE.OpenShort);
  assert.equal(closeLong(base).orderType, ORDER_TYPE.CloseLong);
  assert.equal(closeShort(base).orderType, ORDER_TYPE.CloseShort);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6], Object.values(ORDER_TYPE));
  const c = cancelOrder({ perpId: 10, orderId: 47, pricePNS: 25678, lotLNS: 1000 });
  assert.equal(c.orderType, 4);
  assert.equal(c.orderId, 47n);
  assert.equal(changeOrder({ perpId: 10, orderId: 47, pricePNS: 26000, lotLNS: 1000, leverageHdths: 500 }).orderType, 6);
  const inc = increasePositionCollateral({ perpId: 10, amountCNS: 1_000_000 });
  assert.equal(inc.orderType, 5);
  assert.equal(inc.amountCNS, 1_000_000n);
  // defaults match the SDK's: no expiry, no deadline, the contract's own match cap, 10% negative-PnL collateral
  assert.deepEqual([openShort(base).expiryBlock, openShort(base).maxMatches, openShort(base).maxNegPnlCollatBPS], [0n, 0n, 1000n]);
});

test('the encoders refuse inputs the exchange would misread', () => {
  const base = { perpId: 10, pricePNS: 24913, lotLNS: 100, leverageHdths: 500 };
  assert.throws(() => openShort({ ...base, lotLNS: 0 }), /lotLNS/);
  assert.throws(() => openShort({ ...base, pricePNS: 0 }), /pricePNS/);
  assert.throws(() => openShort({ ...base, leverageHdths: 0 }), /leverage/); // 0 would mean "maximum leverage"
  assert.throws(() => encodeExecOrder(openShort({ ...base, postOnly: true, immediateOrCancel: true })), /post-only/);
  assert.throws(() => encodeExecOrder(openShort({ ...base, fillOrKill: true, immediateOrCancel: true })), /fill-or-kill/);
  assert.throws(() => encodeExecOrder(openShort({ ...base, maxMatches: 1001 })), /maxMatches/);
  assert.throws(() => encodeCreateAccount(-1n), /uint256/);
  assert.throws(() => encodeApprove('0x1234', 1n), /address/);
  assert.throws(() => increasePositionCollateral({ perpId: 10, amountCNS: 0 }), /amountCNS/);
});

test('the event table matches the recorded ABI (names, topics, field order and types)', () => {
  const byName = new Map<string, { inputs: Array<{ type: string; name: string; indexed: boolean }> }>();
  for (const e of abi.filter((a: { type: string }) => a.type === 'event')) byName.set(e.name, e);
  for (const [name, sig] of Object.entries(EVENT_SIGNATURES)) {
    const e = byName.get(name);
    assert.ok(e, `${name} is in the ABI`);
    assert.equal(sig, `${name}(${e.inputs.map((i) => i.type).join(',')})`);
    assert.equal(EVENT_TOPICS[name], iface.getEventTopic(name));
    assert.equal(topic0(sig), iface.getEventTopic(name));
    assert.ok(e.inputs.every((i) => !i.indexed), `${name} has no indexed parameter`);
  }
});

test('error signatures are unique selectors and include the ones the simulations hit', () => {
  const sels = new Set(errors.map(selector));
  assert.equal(sels.size, errors.length);
  assert.ok(errors.includes('InsufficentAmountToOpenAccount(address,uint256)')); // sic: spelled so on chain
  assert.equal(selector('InsufficentAmountToOpenAccount(address,uint256)'), '0xcfe73bb0'); // seen in the live simulation
  for (const sig of errors) assert.equal(selector(sig), ethers.utils.id(sig).slice(0, 10));
});
