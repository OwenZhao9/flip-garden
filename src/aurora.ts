// Deposit from another chain into the signed-in Monad account with Aurora Intents (powered by NEAR Intents).
//
// The page signs NOTHING here. Aurora's Swap API answers a quote with a one-time deposit address on the other chain; the
// user sends USDC there from their own wallet on that chain (that wallet signs in its own pop-up), Aurora routes it, and
// USDC lands on the user's Monad address. So the transaction guard of this app is untouched: no new transaction kind is
// ever signed by the page. What the page does check, in code:
//   - the quote echoes back the amounts, assets and recipient it asked for (the recipient is the signed-in account),
//   - the minimum output is not far below the input (both sides are dollar stablecoins),
//   - the deposit address is a well-formed address and the deadline is near,
//   - and after Aurora says SUCCESS, the Monad USDC balance really rose by at least the quoted minimum.
// The API key is not a secret (Aurora's docs: safe in public pages); fees and analytics are tied to it in Aurora's portal.
import { CHAIN, LIMITS, USDC_DECIMALS, sameAddress } from './plant.ts';
import type { JsonRpc } from './rpc.ts';
import { formatUnits, parseUnits } from './units.ts';

export const AURORA_API = 'https://intents-api.aurora.dev';
export const AURORA_API_KEY = 'c49ba859-d12f-486c-949d-6d6f298ca859';
// USDC on Monad, as Aurora names it (checked against GET /api/tokens: contract 0x754704bc…b603, 6 decimals).
export const MONAD_USDC_ASSET = 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx';

export type Source = { id: string; name: string; asset: string };
// Native USDC on EVM chains, all 6 decimals (asset ids from GET /api/tokens, 2026-10-12).
export const SOURCES: Source[] = [
  { id: 'base', name: 'Base', asset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near' },
  { id: 'arbitrum', name: 'Arbitrum', asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near' },
  { id: 'ethereum', name: 'Ethereum', asset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near' },
  { id: 'optimism', name: 'Optimism', asset: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ' },
  { id: 'polygon', name: 'Polygon', asset: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L' },
];

export const MIN_DEPOSIT_USDC = 1_000_000n;
export const MAX_DEPOSIT_USDC = LIMITS.maxDepositUsdc; // the same 15 USDC cap as every other flow
export const SLIPPAGE_TOLERANCE = 100; // 1% in basis points, the value in Aurora's own examples
// Same sanity bound as the Kuru Flow swap: a quote that returns much less than the input is refused, not shown.
export const MIN_OUT_FLOOR_BPS = 9800n;
const MAX_DEADLINE_MS = 24 * 3600 * 1000;
const EVM = /^0x[0-9a-fA-F]{40}$/;

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok?: boolean; status?: number; json(): Promise<unknown> }>;

export function parseDepositAmount(text: string): { ok: true; amount: bigint } | { ok: false; message: string } {
  let amount: bigint;
  try {
    amount = parseUnits(text.trim(), USDC_DECIMALS);
  } catch {
    return { ok: false, message: 'Enter an amount like 5 or 5.25.' };
  }
  if (amount < MIN_DEPOSIT_USDC) return { ok: false, message: `The smallest deposit is ${formatUnits(MIN_DEPOSIT_USDC, USDC_DECIMALS)} USDC.` };
  if (amount > MAX_DEPOSIT_USDC) return { ok: false, message: `A deposit is capped at ${formatUnits(MAX_DEPOSIT_USDC, USDC_DECIMALS)} USDC.` };
  return { ok: true, amount };
}

export const isEvmAddress = (s: string): boolean => EVM.test(s.trim());

export type QuoteInput = { source: Source; amount: bigint; recipient: string; refundTo: string; dry: boolean; now?: () => number };

export function quoteBody(i: QuoteInput): Record<string, unknown> {
  const now = i.now?.() ?? Date.now();
  return {
    dry: i.dry,
    swapType: 'EXACT_INPUT',
    depositType: 'ORIGIN_CHAIN',
    originAsset: i.source.asset,
    destinationAsset: MONAD_USDC_ASSET,
    amount: i.amount.toString(),
    slippageTolerance: SLIPPAGE_TOLERANCE,
    refundTo: i.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: i.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(now + 6 * 3600 * 1000).toISOString(),
  };
}

export type DepositQuote = {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  timeEstimateSeconds: number | null;
  depositAddress: string | null; // null for a dry quote
  deadline: string | null;
};

const big = (v: unknown): bigint | null => (typeof v === 'string' && /^\d{1,30}$/.test(v) ? BigInt(v) : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Checks an Aurora quote answer against what was asked. Returns a plain message on any doubt, never a quote.
export function checkDepositQuote(answer: unknown, i: QuoteInput): { ok: true; quote: DepositQuote } | { ok: false; message: string } {
  const bad = (m: string): { ok: false; message: string } => ({ ok: false, message: m });
  if (!isObj(answer) || !isObj(answer.quote) || !isObj(answer.quoteRequest)) return bad('Aurora answered in a form this page does not recognise. Nothing was reserved.');
  const q = answer.quote;
  const req = answer.quoteRequest;
  if (req.recipient === undefined || typeof req.recipient !== 'string' || !sameAddress(req.recipient, i.recipient)) return bad('Aurora did not echo your Monad address as the recipient. Nothing was reserved.');
  if (req.destinationAsset !== MONAD_USDC_ASSET || req.originAsset !== i.source.asset) return bad('Aurora quoted different assets than requested. Nothing was reserved.');
  if (big(req.amount) !== i.amount) return bad('Aurora quoted a different amount than requested. Nothing was reserved.');
  if (typeof req.refundTo !== 'string' || !sameAddress(req.refundTo, i.refundTo)) return bad('Aurora did not echo your refund address. Nothing was reserved.');
  const amountIn = big(q.amountIn);
  const amountOut = big(q.amountOut);
  const minAmountOut = big(q.minAmountOut);
  if (amountIn !== i.amount || amountOut === null || minAmountOut === null) return bad('The quote has no usable amounts. Nothing was reserved.');
  if (minAmountOut * 10_000n < amountIn * MIN_OUT_FLOOR_BPS) return bad('The quote returns much less than you send, so the price looks off. Nothing was reserved.');
  if (amountOut < minAmountOut) return bad('The quote is inconsistent. Nothing was reserved.');
  let depositAddress: string | null = null;
  let deadline: string | null = null;
  if (!i.dry) {
    if (typeof q.depositAddress !== 'string' || !EVM.test(q.depositAddress)) return bad('Aurora did not return a usable deposit address. Nothing was sent.');
    depositAddress = q.depositAddress;
    if (typeof q.deadline !== 'string' || !Number.isFinite(Date.parse(q.deadline))) return bad('Aurora did not return a deadline. Nothing was sent.');
    const left = Date.parse(q.deadline) - (i.now?.() ?? Date.now());
    if (left <= 0 || left > MAX_DEADLINE_MS) return bad('The quote deadline is not sensible. Nothing was sent.');
    deadline = q.deadline;
  }
  const t = q.timeEstimate;
  return { ok: true, quote: { amountIn, amountOut, minAmountOut, timeEstimateSeconds: typeof t === 'number' && t >= 0 ? t : null, depositAddress, deadline } };
}

export async function fetchDepositQuote(f: FetchLike, i: QuoteInput): Promise<{ ok: true; quote: DepositQuote } | { ok: false; message: string }> {
  try {
    const res = await f(`${AURORA_API}/api/quote/${AURORA_API_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(quoteBody(i)) });
    const j = await res.json();
    if (res.ok === false) return { ok: false, message: isObj(j) && typeof j.message === 'string' ? `Aurora refused the quote: ${j.message.slice(0, 160)}` : 'Aurora refused the quote.' };
    return checkDepositQuote(j, i);
  } catch {
    return { ok: false, message: 'Aurora could not be reached. Nothing was reserved. Try again later.' };
  }
}

export type DepositStatus = { state: 'waiting' | 'processing' | 'success' | 'refunded' | 'failed'; raw: string | null };

export function parseStatus(answer: unknown): DepositStatus {
  const raw = isObj(answer) && typeof answer.status === 'string' ? answer.status : null;
  const s = (raw ?? '').toUpperCase();
  if (s === 'SUCCESS') return { state: 'success', raw };
  if (s === 'REFUNDED') return { state: 'refunded', raw };
  if (s === 'FAILED') return { state: 'failed', raw };
  if (s === 'PROCESSING' || s === 'KNOWN_DEPOSIT_TX' || s === 'INCOMPLETE_DEPOSIT') return { state: 'processing', raw };
  return { state: 'waiting', raw }; // PENDING_DEPOSIT, an unknown address right after the quote, or anything new: keep waiting
}

export async function fetchDepositStatus(f: FetchLike, depositAddress: string): Promise<DepositStatus> {
  try {
    const res = await f(`${AURORA_API}/api/status/${AURORA_API_KEY}?depositAddress=${encodeURIComponent(depositAddress)}`);
    if (res.ok === false) return { state: 'waiting', raw: null };
    return parseStatus(await res.json());
  } catch {
    return { state: 'waiting', raw: null };
  }
}

export async function readUsdc(rpc: JsonRpc, account: string): Promise<bigint> {
  return rpc.walletBalance(account, CHAIN.usdc);
}

// After Aurora says SUCCESS: did the Monad USDC balance really rise by at least the quoted minimum? (More is fine: the
// account may have received something else in the meantime; less is a problem to show, never to hide.)
export function verifyArrival(before: bigint, after: bigint, quote: DepositQuote): { ok: boolean; received: bigint; message: string } {
  const received = after - before;
  if (received >= quote.minAmountOut) return { ok: true, received, message: `Your Monad USDC balance rose by ${formatUnits(received, USDC_DECIMALS)} USDC (Aurora promised at least ${formatUnits(quote.minAmountOut, USDC_DECIMALS)}).` };
  return { ok: false, received, message: `Aurora reports success, but your Monad USDC balance rose by only ${formatUnits(received > 0n ? received : 0n, USDC_DECIMALS)} USDC (the promised minimum was ${formatUnits(quote.minAmountOut, USDC_DECIMALS)}). The balance may still be updating; check the explorer before doing anything else.` };
}
