// Read-only simulation of a sequence of exchange calls from a throwaway address, using eth_call
// state overrides. Nothing is signed or sent; no key is involved.
//
// Why a wrapper contract: every exchange call acts on msg.sender's account, and a fresh address
// has no account. To test "create the account, then place an order" in one simulation we put a
// tiny piece of bytecode on the throwaway address (state override `code`). It forwards a list of
// calls to the exchange in order, so the exchange sees the throwaway address as msg.sender for all
// of them, and bubbles up the first revert. The same override gives that address a native balance
// and AUSD (balance and allowance), which is how scripts/gate.cjs fakes funds for Kuru.
import { keccak256 } from '../keccak.ts';
import { addressWord, selector, splitWords, uintWord, wordToUint } from './abi.ts';
import { decodePerplLog, type PerplEvent, type RawLog } from './events.ts';

export interface RpcLike {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

type Overrides = Record<string, { balance?: string; code?: string; stateDiff?: Record<string, string> }>;

// ---- the forwarding bytecode ----
// Calldata: repeated records [32-byte length L][L bytes of call data]. For each record it calls
// `target` with that data and no value; on failure it reverts with the callee's revert data; at the end
// it returns the last call's return data. Hand-assembled; test/perpl-sim.test.ts runs it against a
// small reference interpreter of the same instructions so a typo cannot hide.
const OP = { ADD: 0x01, GT: 0x11, ISZERO: 0x15, CALLDATALOAD: 0x35, CALLDATASIZE: 0x36, CALLDATACOPY: 0x37, RETURNDATASIZE: 0x3d, RETURNDATACOPY: 0x3e, GAS: 0x5a, JUMP: 0x56, JUMPI: 0x57, JUMPDEST: 0x5b, CALL: 0xf1, RETURN: 0xf3, REVERT: 0xfd, DUP1: 0x80, DUP2: 0x81, DUP4: 0x83, SWAP1: 0x90 };
type Item = number | number[] | string; // string: ':label' defines a jump target, '@label' pushes its address (PUSH2)

export function assemble(items: Item[]): number[] {
  const out: number[] = [];
  const labels: Record<string, number> = {};
  const fix: Array<[number, string]> = [];
  for (const it of items) {
    if (typeof it === 'string' && it.startsWith(':')) {
      labels[it.slice(1)] = out.length;
      out.push(OP.JUMPDEST);
    } else if (typeof it === 'string' && it.startsWith('@')) {
      out.push(0x61, 0, 0);
      fix.push([out.length - 2, it.slice(1)]);
    } else if (Array.isArray(it)) out.push(...it);
    else if (typeof it === 'number') out.push(it);
    else throw new Error(`bad item ${String(it)}`);
  }
  for (const [pos, l] of fix) {
    if (labels[l] === undefined) throw new Error(`unknown label ${l}`);
    out[pos] = labels[l] >> 8;
    out[pos + 1] = labels[l] & 255;
  }
  return out;
}

const P1 = (n: number): number[] => [0x60, n];

export function forwarderProgram(target: string): Item[] {
  const t = Array.from(addressWord(target).slice(24).match(/../g) as string[], (b) => parseInt(b, 16));
  return [
    P1(0), // [i]
    ':loop',
    OP.DUP1, OP.CALLDATASIZE, OP.GT, OP.ISZERO, '@done', OP.JUMPI, // leave when i >= calldatasize
    OP.DUP1, OP.CALLDATALOAD, OP.SWAP1, P1(32), OP.ADD, // [L, i+32]
    OP.DUP2, OP.DUP2, P1(0), OP.CALLDATACOPY, // memory[0..L) = calldata[i+32..)
    P1(0), P1(0), OP.DUP4, P1(0), P1(0), [0x73, ...t], OP.GAS, OP.CALL, // [L, i+32, success]
    '@ok', OP.JUMPI,
    OP.RETURNDATASIZE, P1(0), P1(0), OP.RETURNDATACOPY, OP.RETURNDATASIZE, P1(0), OP.REVERT,
    ':ok', OP.ADD, '@loop', OP.JUMP, // i = i + 32 + L
    ':done',
    OP.RETURNDATASIZE, P1(0), P1(0), OP.RETURNDATACOPY, OP.RETURNDATASIZE, P1(0), OP.RETURN,
  ];
}

export const forwarderCode = (target: string): string =>
  '0x' + assemble(forwarderProgram(target)).map((b) => b.toString(16).padStart(2, '0')).join('');

export function packCalls(calls: string[]): string {
  return '0x' + calls.map((c) => {
    const d = c.replace(/^0x/, '');
    return uintWord(d.length / 2) + d;
  }).join('');
}

// ---- AUSD balance and allowance overrides ----
export type AusdStorage = { address: string; balanceBase: string; balanceShiftBits: number };

const hexKey = (w: string): string => '0x' + w;
const slotKey = (a: string, base: bigint): string => hexKey(keccak256(hexBytes(addressWord(a) + uintWord(base))).slice(2));
function hexBytes(h: string): Uint8Array {
  return Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
}

export function ausdOverride(s: AusdStorage, holder: string, spender: string, amount: bigint): Overrides {
  const base = BigInt(s.balanceBase);
  const allowanceInner = BigInt(slotKey(holder, base + 1n));
  const allowanceKey = hexKey(keccak256(hexBytes(addressWord(spender) + uintWord(allowanceInner))).slice(2));
  return {
    [s.address]: {
      stateDiff: {
        [slotKey(holder, base)]: hexKey(uintWord(amount << BigInt(s.balanceShiftBits))),
        [allowanceKey]: hexKey(uintWord(amount)),
      },
    },
  };
}

export function simOverrides(o: { exchange: string; ausd: AusdStorage; sender: string; ausdAmount: bigint; nativeWei: bigint }): Overrides {
  return {
    ...ausdOverride(o.ausd, o.sender, o.exchange, o.ausdAmount),
    [o.sender]: { balance: '0x' + o.nativeWei.toString(16), code: forwarderCode(o.exchange) },
  };
}

// ---- running a simulation ----
export type RevertInfo = { data: string; name?: string; words?: bigint[] };
export type SimResult = { ok: true; returnData: string } | { ok: false; revert: RevertInfo; message?: string };

export class ErrorBook {
  private bySel = new Map<string, string>();
  constructor(signatures: string[]) {
    for (const s of signatures) this.bySel.set(selector(s), s);
  }
  name(data: string): { name?: string; words?: bigint[] } {
    const sig = this.bySel.get(data.slice(0, 10));
    if (!sig) return {};
    const words = data.length >= 10 + 64 && (data.length - 10) % 64 === 0 ? splitWords(data.slice(10)).map(wordToUint) : undefined;
    return { name: sig.slice(0, sig.indexOf('(')), words };
  }
}

function revertDataOf(err: unknown): string | undefined {
  const e = err as { message?: string };
  // The adapter in rpc.ts throws `${method}: ${JSON.stringify(error)}`; the node's error carries the data field.
  const m = /"data":"(0x[0-9a-fA-F]*)"/.exec(e.message ?? '');
  return m?.[1];
}

export async function simulate(
  rpc: RpcLike,
  o: { sender: string; exchange: string; calls: string[]; overrides: Overrides; block?: string },
  errors: ErrorBook,
): Promise<SimResult> {
  const tx = { from: o.sender, to: o.sender, data: packCalls(o.calls) };
  try {
    const r = await rpc.call<string>('eth_call', [tx, o.block ?? 'latest', o.overrides]);
    return { ok: true, returnData: r };
  } catch (e) {
    const data = revertDataOf(e);
    if (data === undefined) return { ok: false, revert: { data: '0x' }, message: String((e as Error).message).slice(0, 300) };
    return { ok: false, revert: { data, ...errors.name(data) } };
  }
}

// Events a simulated sequence would emit and the gas each forwarded call used (eth_call returns no
// logs, so this uses debug_traceCall with the call tracer, which the public Monad RPC supports). The
// gas figures are what the EVM executed; Monad bills the gas limit instead (docs/FINDINGS.md).
export async function simulateTrace(
  rpc: RpcLike,
  o: { sender: string; calls: string[]; overrides: Overrides; block?: string },
): Promise<{ events: PerplEvent[]; gasUsed: bigint[] }> {
  const tx = { from: o.sender, to: o.sender, data: packCalls(o.calls) };
  type Frame = { gasUsed?: string; logs?: Array<{ address: string; topics: string[]; data: string }>; calls?: Frame[] };
  const trace = await rpc.call<Frame>('debug_traceCall', [tx, o.block ?? 'latest', { tracer: 'callTracer', tracerConfig: { withLog: true }, stateOverrides: o.overrides }]);
  const out: PerplEvent[] = [];
  const walk = (f: Frame): void => {
    for (const l of f.logs ?? []) {
      const ev = decodePerplLog({ ...l, blockNumber: '0x0', transactionHash: '0x', logIndex: '0x' + out.length.toString(16) } as RawLog);
      if (ev) out.push(ev);
    }
    (f.calls ?? []).forEach(walk);
  };
  walk(trace);
  return { events: out, gasUsed: (trace.calls ?? []).map((c) => BigInt(c.gasUsed ?? '0x0')) };
}
