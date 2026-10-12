// Read-only speed probe: how long does it take to read a wallet's Kuru history through HyperSync versus the public RPC?
// Usage (macOS Terminal):  ENVIO_API_TOKEN=$(pbpaste) node scripts/envio-probe.ts [wallet] [startBlock]
// It only reads. It never prints the token.
import { JsonRpc } from '../src/rpc.ts';
import { HyperSyncSource, HYPERSYNC_WINDOW_BLOCKS } from '../src/hypersync.ts';
import { newScanState, sync, eventsOf, type LogSource } from '../src/scan.ts';
import { MAINNET, EXAMPLE } from '../web/src/pipeline.ts';

const token = process.env.ENVIO_API_TOKEN;
if (!token) throw new Error('Set ENVIO_API_TOKEN (see the usage line).');
const wallet = (process.argv[2] ?? EXAMPLE.account).toLowerCase();
const start = Number(process.argv[3] ?? 110298080); // earliest block of Kuru flip-order data we hold (see server/wrangler.toml)
const rpc = new JsonRpc(MAINNET.rpcUrl, { retries: 3 });

function counted(src: LogSource): LogSource & { logs: number; calls: number } {
  const c = { logs: 0, calls: 0 } as { logs: number; calls: number };
  return Object.assign(c, {
    blockNumber: () => src.blockNumber(),
    async getLogs(f: Parameters<LogSource['getLogs']>[0]) {
      c.calls++;
      const r = await src.getLogs(f);
      c.logs += r.length;
      return r;
    },
  }) as never;
}

const fresh = (from: number) => newScanState({ account: wallet, markets: [MAINNET.market], marginAccount: MAINNET.marginAccount, startBlock: from });
const sources: string[] = [];
const hs = new HyperSyncSource({ url: 'https://monad.hypersync.xyz', token, fallback: rpc, onSource: (s) => sources.push(s) });

const head = await rpc.blockNumber();
console.log(`wallet ${wallet}\nhead ${head}`);

// 1) Same slice through both sources: the results must be identical.
const sliceFrom = EXAMPLE.startBlock;
const sliceTo = EXAMPLE.endBlock;
const t0 = Date.now();
const a = fresh(sliceFrom);
const rpcC = counted(rpc);
await sync(a, rpcC, { toBlock: sliceTo });
const tRpc = Date.now() - t0;
const t1 = Date.now();
const b = fresh(sliceFrom);
const hsC = counted(hs);
await sync(b, hsC, { toBlock: sliceTo, maxBlocks: HYPERSYNC_WINDOW_BLOCKS });
const tHs = Date.now() - t1;
const same = JSON.stringify(a.logs) === JSON.stringify(b.logs);
console.log(`\nslice ${sliceFrom}..${sliceTo} (${sliceTo - sliceFrom + 1} blocks)`);
console.log(`  public RPC : ${tRpc} ms, ${rpcC.calls} getLogs calls, ${Object.keys(a.logs).length} wallet logs`);
console.log(`  HyperSync  : ${tHs} ms, ${hsC.calls} getLogs calls, ${Object.keys(b.logs).length} wallet logs, sources used: ${[...new Set(sources)].join(',')}`);
console.log(`  identical scan state: ${same}`);

// 2) HyperSync over the whole range since the market's earliest known block.
sources.length = 0;
const t2 = Date.now();
const full = fresh(start);
const fullC = counted(hs);
await sync(full, fullC, { maxBlocks: HYPERSYNC_WINDOW_BLOCKS });
const tFull = Date.now() - t2;
console.log(`\nfull range ${start}..${head} (${head - start} blocks), HyperSync only`);
console.log(`  ${tFull} ms, ${fullC.calls} getLogs calls, ${fullC.logs} logs read from the chain, ${Object.keys(full.logs).length} kept for the wallet, sources used: ${[...new Set(sources)].join(',')}`);
console.log(`  events decoded for the wallet: ${eventsOf(full).length}`);
