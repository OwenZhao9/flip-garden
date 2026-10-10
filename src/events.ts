// Kuru event decoding without ethers. Signatures copied from the SDK ABI (@kuru-labs/kuru-sdk
// 0.0.95, abi/OrderBook.json and abi/MarginAccount.json). None of these parameters is indexed,
// so everything is in `data`; topic0 is keccak256 of the signature (checked against ethers in tests).
import { keccak256 } from './keccak.ts';

export const SIGNATURES = {
  Trade: 'Trade(uint40,address,bool,uint256,uint96,address,address,uint96)',
  FlipOrderCreated: 'FlipOrderCreated(uint40,uint40,address,uint96,uint32,uint32,bool)',
  FlippedOrderCreated: 'FlippedOrderCreated(uint40,uint40,address,uint96,uint32,uint32,bool)',
  FlipOrderUpdated: 'FlipOrderUpdated(uint40,uint96)',
  FlipOrdersCanceled: 'FlipOrdersCanceled(uint40[],address)',
  Deposit: 'Deposit(address,address,uint256)',
  Withdrawal: 'Withdrawal(address,address,uint256)',
} as const;

export type EventName = keyof typeof SIGNATURES;

export const TOPICS: Record<EventName, string> = Object.fromEntries(
  Object.entries(SIGNATURES).map(([k, sig]) => [k, keccak256(sig)]),
) as Record<EventName, string>;

const BY_TOPIC = new Map<string, EventName>(Object.entries(TOPICS).map(([k, t]) => [t, k as EventName]));

// Topics an order-book scan asks for, and topics a MarginAccount scan asks for.
export const MARKET_TOPICS = [
  TOPICS.Trade,
  TOPICS.FlipOrderCreated,
  TOPICS.FlippedOrderCreated,
  TOPICS.FlipOrderUpdated,
  TOPICS.FlipOrdersCanceled,
];
export const MARGIN_TOPICS = [TOPICS.Deposit, TOPICS.Withdrawal];

export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | number;
  transactionHash: string;
  logIndex: string | number;
  removed?: boolean;
};

type Pos = { block: number; logIndex: number; tx: string; address: string };

export type TradeEvent = Pos & {
  name: 'Trade';
  orderId: bigint;
  maker: string;
  isBuy: boolean; // the TAKER's direction (verified 2026-10-10), not the resting order's
  price1e18: bigint;
  updatedSize: bigint; // resting order's remaining size after this fill
  taker: string;
  txOrigin: string;
  filledSize: bigint;
};

export type FlipCreatedEvent = Pos & {
  name: 'FlipOrderCreated' | 'FlippedOrderCreated';
  orderId: bigint;
  flippedId: bigint; // observed 0 in both events; the link is inferred (see ledger.ts)
  owner: string;
  size: bigint;
  price: bigint;
  flippedPrice: bigint;
  isBuy: boolean;
};

export type FlipUpdatedEvent = Pos & { name: 'FlipOrderUpdated'; orderId: bigint; size: bigint };
export type FlipCanceledEvent = Pos & { name: 'FlipOrdersCanceled'; orderIds: bigint[]; owner: string };
export type MarginEvent = Pos & { name: 'Deposit' | 'Withdrawal'; owner: string; token: string; amount: bigint };

export type KuruEvent = TradeEvent | FlipCreatedEvent | FlipUpdatedEvent | FlipCanceledEvent | MarginEvent;

const num = (x: string | number): number => (typeof x === 'number' ? x : Number(BigInt(x)));

function words(data: string): bigint[] {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  if (hex.length % 64 !== 0) throw new Error('log data is not a whole number of 32-byte words');
  const out: bigint[] = [];
  for (let i = 0; i < hex.length; i += 64) out.push(BigInt('0x' + hex.slice(i, i + 64)));
  return out;
}

function uint(w: bigint, bits: number): bigint {
  if (w >> BigInt(bits) !== 0n) throw new Error(`value does not fit uint${bits}`);
  return w;
}
function address(w: bigint): string {
  if (w >> 160n !== 0n) throw new Error('bad address word');
  return '0x' + w.toString(16).padStart(40, '0');
}
function bool(w: bigint): boolean {
  if (w > 1n) throw new Error('bad bool word');
  return w === 1n;
}

// Returns null for logs that are not one of our events.
export function decodeLog(log: RawLog): KuruEvent | null {
  const name = BY_TOPIC.get(String(log.topics[0]).toLowerCase());
  if (!name) return null;
  if (log.topics.length !== 1) throw new Error(`${name}: unexpected indexed topics`);
  const pos: Pos = {
    block: num(log.blockNumber),
    logIndex: num(log.logIndex),
    tx: log.transactionHash.toLowerCase(),
    address: log.address.toLowerCase(),
  };
  const w = words(log.data);
  const need = (n: number): void => {
    if (w.length < n) throw new Error(`${name}: expected ${n} words, got ${w.length}`);
  };
  switch (name) {
    case 'Trade':
      need(8);
      return {
        ...pos,
        name,
        orderId: uint(w[0], 40),
        maker: address(w[1]),
        isBuy: bool(w[2]),
        price1e18: w[3],
        updatedSize: uint(w[4], 96),
        taker: address(w[5]),
        txOrigin: address(w[6]),
        filledSize: uint(w[7], 96),
      };
    case 'FlipOrderCreated':
    case 'FlippedOrderCreated':
      need(7);
      return {
        ...pos,
        name,
        orderId: uint(w[0], 40),
        flippedId: uint(w[1], 40),
        owner: address(w[2]),
        size: uint(w[3], 96),
        price: uint(w[4], 32),
        flippedPrice: uint(w[5], 32),
        isBuy: bool(w[6]),
      };
    case 'FlipOrderUpdated':
      need(2);
      return { ...pos, name, orderId: uint(w[0], 40), size: uint(w[1], 96) };
    case 'FlipOrdersCanceled': {
      need(2);
      const off = Number(w[0]) / 32;
      const len = Number(w[off]);
      need(off + 1 + len);
      const orderIds = w.slice(off + 1, off + 1 + len).map((x) => uint(x, 40));
      return { ...pos, name, orderIds, owner: address(w[1]) };
    }
    case 'Deposit':
    case 'Withdrawal':
      need(3);
      return { ...pos, name, owner: address(w[0]), token: address(w[1]), amount: w[2] };
  }
}

// Old JSON shape used by scripts/gate.cjs and the gate-test fixture -> typed event.
export function fromGateJson(e: {
  name: string;
  block: number;
  tx: string;
  logIndex: number;
  address?: string;
  args: Record<string, unknown>;
}): KuruEvent {
  const a = e.args;
  const B = (k: string): bigint => BigInt(String(a[k]));
  const L = (k: string): string => String(a[k]).toLowerCase();
  const T = (k: string): boolean => a[k] === true || a[k] === 'true';
  const pos: Pos = { block: e.block, logIndex: e.logIndex, tx: e.tx.toLowerCase(), address: (e.address ?? '').toLowerCase() };
  switch (e.name) {
    case 'Trade':
      return {
        ...pos,
        name: 'Trade',
        orderId: B('orderId'),
        maker: L('makerAddress'),
        isBuy: T('isBuy'),
        price1e18: B('price'),
        updatedSize: B('updatedSize'),
        taker: L('takerAddress'),
        txOrigin: L('txOrigin'),
        filledSize: B('filledSize'),
      };
    case 'FlipOrderCreated':
    case 'FlippedOrderCreated':
      return {
        ...pos,
        name: e.name,
        orderId: B('orderId'),
        flippedId: B('flippedId'),
        owner: L('owner'),
        size: B('size'),
        price: B('price'),
        flippedPrice: B('flippedPrice'),
        isBuy: T('isBuy'),
      };
    case 'FlipOrderUpdated':
      return { ...pos, name: 'FlipOrderUpdated', orderId: B('orderId'), size: B('size') };
    case 'FlipOrdersCanceled':
      return { ...pos, name: 'FlipOrdersCanceled', orderIds: (a.orderIds as unknown[]).map((x) => BigInt(String(x))), owner: L('owner') };
    case 'Deposit':
    case 'Withdrawal':
      return { ...pos, name: e.name, owner: L('owner'), token: L('token'), amount: B('amount') };
    default:
      throw new Error(`unknown event ${e.name}`);
  }
}
