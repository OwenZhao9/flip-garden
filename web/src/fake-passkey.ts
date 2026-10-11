// Test page only (web/passkey-fake.html): the Passkey page against a stub passkey, a fake Monad chain and a fake Kuru
// Flow, all living in this tab. No real passkey, key, network or money is involved.
import { parseTransaction } from 'viem';
import quoteFixture from '../../test/fixtures/flow-quote-usdc-ausd.json';
import { CHAIN } from '../../src/plant.ts';
import { AUSD, FLOW_ROUTER } from '../../src/swapguard.ts';
import { configureMera, renderLockBar } from './session.ts';
import { mountPasskey } from './passkey.ts';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const w = (x: bigint): string => x.toString(16).padStart(64, '0');
const pad = (a: string): string => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const q = new URLSearchParams(location.search);
const scenario = q.get('scenario') ?? '';

const state = { mon: 5n * 10n ** 18n, usdc: 20_000_000n, ausd: 0n, allowance: 0n, nonce: 0, block: 112_400_000, quoteCalls: 0, sent: [] as string[], receipts: new Map<string, unknown>() };
if (scenario === 'poor') state.usdc = 1_000_000n;
if (scenario === 'nogas') state.mon = 100_000_000_000_000_000n;
(window as unknown as { __fake: unknown }).__fake = state;

const ok = (id: unknown, result: unknown): { json(): Promise<unknown> } => ({ json: async () => ({ jsonrpc: '2.0', id, result }) });
const err = (id: unknown, message: string): { json(): Promise<unknown> } => ({ json: async () => ({ jsonrpc: '2.0', id, error: { code: 3, message } }) });

function quoteFor(amount: bigint): unknown {
  const c = structuredClone(quoteFixture) as { output: string; minOut: string; transaction: { calldata: string } };
  const words = c.transaction.calldata.slice(8).match(/.{64}/g)!;
  const output = (amount * 999n) / 1000n, minOut = (amount * 998n) / 1000n;
  words[1] = w(minOut);
  words[3] = w(amount);
  c.transaction.calldata = c.transaction.calldata.slice(0, 8) + words.join('');
  c.output = String(output);
  c.minOut = String(minOut);
  return c;
}
const amountOf = (data: string): bigint => BigInt('0x' + data.slice(10 + 3 * 64, 10 + 4 * 64));
const minOutOf = (data: string): bigint => BigInt('0x' + data.slice(10 + 64, 10 + 2 * 64));

const fakeFetch = (async (url: string, init: { body: string; headers?: Record<string, string> }) => {
  const body = JSON.parse(init.body);
  if (url.startsWith('https://ws.kuru.io')) {
    if (url.endsWith('/api/generate-token')) return { json: async () => ({ token: 'fake-token', expires_at: 0 }) };
    if (url.endsWith('/api/quote')) { state.quoteCalls++; return { json: async () => quoteFor(BigInt(body.amount)) }; }
  }
  const { id, method, params } = body;
  switch (method) {
    case 'eth_blockNumber': return ok(id, '0x' + state.block.toString(16));
    case 'eth_chainId': return ok(id, '0x8f');
    case 'eth_getBalance': return ok(id, '0x' + state.mon.toString(16));
    case 'eth_gasPrice': return ok(id, '0x174876e800');
    case 'eth_estimateGas': return ok(id, '0x30d40');
    case 'eth_getTransactionCount': return ok(id, '0x' + state.nonce.toString(16));
    case 'eth_call': {
      const c = params[0] as { to: string; data: string };
      if (c.data.startsWith('0x70a08231')) return ok(id, '0x' + w(c.to.toLowerCase() === AUSD.toLowerCase() ? state.ausd : state.usdc));
      if (c.data.startsWith('0xdd62ed3e')) return ok(id, '0x' + w(c.data.slice(-40).toLowerCase() === FLOW_ROUTER.slice(2).toLowerCase() ? state.allowance : 0n));
      if (scenario === 'simfail' && c.data.startsWith('0xce1e7030')) return err(id, 'execution reverted');
      return ok(id, '0x');
    }
    case 'debug_traceCall': {
      const c = params[0] as { from: string; data: string };
      const user = c.from;
      const amount = amountOf(c.data);
      const out = scenario === 'badtrace' ? '0x2222222222222222222222222222222222222222' : user;
      return ok(id, { type: 'CALL', calls: [{ type: 'CALL', logs: [
        { address: CHAIN.usdc.toLowerCase(), topics: [TRANSFER, pad(user), pad(FLOW_ROUTER)], data: '0x' + w(amount) },
        { address: AUSD.toLowerCase(), topics: [TRANSFER, pad(FLOW_ROUTER), pad(out)], data: '0x' + w((amount * 999n) / 1000n) },
      ] }] });
    }
    case 'eth_sendRawTransaction': {
      const tx = parseTransaction(params[0]);
      const hash = '0x' + w(BigInt(++state.nonce)).padStart(64, '0');
      state.block++;
      const data = tx.data as string;
      if (data.startsWith('0x095ea7b3')) state.allowance = BigInt('0x' + data.slice(10 + 64, 10 + 128));
      else if (data.startsWith('0xce1e7030')) {
        const amount = amountOf(data);
        state.usdc -= amount; state.allowance -= amount;
        state.ausd += scenario === 'shortfall' ? minOutOf(data) - 1n : (amount * 999n) / 1000n;
      }
      state.mon -= 200_000n * 100n * 10n ** 9n;
      state.sent.push(hash);
      state.receipts.set(hash, { status: '0x1', blockNumber: '0x' + state.block.toString(16), gasUsed: '0x30d40', effectiveGasPrice: '0x174876e800', logs: [] });
      return ok(id, hash);
    }
    case 'eth_getTransactionReceipt': return ok(id, state.receipts.get(params[0]) ?? null);
    default: return err(id, `fake chain: unsupported ${method}`);
  }
}) as unknown as typeof fetch;

const PRF = (): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
configureMera({
  fetch: fakeFetch,
  ceremony: {
    create: async () => { if (scenario === 'nobiometric') throw Object.assign(new Error('x'), { name: 'MeraError', code: 'PRF_UNAVAILABLE' }); return PRF(); },
    signIn: async () => PRF(),
  },
});
document.getElementById('controls')!.innerHTML = `<p><strong>Test controls</strong> (stub passkey, fake chain and fake Kuru Flow in this tab). Scenarios: <a href="?scenario=">normal</a> · <a href="?scenario=poor">not enough USDC</a> · <a href="?scenario=nogas">not enough MON</a> · <a href="?scenario=badtrace">output goes elsewhere</a> · <a href="?scenario=simfail">swap simulation fails</a> · <a href="?scenario=shortfall">receives too little</a></p>`;
mountPasskey(document.getElementById('passkey-root')!, { fetchImpl: fakeFetch });
renderLockBar();
