// The dependency-free ABI encoders against ethers (the Kuru SDK's own encoder) and the SDK's ABI files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FUNCTIONS, KURU_ERRORS, SELECTORS, decodeCall, encodeApprove, encodeCancelFlipOrders, encodeDeposit, encodeProvision, encodeWithdrawMax, revertReason, selector, type FnName } from '../src/abi.ts';

const { ethers } = createRequire(import.meta.url)('ethers');
const abiDir = path.join(import.meta.dirname, '..', 'node_modules', '@kuru-labs', 'kuru-sdk', 'abi');
const load = (n: string) => {
  const j = JSON.parse(fs.readFileSync(path.join(abiDir, `${n}.json`), 'utf8'));
  return Array.isArray(j) ? j : j.abi;
};
const orderBook = new ethers.utils.Interface(load('OrderBook'));
const margin = new ethers.utils.Interface(load('MarginAccount'));
const erc20 = new ethers.utils.Interface(load('IERC20'));

let seed = 12345n;
const rnd = (bits: number): bigint => {
  let v = 0n;
  for (let i = 0; i < bits; i += 32) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    v = (v << 32n) | (seed >> 32n);
  }
  return v & ((1n << BigInt(bits)) - 1n);
};
const rndAddr = (): string => '0x' + rnd(160).toString(16).padStart(40, '0');

test('every selector equals ethers on the SDK ABI', () => {
  const where: Record<FnName, typeof orderBook> = {
    approve: erc20, balanceOf: erc20, allowance: erc20,
    deposit: margin, getBalance: margin, verifiedMarket: margin, batchWithdrawMaxTokens: margin,
    batchProvisionLiquidity: orderBook, batchCancelFlipOrders: orderBook, s_orders: orderBook, bestBidAsk: orderBook, getMarketParams: orderBook,
  };
  for (const name of Object.keys(FUNCTIONS) as FnName[]) {
    const frag = where[name].getFunction(name);
    assert.equal(FUNCTIONS[name].sig, frag.format('sighash'), `${name} signature`);
    assert.equal(SELECTORS[name], where[name].getSighash(frag), `${name} selector`);
  }
});

test('approve, deposit, cancel, withdraw encode exactly like ethers (random inputs)', () => {
  for (let i = 0; i < 200; i++) {
    const a = rndAddr(), b = rndAddr(), amt = rnd(256);
    assert.equal(encodeApprove(a, amt), erc20.encodeFunctionData('approve', [a, amt]));
    assert.equal(encodeDeposit(a, b, amt), margin.encodeFunctionData('deposit', [a, b, amt]));
    const n = 1 + Number(rnd(8) % 7n);
    const ids = Array.from({ length: n }, () => rnd(40));
    assert.equal(encodeCancelFlipOrders(ids), orderBook.encodeFunctionData('batchCancelFlipOrders', [ids]));
    const toks = Array.from({ length: n }, rndAddr);
    assert.equal(encodeWithdrawMax(toks), margin.encodeFunctionData('batchWithdrawMaxTokens', [toks]));
  }
});

test('batchProvisionLiquidity encodes exactly like ethers, for 1 to 6 bids and both flag values', () => {
  for (let i = 0; i < 300; i++) {
    const n = 1 + (i % 6);
    const bids = Array.from({ length: n }, () => ({ price: rnd(32), flipPrice: rnd(32), size: rnd(96) }));
    const flag = i % 2 === 0;
    const expect = orderBook.encodeFunctionData('batchProvisionLiquidity', [bids.map((b) => b.price), bids.map((b) => b.flipPrice), bids.map((b) => b.size), bids.map(() => true), flag]);
    assert.equal(encodeProvision(bids, flag), expect);
  }
});

test('decodeCall is the inverse of the encoders and agrees with ethers', () => {
  const bids = [{ price: 2476000n, flipPrice: 2478600n, size: 2010000000000n }, { price: 2473500n, flipPrice: 2476000n, size: 2010000000000n }];
  const data = encodeProvision(bids, true);
  const d = decodeCall(data)!;
  assert.equal(d.name, 'batchProvisionLiquidity');
  assert.deepEqual(d.args, [[2476000n, 2473500n], [2478600n, 2476000n], [2010000000000n, 2010000000000n], [true, true], true]);
  const e = orderBook.decodeFunctionData('batchProvisionLiquidity', data);
  assert.deepEqual(e[0].map((x: { toString(): string }) => BigInt(x.toString())), d.args[0]);
  assert.equal(decodeCall('0xdeadbeef'), null);
});

test('values outside the type range are refused before encoding', () => {
  assert.throws(() => encodeProvision([{ price: 1n << 32n, flipPrice: 1n, size: 1n }], true), /out of range/);
  assert.throws(() => encodeProvision([{ price: 1n, flipPrice: 1n, size: 1n << 96n }], true), /out of range/);
  assert.throws(() => encodeCancelFlipOrders([1n << 40n]), /out of range/);
  assert.throws(() => encodeApprove('0x123', 1n), /invalid/);
  assert.throws(() => encodeApprove(rndAddr(), -1n), /out of range/);
  assert.throws(() => encodeProvision([], true), /no orders/);
  assert.throws(() => encodeCancelFlipOrders([]), /no order ids/);
});

test('custom error selectors match the SDK ABI and revert reasons are decoded', () => {
  const sighash = (name: string): string => {
    for (const i of [orderBook, margin]) {
      try {
        return i.getSighash(i.getError(name));
      } catch {
        // not in this contract's ABI
      }
    }
    throw new Error(`${name} is in neither ABI`);
  };
  for (const name of KURU_ERRORS) assert.equal(selector(`${name}()`), sighash(name), name);
  assert.equal(revertReason(new Error(`eth_call: ${JSON.stringify({ code: 3, message: 'execution reverted', data: selector('ProvisionError()') })}`)), 'ProvisionError');
  const msg = ethers.utils.defaultAbiCoder.encode(['string'], ['ERC20: insufficient allowance']);
  assert.equal(revertReason(new Error(`eth_call: {"data":"0x08c379a0${msg.slice(2)}"}`)), 'ERC20: insufficient allowance');
  assert.match(revertReason(new Error('socket hang up')), /socket hang up/);
});
