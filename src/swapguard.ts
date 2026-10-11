// The pure part of the USDC -> AUSD swap guard: constants and a decoder for the one Kuru Flow call this page accepts.
// Kept free of imports so src/plant.ts can use it without a cycle. Facts below were read from a live Flow quote and a
// simulation on 2026-10-11 (docs/FINDINGS.md, "Stage D, milestone 3, phase 1").

export const AUSD = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
export const AUSD_DECIMALS = 6;
// The router Kuru Flow's quote endpoint returns as `transaction.to`. It is NOT the router in config/kuru.mainnet.json
// (0xd651…, the order-book router): Flow has its own. A test pins this address and the config's address apart.
export const FLOW_ROUTER = '0xb3e6778480b2E488385E8205eA05E20060B813cb';
export const FLOW_SELECTOR = '0xce1e7030';
export const FLOW_API = 'https://ws.kuru.io';

const lc = (s: string): string => s.toLowerCase();

export type FlowSwapCall = {
  tokenOut: string;
  minOut: bigint;
  tokenIn: string;
  amountIn: bigint;
  head: string[]; // the remaining fixed words (word 4 onward), for display and tests
};

// Layout (verified on a real quote): word0 tokenOut, word1 minOut, word2 tokenIn, word3 amountIn, word4 a fixed
// contract address, then zero words, a flag and an opaque route blob. The user's address is NOT in the call: the router
// pays the output to msg.sender (checked by tracing a simulation, see src/swap.ts).
export function decodeFlowSwap(data: string): FlowSwapCall | null {
  if (lc(data.slice(0, 10)) !== FLOW_SELECTOR) return null;
  const hex = data.slice(10);
  if (hex.length < 64 * 9 || hex.length % 64 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const word = (i: number): bigint => BigInt('0x' + hex.slice(i * 64, (i + 1) * 64));
  const addr = (i: number): string | null => (word(i) >> 160n === 0n ? '0x' + hex.slice(i * 64 + 24, (i + 1) * 64) : null);
  const tokenOut = addr(0);
  const tokenIn = addr(2);
  if (!tokenOut || !tokenIn) return null;
  return { tokenOut, minOut: word(1), tokenIn, amountIn: word(3), head: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => hex.slice(i * 64, (i + 1) * 64)).slice(4) };
}

// Structural checks only; the economics (exact amount, minimum out, who receives the output) are checked by the swap
// module before the pop-up and after the receipt.
export function guardSwapData(tx: { to: string; data: string; value: string }, usdc: string, maxAmount: bigint): string | null {
  if (tx.value !== '0x0') return 'Refused: this page never sends MON along with a call.';
  if (lc(tx.to) !== lc(FLOW_ROUTER)) return 'Refused: swaps may only go to the Kuru Flow router.';
  const c = decodeFlowSwap(tx.data);
  if (!c) return 'Refused: the swap call is not the Kuru Flow swap this page knows.';
  if (lc(c.tokenIn) !== lc(usdc)) return 'Refused: only USDC can be sold.';
  if (lc(c.tokenOut) !== lc(AUSD)) return 'Refused: the swap must buy AUSD.';
  if (c.amountIn <= 0n || c.amountIn > maxAmount) return 'Refused: the swap amount must be above 0 and within the cap.';
  if (c.minOut <= 0n) return 'Refused: the swap has no minimum output.';
  return null;
}
