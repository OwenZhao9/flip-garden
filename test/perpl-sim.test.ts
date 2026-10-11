// The forwarding bytecode used for simulations, run on a small reference interpreter of the handful of
// EVM instructions it uses; the AUSD storage overrides checked against ethers; revert decoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ErrorBook, ausdOverride, forwarderCode, packCalls, simOverrides, simulate } from '../src/perpl/sim.ts';

const require = createRequire(import.meta.url);
const { ethers } = require('ethers');
const root = path.join(import.meta.dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'perpl.mainnet.json'), 'utf8'));
const errors = JSON.parse(fs.readFileSync(path.join(root, 'config', 'perpl.errors.json'), 'utf8')).errors as string[];
const X = cfg.exchange as string;

type CallRecord = { to: string; data: string };
type Outcome = { ok: boolean; ret: string };

// Executes `code` with `calldata`; every CALL is answered by `callee`. Returns what the program returned or reverted with.
function run(codeHex: string, calldataHex: string, callee: (c: CallRecord) => Outcome): { status: 'return' | 'revert'; data: string; calls: CallRecord[] } {
  const code = Buffer.from(codeHex.slice(2), 'hex');
  const cd = Buffer.from(calldataHex.slice(2), 'hex');
  const stack: bigint[] = [];
  const mem = new Map<number, number>();
  let rd = Buffer.alloc(0);
  const calls: CallRecord[] = [];
  const pop = (): bigint => {
    const v = stack.pop();
    if (v === undefined) throw new Error('stack underflow');
    return v;
  };
  const memRead = (off: number, len: number): Buffer => Buffer.from(Array.from({ length: len }, (_, i) => mem.get(off + i) ?? 0));
  const memWrite = (off: number, b: Buffer): void => b.forEach((x, i) => mem.set(off + i, x));
  let pc = 0;
  for (let steps = 0; steps < 100000; steps++) {
    const op = code[pc];
    if (op === undefined) throw new Error('ran off the end');
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      stack.push(BigInt('0x' + code.subarray(pc + 1, pc + 1 + n).toString('hex')));
      pc += 1 + n;
      continue;
    }
    pc++;
    switch (op) {
      case 0x5b: break; // JUMPDEST
      case 0x80: stack.push(stack[stack.length - 1]); break; // DUP1
      case 0x81: stack.push(stack[stack.length - 2]); break; // DUP2
      case 0x83: stack.push(stack[stack.length - 4]); break; // DUP4
      case 0x90: { const a = pop(); const b = pop(); stack.push(a, b); break; } // SWAP1
      case 0x01: stack.push(pop() + pop()); break; // ADD
      case 0x11: { const a = pop(); const b = pop(); stack.push(a > b ? 1n : 0n); break; } // GT
      case 0x15: stack.push(pop() === 0n ? 1n : 0n); break; // ISZERO
      case 0x35: { const o = Number(pop()); stack.push(BigInt('0x' + Buffer.concat([cd, Buffer.alloc(32)]).subarray(o, o + 32).toString('hex'))); break; } // CALLDATALOAD
      case 0x36: stack.push(BigInt(cd.length)); break; // CALLDATASIZE
      case 0x37: { const d = Number(pop()); const o = Number(pop()); const n = Number(pop()); memWrite(d, cd.subarray(o, o + n)); break; } // CALLDATACOPY
      case 0x3d: stack.push(BigInt(rd.length)); break; // RETURNDATASIZE
      case 0x3e: { const d = Number(pop()); const o = Number(pop()); const n = Number(pop()); memWrite(d, rd.subarray(o, o + n)); break; } // RETURNDATACOPY
      case 0x5a: stack.push(1_000_000n); break; // GAS
      case 0xf1: { // CALL gas addr value argsOff argsLen retOff retLen
        pop();
        const to = '0x' + pop().toString(16).padStart(40, '0');
        pop();
        const ao = Number(pop());
        const al = Number(pop());
        pop();
        pop();
        const rec = { to, data: '0x' + memRead(ao, al).toString('hex') };
        calls.push(rec);
        const r = callee(rec);
        rd = Buffer.from(r.ret.slice(2), 'hex');
        stack.push(r.ok ? 1n : 0n);
        break;
      }
      case 0x56: pc = Number(pop()); break; // JUMP
      case 0x57: { const d = Number(pop()); const c = pop(); if (c !== 0n) pc = d; break; } // JUMPI
      case 0xf3: case 0xfd: { const o = Number(pop()); const n = Number(pop()); return { status: op === 0xf3 ? 'return' : 'revert', data: '0x' + memRead(o, n).toString('hex'), calls }; }
      default: throw new Error(`opcode 0x${op.toString(16)} not implemented in the reference interpreter`);
    }
  }
  throw new Error('step limit');
}

const code = forwarderCode(X);

test('forwarder: calls the exchange once per record, in order, with exactly the record bytes, and returns the last result', () => {
  const calls = ['0xaabbccdd' + '11'.repeat(32), '0x01', '0xdeadbeef' + '22'.repeat(100)];
  const r = run(code, packCalls(calls), (c) => ({ ok: true, ret: '0x' + c.data.slice(2, 10).padEnd(8, '0') }));
  assert.equal(r.status, 'return');
  assert.deepEqual(r.calls, calls.map((data) => ({ to: X.toLowerCase(), data })));
  assert.equal(r.data, '0xdeadbeef'); // last callee's return data
});

test('forwarder: stops at the first failing call and bubbles its revert data', () => {
  let n = 0;
  const r = run(code, packCalls(['0x01', '0x02', '0x03']), () => (++n === 2 ? { ok: false, ret: '0xcfe73bb0' + '00'.repeat(64) } : { ok: true, ret: '0x' }));
  assert.equal(r.status, 'revert');
  assert.equal(r.data, '0xcfe73bb0' + '00'.repeat(64));
  assert.equal(r.calls.length, 2);
});

test('forwarder: empty input returns nothing; code is small and embeds the exchange address', () => {
  assert.equal(run(code, '0x', () => ({ ok: true, ret: '0x' })).calls.length, 0);
  assert.ok(code.length / 2 < 100);
  assert.ok(code.includes(X.slice(2).toLowerCase()));
});

test('packCalls prefixes each call with its length as a 32-byte word', () => {
  assert.equal(packCalls(['0xaabb', '0xcc']), '0x' + '00'.repeat(31) + '02aabb' + '00'.repeat(31) + '01cc');
});

test('AUSD overrides: slots equal the ones derived with ethers; balance is shifted by the flag byte', () => {
  const holder = '0x1111111111111111111111111111111111111111';
  const amount = 10n ** 9n;
  const o = ausdOverride(cfg.ausd, holder, X, amount)[cfg.ausd.address].stateDiff as Record<string, string>;
  const base = BigInt(cfg.ausd.balanceBase);
  const enc = (a: string, b: bigint) => ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [a, b]));
  const balSlot = enc(holder, base);
  const allowSlot = enc(X, BigInt(enc(holder, base + 1n)));
  assert.deepEqual(Object.keys(o).sort(), [balSlot, allowSlot].sort());
  assert.equal(BigInt(o[balSlot]), amount << 8n);
  assert.equal(BigInt(o[allowSlot]), amount);
  const full = simOverrides({ exchange: X, ausd: cfg.ausd, sender: holder, ausdAmount: amount, nativeWei: 5n });
  assert.equal(full[holder].balance, '0x5');
  assert.equal(full[holder].code, code);
});

test('simulate: names a revert from its selector and words; reports transport errors without a revert', async () => {
  const book = new ErrorBook(errors);
  const data = '0xcfe73bb0' + '00'.repeat(31) + '07' + '00'.repeat(29) + '98967f'.padStart(6, '0');
  const rpc = { call: async () => { throw new Error(`eth_call: ${JSON.stringify({ code: 3, message: 'execution reverted', data })}`); } };
  const r = await simulate(rpc as never, { sender: '0x' + '11'.repeat(20), exchange: X, calls: ['0x01'], overrides: {} }, book);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.revert.name, 'InsufficentAmountToOpenAccount');
    assert.equal(r.revert.words?.[0], 7n);
    assert.equal(r.revert.words?.[1], 0x98967fn);
  }
  const t = await simulate({ call: async () => { throw new Error('fetch failed'); } } as never, { sender: '0x' + '11'.repeat(20), exchange: X, calls: [], overrides: {} }, book);
  assert.equal(t.ok, false);
  if (!t.ok) assert.equal(t.revert.data, '0x');
  const ok = await simulate({ call: async () => '0x01' } as never, { sender: '0x' + '11'.repeat(20), exchange: X, calls: [], overrides: {} }, book);
  assert.deepEqual(ok, { ok: true, returnData: '0x01' });
});
