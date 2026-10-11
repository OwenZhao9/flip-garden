// The Perpl allow-list: every accepted transaction decodes to exactly what is allowed, and every refusal has a test.
// Calldata is built with ethers (tests only) from the pinned ABI, independently of src/perpl/encode.ts, so the guard's
// own decoder is checked against a second implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PERPL, decodeExecOrders, guardPerplTx, isPerplKind, type PerplTx } from '../src/perpl/guard.ts';
import { guardTx, planApprove, planDeposit, type PlannedTx } from '../src/plant.ts';
import { closeShort, encodeApprove, encodeCreateAccount, encodeExecOrders, encodeWithdrawCollateral, openLong, openShort, cancelOrder, changeOrder } from '../src/perpl/encode.ts';
import { planPerplApprove, planPerplClose, planPerplCreate, planPerplOpen, planPerplWithdraw } from '../src/perpl/hedgeflow.ts';
import { AUSD, FLOW_ROUTER } from '../src/swapguard.ts';
import { CHAIN } from '../src/plant.ts';

const require = createRequire(import.meta.url);
const { ethers } = require('ethers');
const root = path.join(import.meta.dirname, '..');
const abi = JSON.parse(fs.readFileSync(path.join(root, 'config', 'perpl.exchange.abi.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'perpl.mainnet.json'), 'utf8'));
const iface = new ethers.utils.Interface(abi);
const USER = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';
const EX = PERPL.exchange;
const SOON = 112_400_500n;

const open = (o: Partial<Parameters<typeof openShort>[0]> = {}) =>
  openShort({ perpId: 10n, pricePNS: 25_000n, lotLNS: 100n, leverageHdths: 200n, immediateOrCancel: true, lastExecutionBlock: SOON, ...o });
const close = (o: Partial<Parameters<typeof closeShort>[0]> = {}) =>
  closeShort({ perpId: 10n, pricePNS: 25_500n, lotLNS: 100n, leverageHdths: 200n, immediateOrCancel: true, lastExecutionBlock: SOON, ...o });
// Orders the repo's own encoder refuses to build (it checks too), made with ethers so the guard is tested on its own.
const raw = (o: Partial<Record<'orderType' | 'perpId' | 'postOnly' | 'fillOrKill' | 'ioc' | 'maxMatches', number | boolean>> = {}) =>
  iface.encodeFunctionData('execOrders', [[[0, o.perpId ?? 10, o.orderType ?? 1, 0, 25_000, 100, 0, o.postOnly ?? false, o.fillOrKill ?? false, o.ioc ?? true, o.maxMatches ?? 0, 200, Number(SOON), 0, 1000]], true]);
const T = (kind: PerplTx['kind'], to: string, data: string, value = '0x0'): PerplTx => ({ kind, from: USER, to, data, value });
const openTx = (d = open(), to = EX, rof = true) => T('perplOpen', to, encodeExecOrders([d], rof));
const closeTx = (d = close(), to = EX) => T('perplClose', to, encodeExecOrders([d], true));

test('constants mirror the config and the pinned addresses', () => {
  assert.equal(PERPL.exchange, cfg.exchange);
  assert.equal(PERPL.ausd, cfg.ausd.address);
  assert.equal(AUSD, cfg.ausd.address);
  assert.equal(Number(PERPL.perpId), cfg.markets.MON.perpId);
  assert.equal(PERPL.maxNotionalCNS, 15_000_000n);
  assert.equal(PERPL.maxLeverageHdths, 200n);
});

test('the guard accepts exactly the five planned transactions', () => {
  assert.equal(guardPerplTx(planPerplApprove(USER, 10_000_000n)), null);
  assert.equal(guardPerplTx(planPerplCreate(USER, 10_000_000n, 10_000_000n)), null);
  assert.equal(guardPerplTx(planPerplOpen(USER, { lot: 100n, boundPNS: 25_000n, lastExecutionBlock: SOON })), null);
  assert.equal(guardPerplTx(planPerplClose(USER, { lot: 100n, boundPNS: 25_500n, lastExecutionBlock: SOON })), null);
  assert.equal(guardPerplTx(planPerplWithdraw(USER, 9_000_000n)), null);
  // plant.ts guardTx routes the same kinds here
  assert.equal(guardTx(planPerplOpen(USER, { lot: 100n, boundPNS: 25_000n, lastExecutionBlock: SOON })), null);
  assert.ok(isPerplKind('perplOpen') && !isPerplKind('plant'));
});

test('differential: calldata built by ethers from the pinned ABI is accepted, and the decoder reads it back', () => {
  const desc = [0, 10, 1, 0, 25_000, 100, 0, false, false, true, 0, 200, Number(SOON), 0, 1000];
  const data = iface.encodeFunctionData('execOrders', [[desc], true]);
  const c = decodeExecOrders(data)!;
  assert.equal(c.revertOnFail, true);
  assert.equal(c.orders.length, 1);
  assert.deepEqual([c.orders[0].perpId, c.orders[0].orderType, c.orders[0].pricePNS, c.orders[0].lotLNS, c.orders[0].leverageHdths, c.orders[0].lastExecutionBlock], [10n, 1, 25_000n, 100n, 200n, SOON]);
  assert.equal(guardPerplTx(T('perplOpen', EX, data)), null);
  const approve = iface.encodeFunctionData('createAccount', [10_000_000]);
  assert.equal(guardPerplTx(T('perplCreate', EX, approve)), null);
  assert.equal(guardPerplTx(T('perplWithdraw', EX, iface.encodeFunctionData('withdrawCollateral', [5_000_000]))), null);
});

test('approve: AUSD only, spender = the exchange, exact and capped, never unlimited', () => {
  assert.match(guardPerplTx(T('perplApprove', CHAIN.usdc, encodeApprove(EX, 5_000_000n)))!, /only allowed on AUSD/);
  assert.match(guardPerplTx(T('perplApprove', AUSD, encodeApprove(FLOW_ROUTER, 5_000_000n)))!, /Perpl exchange/);
  assert.match(guardPerplTx(T('perplApprove', AUSD, encodeApprove(CHAIN.marginAccount, 5_000_000n)))!, /Perpl exchange/);
  assert.match(guardPerplTx(T('perplApprove', AUSD, encodeApprove(EX, 2n ** 256n - 1n)))!, /never unlimited/);
  assert.match(guardPerplTx(T('perplApprove', AUSD, encodeApprove(EX, 15_000_001n)))!, /never unlimited/);
  assert.match(guardPerplTx(T('perplApprove', AUSD, encodeApprove(EX, 0n)))!, /never unlimited/);
  assert.match(guardPerplTx(T('perplApprove', AUSD, encodeCreateAccount(10_000_000n)))!, /not an approve/);
  assert.equal(guardPerplTx(T('perplApprove', AUSD, encodeApprove(EX, 15_000_000n))), null);
});

test('create account: right target, 0 < deposit <= 15 AUSD, and at least the live minimum when the plan carries it', () => {
  assert.match(guardPerplTx(T('perplCreate', AUSD, encodeCreateAccount(10_000_000n)))!, /only created on the Perpl exchange/);
  assert.match(guardPerplTx(T('perplCreate', EX, encodeCreateAccount(15_000_001n)))!, /within 15 AUSD/);
  assert.match(guardPerplTx(T('perplCreate', EX, encodeCreateAccount(0n)))!, /within 15 AUSD/);
  assert.match(guardPerplTx({ ...T('perplCreate', EX, encodeCreateAccount(9_999_999n)), minDepositCNS: 10_000_000n })!, /below the exchange minimum/);
  assert.match(guardPerplTx(T('perplCreate', EX, encodeWithdrawCollateral(5_000_000n)))!, /not an account creation/);
});

test('open: only a short on market 10, immediate-or-cancel, reduce nothing, 2x, 15 USD, deadline set', () => {
  assert.match(guardPerplTx(openTx(openLong({ perpId: 10n, pricePNS: 25_000n, lotLNS: 100n, leverageHdths: 200n, immediateOrCancel: true, lastExecutionBlock: SOON })))!, /only a short can be opened/);
  assert.match(guardPerplTx(openTx(open({ perpId: 11n })))!, /market 10/);
  assert.match(guardPerplTx(openTx(open({ perpId: 0n })))!, /market 10/);
  assert.match(guardPerplTx(openTx(open({ immediateOrCancel: false })))!, /immediate-or-cancel/);
  assert.match(guardPerplTx(T('perplOpen', EX, raw({ postOnly: true })))!, /immediate-or-cancel/);
  assert.match(guardPerplTx(T('perplOpen', EX, raw({ postOnly: true, ioc: false })))!, /immediate-or-cancel/);
  assert.match(guardPerplTx(T('perplOpen', EX, raw({ fillOrKill: true })))!, /immediate-or-cancel/);
  assert.match(guardPerplTx(openTx(open({ fillOrKill: true, immediateOrCancel: false })))!, /immediate-or-cancel/);
  assert.match(guardPerplTx(openTx(open({ leverageHdths: 201n })))!, /leverage/);
  assert.match(guardPerplTx(openTx(open({ leverageHdths: 1000n })))!, /leverage/);
  assert.match(guardPerplTx(openTx(open({ lastExecutionBlock: 0n })))!, /deadline/);
  assert.match(guardPerplTx(openTx(open({ expiryBlock: 10n })))!, /fields this page never sets/);
  assert.match(guardPerplTx(openTx(open({ maxNegPnlCollatBPS: 1001n })))!, /10% of notional/);
  assert.match(guardPerplTx(T('perplOpen', EX, raw({ maxMatches: 1001 })))!, /too many matches/);
  assert.match(guardPerplTx(T('perplOpen', EX, raw({ orderType: 0 })))!, /only a short can be opened/); // a long, as ethers builds it
});

test('open: the notional cap is 15 USD at the price bound, whatever the size or price', () => {
  assert.equal(guardPerplTx(openTx(open({ lotLNS: 600n, pricePNS: 25_000n }))), null); // 15.0 USD exactly
  assert.match(guardPerplTx(openTx(open({ lotLNS: 601n, pricePNS: 25_000n })))!, /15 USD cap/);
  assert.match(guardPerplTx(openTx(open({ lotLNS: 1n, pricePNS: 15_000_001n })))!, /15 USD cap/);
  assert.match(guardPerplTx(openTx(open({ lotLNS: 5_000_000n })))!, /15 USD cap/);
});

test('open: wrong target, value, more or fewer orders, revertOnFail false, a cancel or change order, other selectors', () => {
  assert.match(guardPerplTx(openTx(open(), CHAIN.marginAccount))!, /only go to the Perpl exchange/);
  assert.match(guardPerplTx(openTx(open(), AUSD))!, /only go to the Perpl exchange/);
  assert.match(guardPerplTx({ ...openTx(), value: '0x1' })!, /never sends MON/);
  assert.match(guardPerplTx(openTx(open(), EX, false))!, /revert as a whole/);
  assert.match(guardPerplTx(T('perplOpen', EX, encodeExecOrders([open(), open()], true)))!, /exactly one order/);
  assert.match(guardPerplTx(T('perplOpen', EX, encodeExecOrders([], true)))!, /exactly one order/);
  assert.match(guardPerplTx(T('perplOpen', EX, encodeExecOrders([cancelOrder({ perpId: 10n, orderId: 5n, pricePNS: 25_000n, lotLNS: 100n })], true)))!, /only a short can be opened/);
  assert.match(guardPerplTx(T('perplOpen', EX, encodeExecOrders([changeOrder({ perpId: 10n, orderId: 5n, pricePNS: 25_000n, lotLNS: 100n, leverageHdths: 200n })], true)))!, /only a short can be opened/);
  assert.match(guardPerplTx(T('perplOpen', EX, encodeExecOrders([close()], true)))!, /only a short can be opened/);
  assert.match(guardPerplTx(T('perplOpen', EX, iface.encodeFunctionData('execOrder', [[0, 10, 1, 0, 25_000, 100, 0, false, false, true, 0, 200, Number(SOON), 0, 1000]])))!, /not the Perpl order call/);
  assert.match(guardPerplTx(T('perplOpen', EX, iface.encodeFunctionData('allowOrderForwarding', [true])))!, /not the Perpl order call/);
  assert.match(guardPerplTx(T('perplOpen', EX, iface.encodeFunctionData('depositCollateral', [5_000_000])))!, /not the Perpl order call/);
  assert.match(guardPerplTx(T('perplOpen', EX, '0x'))!, /not the Perpl order call/);
  const good = encodeExecOrders([open()], true);
  assert.match(guardPerplTx(T('perplOpen', EX, good.slice(0, -64)))!, /not the Perpl order call/); // truncated
  assert.match(guardPerplTx(T('perplOpen', EX, good + '00'))!, /not the Perpl order call/); // trailing garbage
});

test('close: only a reduce-only close of a short on market 10; a close cannot be used as an open and vice versa', () => {
  assert.equal(guardPerplTx(closeTx()), null);
  assert.match(guardPerplTx(closeTx(openShort({ perpId: 10n, pricePNS: 25_000n, lotLNS: 100n, leverageHdths: 200n, immediateOrCancel: true, lastExecutionBlock: SOON })))!, /only a short can be closed/);
  assert.match(guardPerplTx(closeTx(close({ perpId: 3n })))!, /market 10/);
  assert.match(guardPerplTx(closeTx(close({ immediateOrCancel: false })))!, /immediate-or-cancel/);
  assert.match(guardPerplTx(closeTx(close({ lastExecutionBlock: 0n })))!, /deadline/);
  assert.match(guardPerplTx(closeTx(close({ lotLNS: 2_000n, pricePNS: 25_000n })))!, /larger than any hedge/);
  assert.match(guardPerplTx(closeTx(close(), AUSD))!, /only go to the Perpl exchange/);
  assert.match(guardPerplTx({ ...closeTx(), value: '0x1' })!, /never sends MON/);
  assert.match(guardPerplTx(closeTx(close({ leverageHdths: 500n })))!, /leverage/);
  assert.match(guardPerplTx(T('perplClose', EX, encodeExecOrders([open()], true)))!, /only a short can be closed/);
});

test('withdraw: only from the exchange, only the exact call, within the cap', () => {
  assert.match(guardPerplTx(T('perplWithdraw', AUSD, encodeWithdrawCollateral(5_000_000n)))!, /only come from the Perpl exchange/);
  assert.match(guardPerplTx(T('perplWithdraw', EX, encodeWithdrawCollateral(0n)))!, /above 0/);
  assert.match(guardPerplTx(T('perplWithdraw', EX, encodeWithdrawCollateral(45_000_001n)))!, /above 0/);
  assert.match(guardPerplTx(T('perplWithdraw', EX, encodeCreateAccount(5_000_000n)))!, /not a withdrawal/);
  assert.match(guardPerplTx({ ...T('perplWithdraw', EX, encodeWithdrawCollateral(5_000_000n)), value: '0x1' })!, /never sends MON/);
});

test('Kuru guard unchanged, and Perpl calldata cannot ride on a Kuru step nor Kuru calldata on a Perpl step', () => {
  assert.equal(guardTx(planApprove(USER, 5_000_000n)), null);
  assert.equal(guardTx(planDeposit(USER, 5_000_000n)), null);
  const perplApprove: PlannedTx = { kind: 'approve', from: USER, to: AUSD, data: encodeApprove(EX, 5_000_000n), value: '0x0' };
  assert.match(guardTx(perplApprove)!, /only allowed on USDC/);
  assert.match(guardTx({ ...planPerplOpen(USER, { lot: 100n, boundPNS: 25_000n, lastExecutionBlock: SOON }), kind: 'plant' })!, /unknown function/);
  assert.match(guardTx({ ...planApprove(USER, 5_000_000n), kind: 'perplApprove' })!, /AUSD/);
  assert.match(guardTx({ ...planDeposit(USER, 5_000_000n), kind: 'perplCreate' })!, /./);
});
