// Demo entry only (web/demo.html): the real app with a stub passkey and a simulated Monad chain, Kuru market and Perpl
// exchange living in this tab. Everything the pages do (sign in, plant, hedge, the Gardener) runs the real page code;
// only the network and the passkey prompt are replaced. Nothing here touches a real network, key or money.
import { parseTransaction } from 'viem';
import { FakeChain } from '../../test/helpers/fakechain.ts';
import { FakePerplChain } from '../../test/helpers/fakeperpl.ts';
import { CHAIN } from '../../src/plant.ts';
import { PERPL } from '../../src/perpl/guard.ts';
import { AUSD, FLOW_ROUTER } from '../../src/swapguard.ts';
import { AURORA_API } from '../../src/aurora.ts';
import quoteFixture from '../../test/fixtures/flow-quote-usdc-ausd.json';
import { BOARD_URL } from './leaderboard.ts';
import { configureMera, mera } from './session.ts';

const lc = (s: string): string => s.toLowerCase();
const ZERO_USER = '0x0000000000000000000000000000000000000001';

export const kuru = new FakeChain(ZERO_USER);
export const perpl = new FakePerplChain(ZERO_USER);
kuru.block = perpl.s.block = 112_471_000;
kuru.walletMon = 450n * 10n ** 18n;
kuru.walletUsdc = 20_000_000n;
perpl.s.walletAusd = 12_000_000n;
perpl.s.kuruMon = 219n * 10n ** 18n; // the MON that flip orders left at Kuru, the thing the hedge offsets
perpl.s.txCount = 1000; // keeps the two fake chains' transaction hashes apart
// one wallet: both fake chains read and write the same MON balance
Object.defineProperty(perpl.s, 'walletMon', { get: () => kuru.walletMon, set: (v: bigint) => { kuru.walletMon = v; } });
(window as unknown as { __demo: unknown }).__demo = { kuru, perpl };


const syncUser = (): void => {
  const a = mera().address;
  if (a) { (kuru as { user: string }).user = lc(a); (perpl as { user: string }).user = lc(a); }
};
window.addEventListener('mera-change', syncUser);

const isPerpl = (to: string | undefined): boolean => !!to && (lc(to) === lc(PERPL.exchange) || lc(to) === lc(PERPL.ausd));
const isFlow = (to: string | undefined): boolean => !!to && lc(to) === lc(FLOW_ROUTER);
let nonce = 0;
const answer = (id: unknown, result: unknown): { json(): Promise<unknown> } => ({ json: async () => ({ jsonrpc: '2.0', id, result }) });
const http = (status: number, body: unknown): unknown => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const realFetch: typeof fetch = window.fetch.bind(window);

// Transaction hashes on the simulated chains are counters; show random-looking ones, as a real chain would.
const alias = new Map<string, string>(); // shown -> internal
const unalias = (h: string): string => alias.get(h) ?? h;
const shown = (internal: string): string => {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  const s = '0x' + [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  alias.set(s, internal);
  return s;
};
const w = (x: bigint): string => x.toString(16).padStart(64, '0');
const pad = (a: string): string => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const flowReceipts = new Map<string, unknown>();
let flowTx = 0;
const amountOf = (data: string): bigint => BigInt('0x' + data.slice(10 + 3 * 64, 10 + 4 * 64));
const minOutOf = (data: string): bigint => BigInt('0x' + data.slice(10 + 64, 10 + 2 * 64));
const quoteFor = (amount: bigint): unknown => {
  const c = structuredClone(quoteFixture) as { output: string; minOut: string; transaction: { calldata: string } };
  const words = c.transaction.calldata.slice(8).match(/.{64}/g)!;
  words[1] = w((amount * 998n) / 1000n);
  words[3] = w(amount);
  c.transaction.calldata = c.transaction.calldata.slice(0, 8) + words.join('');
  c.output = String((amount * 999n) / 1000n);
  c.minOut = String((amount * 998n) / 1000n);
  return c;
};

// Aurora: a quote is echoed back with a deposit address; the "deposit" is seen a few seconds after the address is reserved.
const deposits = new Map<string, { at: number; amountOut: bigint; credited: boolean }>();
function aurora(u: string, init: { body?: string } | undefined): unknown {
  if (u.includes('/api/quote/')) {
    const req = JSON.parse(init!.body!);
    const amount = BigInt(req.amount);
    const out = (amount * 9985n) / 10000n;
    const addr = '0x' + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!req.dry) deposits.set(addr.toLowerCase(), { at: Date.now(), amountOut: out, credited: false });
    return http(200, { quoteRequest: req, quote: { amountIn: String(amount), amountOut: String(out), minAmountOut: String((amount * 9900n) / 10000n), timeEstimate: 40, depositAddress: req.dry ? undefined : addr, deadline: new Date(Date.now() + 30 * 60_000).toISOString() } });
  }
  const addr = decodeURIComponent(u.split('depositAddress=')[1] ?? '').toLowerCase();
  const d = deposits.get(addr);
  if (!d) return http(200, { status: 'PENDING_DEPOSIT' });
  const age = Date.now() - d.at;
  if (age < 9_000) return http(200, { status: 'PENDING_DEPOSIT' });
  if (age < 16_000) return http(200, { status: 'PROCESSING' });
  if (!d.credited) { d.credited = true; kuru.walletUsdc += d.amountOut; }
  return http(200, { status: 'SUCCESS' });
}

// The leaderboard Worker: the real board's rows plus this demo garden; everything else about it is the real service.
let roundTrips = 0;
let registered: { address: string; startBlock: number } | null = null;
async function board(u: string, init: { method?: string; body?: string } | undefined): Promise<unknown> {
  const path = new URL(u).pathname;
  if (path === '/register') { registered = JSON.parse(init!.body!); return http(201, { ok: true }); }
  if (path === '/leaderboard') {
    let rows: { rank: number; address: string; completedRoundTrips: number; gardenAgeDays: number | null; level: string; updatedAt: string }[] = [];
    let updatedAt: string | null = null;
    try { const r = (await (await realFetch(u)).json()) as { rows: typeof rows; updatedAt: string }; rows = r.rows; updatedAt = r.updatedAt; } catch { /* offline: the demo garden alone */ }
    if (registered) rows.push({ rank: 0, address: `${registered.address.slice(0, 6).toLowerCase()}…${registered.address.slice(-4).toLowerCase()}`, completedRoundTrips: roundTrips, gardenAgeDays: 0, level: roundTrips > 0 ? 'Sprout' : 'Seed', updatedAt: new Date().toISOString() });
    rows.sort((a, b) => b.completedRoundTrips - a.completedRoundTrips);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return http(200, { updatedAt: updatedAt ?? new Date().toISOString(), rows });
  }
  if (path.startsWith('/garden/')) {
    const a = path.slice('/garden/'.length);
    if (registered && registered.address.toLowerCase() === a) return http(200, { address: a, catchingUp: false, scannedTo: kuru.block, figures: { completedRoundTrips: roundTrips, gardenAgeDays: 0, level: roundTrips > 0 ? 'Sprout' : 'Seed', updatedAt: new Date().toISOString() } });
    return http(404, { error: 'not registered' });
  }
  return http(404, { error: 'not available in demo mode' });
}

const rpcUrl = CHAIN.rpcUrl;
async function rpcCall(init: { body?: string }): Promise<{ json(): Promise<unknown> }> {
  syncUser();
  const u = rpcUrl;
  const req = JSON.parse(init.body!);
  const { id, method } = req;
  const params = req.params as unknown[];
  const tx = ((params?.[0]) ?? {}) as { to?: string; data?: string };
  switch (method) {
    case 'eth_getTransactionCount': return answer(id, '0x' + nonce.toString(16));
    case 'eth_sendRawTransaction': {
      const t = parseTransaction(params[0] as `0x${string}`);
      nonce++;
      const from = mera().address!;
      const to = t.to as string;
      const data = (t.data ?? '0x') as string;
      const gas = t.gas ? '0x' + t.gas.toString(16) : undefined;
      if (isFlow(to)) {
        const amount = amountOf(data);
        kuru.walletUsdc -= amount;
        kuru.allowance -= amount;
        perpl.s.walletAusd += (amount * 999n) / 1000n;
        kuru.walletMon -= 200_000n * 100n * 10n ** 9n;
        kuru.block += 1;
        const internal = '0x' + w(BigInt(++flowTx + 2000));
        flowReceipts.set(internal, { status: '0x1', blockNumber: '0x' + kuru.block.toString(16), gasUsed: '0x30d40', effectiveGasPrice: '0x174876e800', from, logs: [] });
        return answer(id, shown(internal));
      }
      const chain = isPerpl(to) ? perpl : kuru;
      return answer(id, shown(chain.mine({ from, to, data, gas })));
    }
    case 'eth_estimateGas':
      if (isFlow(tx.to)) return answer(id, '0x30d40');
      return (isPerpl(tx.to) ? perpl : kuru).fetch(u, { body: init.body! });
    case 'eth_call':
      if (isFlow(tx.to)) return answer(id, '0x');
      return (isPerpl(tx.to) ? perpl : kuru).fetch(u, { body: init.body! });
    case 'debug_traceCall': {
      if (isFlow(tx.to)) {
        const c = tx as { from?: string; data: string };
        const user = (c as { from: string }).from;
        const amount = amountOf(c.data);
        return answer(id, { type: 'CALL', calls: [{ type: 'CALL', logs: [
          { address: CHAIN.usdc.toLowerCase(), topics: [TRANSFER, pad(user), pad(FLOW_ROUTER)], data: '0x' + w(amount) },
          { address: AUSD.toLowerCase(), topics: [TRANSFER, pad(FLOW_ROUTER), pad(user)], data: '0x' + w((amount * 999n) / 1000n) },
        ] }] });
      }
      return perpl.fetch(u, { body: init.body! });
    }
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash': {
      const internal = unalias(params[0] as string);
      const body = JSON.stringify({ ...req, params: [internal] });
      if (flowReceipts.has(internal)) return answer(id, method === 'eth_getTransactionReceipt' ? flowReceipts.get(internal) : { hash: internal, from: mera().address, to: FLOW_ROUTER });
      const r = await kuru.fetch(u, { body });
      const j = (await r.json()) as { result: unknown };
      return j.result || method === 'eth_getTransactionByHash' ? { json: async () => j } : perpl.fetch(u, { body });
    }
    default: return kuru.fetch(u, { body: init.body! });
  }
}

export const demoFetch = (async (input: RequestInfo | URL, init?: { body?: string; method?: string; headers?: Record<string, string> }) => {
  const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (u === rpcUrl) return rpcCall(init as { body: string });
  if (u.startsWith('https://ws.kuru.io')) {
    if (u.endsWith('/api/generate-token')) return http(200, { token: 'demo-token', expires_at: 0 });
    if (u.endsWith('/api/quote')) return http(200, quoteFor(BigInt(JSON.parse(init!.body!).amount)));
  }
  if (u.startsWith(AURORA_API)) return aurora(u, init);
  if (u.startsWith(BOARD_URL)) {
    const p = new URL(u).pathname;
    if (p.startsWith('/history/')) return http(404, { error: 'no history for the demo chain' });
    if (p === '/decide') return realFetch(input as RequestInfo, init as RequestInit); // the real Jev, through the real Worker
    return board(u, init);
  }
  return realFetch(input as RequestInfo, init as RequestInit);
}) as unknown as typeof fetch;
window.fetch = demoFetch;

const PRF = (): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
configureMera({ fetch: demoFetch, ceremony: { create: async () => PRF(), signIn: async () => PRF() } });

// A market that trades against the garden: a taker fills the bids a while after they are planted, and the flipped
// sells a while after that, so the garden grows through its stages while the page is open.
const seen = new Map<bigint, number>();
setInterval(() => {
  kuru.block += 1;
  const now = Date.now();
  for (const [oid, o] of kuru.orders) {
    if (o.size === 0n || lc(o.owner) !== kuru.user) continue;
    if (!seen.has(oid)) seen.set(oid, now);
    const wait = o.isBuy ? 14_000 : 22_000;
    if (now - (seen.get(oid) ?? now) > wait && !(window as unknown as { __demoPause?: boolean }).__demoPause) { { if (!o.isBuy) roundTrips++; kuru.fillOrder(oid); } break; }
  }
}, 1000);


const memory = new Map<string, string>(); // the demo keeps its notes in memory, so it never touches what the live app saved
(window as unknown as { __demoDeps: unknown }).__demoDeps = {
  plant: { fetchImpl: demoFetch, fake: true, store: { get: (k: string) => memory.get(k) ?? null, set: (k: string, v: string) => void memory.set(k, v) } },
  hedge: { fetchImpl: demoFetch, fake: true },
  deposit: { fetchImpl: demoFetch, pollMs: 2000 },
  passkey: { fetchImpl: demoFetch },
};

// Hide the sentence that only makes sense for real money: this entry runs on simulated data.
new MutationObserver(() => document.querySelectorAll('.note, .callout, p').forEach((e) => { if (/^Real money:/.test(e.textContent?.trim() ?? '') && e.children.length < 3) (e as HTMLElement).style.display = 'none'; })).observe(document.body, { childList: true, subtree: true });
document.head.insertAdjacentHTML('beforeend', '<style>.fakebanner{display:none!important}</style>');
