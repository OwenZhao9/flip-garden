// Minimal ABI encoder / decoder for the handful of calls the planting flow sends, no dependencies.
// Signatures come from the Kuru SDK ABI files (@kuru-labs/kuru-sdk 0.0.95: abi/OrderBook.json,
// abi/MarginAccount.json, abi/IERC20.json). Tests compare every selector and every encoding with ethers
// (a root dependency used in tests only, never in the page bundle).
import { keccak256 } from './keccak.ts';

export const FUNCTIONS = {
  approve: { sig: 'approve(address,uint256)', types: ['address', 'uint256'] },
  deposit: { sig: 'deposit(address,address,uint256)', types: ['address', 'address', 'uint256'] },
  batchProvisionLiquidity: {
    sig: 'batchProvisionLiquidity(uint32[],uint32[],uint96[],bool[],bool)',
    types: ['uint32[]', 'uint32[]', 'uint96[]', 'bool[]', 'bool'],
  },
  batchCancelFlipOrders: { sig: 'batchCancelFlipOrders(uint40[])', types: ['uint40[]'] },
  batchWithdrawMaxTokens: { sig: 'batchWithdrawMaxTokens(address[])', types: ['address[]'] },
  // read-only calls
  balanceOf: { sig: 'balanceOf(address)', types: ['address'] },
  allowance: { sig: 'allowance(address,address)', types: ['address', 'address'] },
  getBalance: { sig: 'getBalance(address,address)', types: ['address', 'address'] },
  s_orders: { sig: 's_orders(uint40)', types: ['uint40'] },
  bestBidAsk: { sig: 'bestBidAsk()', types: [] },
  getMarketParams: { sig: 'getMarketParams()', types: [] },
  verifiedMarket: { sig: 'verifiedMarket(address)', types: ['address'] },
} as const;

export type FnName = keyof typeof FUNCTIONS;
export type Value = bigint | boolean | string | Value[];

export const selector = (sig: string): string => keccak256(sig).slice(0, 10);
export const SELECTORS: Record<FnName, string> = Object.fromEntries(
  Object.entries(FUNCTIONS).map(([k, f]) => [k, selector(f.sig)]),
) as Record<FnName, string>;

const word = (x: bigint): string => x.toString(16).padStart(64, '0');

function uintBits(t: string): number | null {
  const m = /^uint(\d+)$/.exec(t);
  return m ? Number(m[1]) : null;
}

function encodeStatic(t: string, v: Value): string {
  const bits = uintBits(t);
  if (bits !== null) {
    if (typeof v !== 'bigint') throw new Error(`${t}: expected a bigint`);
    if (v < 0n || v >> BigInt(bits) !== 0n) throw new Error(`${t}: value ${v} out of range`);
    return word(v);
  }
  if (t === 'bool') {
    if (typeof v !== 'boolean') throw new Error('bool: expected a boolean');
    return word(v ? 1n : 0n);
  }
  if (t === 'address') {
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`address: invalid value ${String(v)}`);
    return v.slice(2).toLowerCase().padStart(64, '0');
  }
  throw new Error(`unsupported type ${t}`);
}

export function encodeArgs(types: readonly string[], values: readonly Value[]): string {
  if (types.length !== values.length) throw new Error('argument count does not match the signature');
  const head: string[] = [];
  const tail: string[] = [];
  const headSize = types.length * 32;
  types.forEach((t, i) => {
    if (t.endsWith('[]')) {
      const el = t.slice(0, -2);
      const arr = values[i];
      if (!Array.isArray(arr)) throw new Error(`${t}: expected an array`);
      const body = word(BigInt(arr.length)) + arr.map((x) => encodeStatic(el, x)).join('');
      head.push(word(BigInt(headSize + tail.join('').length / 2)));
      tail.push(body);
    } else head.push(encodeStatic(t, values[i]));
  });
  return head.join('') + tail.join('');
}

export function encodeCall(name: FnName, values: readonly Value[]): string {
  const f = FUNCTIONS[name];
  return SELECTORS[name] + encodeArgs(f.types, values);
}

function decodeStatic(t: string, w: bigint): Value {
  const bits = uintBits(t);
  if (bits !== null) {
    if (w >> BigInt(bits) !== 0n) throw new Error(`${t}: value does not fit`);
    return w;
  }
  if (t === 'bool') {
    if (w > 1n) throw new Error('bool: bad word');
    return w === 1n;
  }
  if (t === 'address') {
    if (w >> 160n !== 0n) throw new Error('address: bad word');
    return '0x' + w.toString(16).padStart(40, '0');
  }
  throw new Error(`unsupported type ${t}`);
}

export function decodeArgs(types: readonly string[], dataHex: string): Value[] {
  const hex = dataHex.startsWith('0x') ? dataHex.slice(2) : dataHex;
  if (hex.length % 64 !== 0) throw new Error('call data is not a whole number of words');
  const w: bigint[] = [];
  for (let i = 0; i < hex.length; i += 64) w.push(BigInt('0x' + hex.slice(i, i + 64)));
  return types.map((t, i) => {
    if (w[i] === undefined) throw new Error('call data is too short');
    if (!t.endsWith('[]')) return decodeStatic(t, w[i]);
    const off = Number(w[i]) / 32;
    const len = Number(w[off]);
    if (!Number.isInteger(off) || w.length < off + 1 + len) throw new Error('array does not fit in the call data');
    return w.slice(off + 1, off + 1 + len).map((x) => decodeStatic(t.slice(0, -2), x));
  });
}

// Calldata -> { name, args } for the state-changing calls the flow knows; null for anything else.
export function decodeCall(data: string): { name: FnName; args: Value[] } | null {
  const sel = data.slice(0, 10).toLowerCase();
  const name = (Object.keys(FUNCTIONS) as FnName[]).find((k) => SELECTORS[k] === sel);
  if (!name) return null;
  return { name, args: decodeArgs(FUNCTIONS[name].types, data.slice(10)) };
}

// --- typed builders for the five transactions -------------------------------------------------

export const encodeApprove = (spender: string, amount: bigint): string => encodeCall('approve', [spender, amount]);
export const encodeDeposit = (user: string, token: string, amount: bigint): string => encodeCall('deposit', [user, token, amount]);
export const encodeCancelFlipOrders = (ids: bigint[]): string => {
  if (ids.length === 0) throw new Error('no order ids to cancel');
  return encodeCall('batchCancelFlipOrders', [ids]);
};
export const encodeWithdrawMax = (tokens: string[]): string => {
  if (tokens.length === 0) throw new Error('no tokens to withdraw');
  return encodeCall('batchWithdrawMaxTokens', [tokens]);
};
export type ProvisionBid = { price: bigint; flipPrice: bigint; size: bigint };
export function encodeProvision(bids: ProvisionBid[], provisionOrRevert: boolean): string {
  if (bids.length === 0) throw new Error('no orders to place');
  return encodeCall('batchProvisionLiquidity', [
    bids.map((b) => b.price),
    bids.map((b) => b.flipPrice),
    bids.map((b) => b.size),
    bids.map(() => true),
    provisionOrRevert,
  ]);
}

// --- revert reasons ----------------------------------------------------------------------------

// Custom errors of the Kuru OrderBook and MarginAccount contracts (names from the SDK ABI; none has arguments).
export const KURU_ERRORS = [
  'InsufficientLiquidity', 'InvalidSpread', 'LengthMismatch', 'MarketFeeError', 'MarketStateError', 'NativeAssetInsufficient',
  'NativeAssetNotRequired', 'NativeAssetTransferFail', 'OnlyOwnerAllowedError', 'OnlyVaultAllowed', 'OrderAlreadyFilledOrCancelled',
  'PostOnlyError', 'PriceError', 'ProvisionError', 'SizeError', 'SlippageExceeded', 'TickSizeError', 'TooMuchSizeFilled',
  'Unauthorized', 'UnauthorizedCallContext', 'WrongOrderTypeCancel', 'InsufficientBalance', 'NativeAssetMismatch',
  'OnlyRouterAllowed', 'OnlyVerifiedMarketsAllowed', 'ProtocolPaused', 'ZeroAddressNotAllowed',
] as const;
const ERROR_BY_SELECTOR = new Map<string, string>(KURU_ERRORS.map((n) => [selector(`${n}()`), n]));

// Finds a known 4-byte error selector (or an Error(string) message) anywhere in an RPC error.
export function revertReason(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
  for (const m of text.matchAll(/0x[0-9a-fA-F]{8,}/g)) {
    const data = m[0].toLowerCase();
    const known = ERROR_BY_SELECTOR.get(data.slice(0, 10));
    if (known) return known;
    if (data.startsWith('0x08c379a0')) {
      try {
        const [off] = decodeArgs(['uint256'], data.slice(10, 74));
        const start = 10 + Number(off) * 2;
        const len = Number(BigInt('0x' + data.slice(start, start + 64)));
        const bytes = data.slice(start + 64, start + 64 + len * 2).match(/.{2}/g) ?? [];
        return new TextDecoder().decode(Uint8Array.from(bytes.map((b) => parseInt(b, 16))));
      } catch {
        // fall through
      }
    }
  }
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}
