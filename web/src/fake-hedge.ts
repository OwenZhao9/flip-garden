// Test page only (web/fake-hedge.html): the hedge page wired to a fake wallet and a fake Perpl chain living in this tab.
// Nothing here touches a real network or a real wallet; it exists so every state of the flow can be walked through.
import { FakeWallet } from '../../test/helpers/fakechain.ts';
import type { FakeChain } from '../../test/helpers/fakechain.ts';
import { FakePerplChain } from '../../test/helpers/fakeperpl.ts';
import { mountHedge } from './hedge.ts';

const USER = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';
const q = new URLSearchParams(location.search);
const scenario = q.get('scenario') ?? '';

const chain = new FakePerplChain(USER);
const wallet = new FakeWallet(chain as unknown as FakeChain, USER);
chain.s.walletMon = 1200n * 10n ** 18n;
chain.s.kuruMon = 300n * 10n ** 18n;
if (scenario === 'wrongchain') wallet.chainIdHex = '0x1';
if (scenario === 'poor') chain.s.walletAusd = 1_000_000n;
if (scenario === 'nogas') chain.s.walletMon = 100_000_000_000_000_000n;
(window as unknown as { __fake: unknown }).__fake = { chain, wallet };

document.getElementById('controls')!.innerHTML = `
  <p><strong>Test controls</strong> (fake chain in this tab). Scenarios: <a href="?scenario=">normal</a> · <a href="?scenario=wrongchain">wrong chain</a> · <a href="?scenario=poor">not enough AUSD</a> · <a href="?scenario=nogas">not enough MON</a> · <a href="?scenario=nowallet">no wallet</a></p>
  <div class="actions">
    <button type="button" class="secondary" id="c-reject">Reject the next wallet pop-up</button>
    <button type="button" class="secondary" id="c-empty">Next order finds nothing to fill</button>
    <button type="button" class="secondary" id="c-part">Next order fills only 200 MON</button>
    <button type="button" class="secondary" id="c-up">MON price +10%</button>
    <button type="button" class="secondary" id="c-fail">Make simulations fail</button>
  </div>
  <p id="c-info" class="help"></p>`;
const info = (m: string): void => { document.getElementById('c-info')!.textContent = m; };
document.getElementById('c-reject')!.onclick = () => { wallet.rejectNext = true; info('The next eth_sendTransaction will be rejected like a user pressing Reject.'); };
document.getElementById('c-empty')!.onclick = () => { chain.opts.liquidityAfterSim = 0n; info('The next transaction runs against an empty book (after its simulation filled).'); };
document.getElementById('c-part')!.onclick = () => { chain.opts.liquidityAfterSim = 200n; info('The next order fills at most 200 MON.'); };
document.getElementById('c-up')!.onclick = () => {
  const f = (x: bigint): bigint => (x * 110n) / 100n;
  chain.s.bids = chain.s.bids.map((l) => ({ ...l, price: f(l.price) }));
  chain.s.asks = chain.s.asks.map((l) => ({ ...l, price: f(l.price) }));
  chain.s.mark = f(chain.s.mark);
  info('The whole book and the mark price moved up 10%.');
};
document.getElementById('c-fail')!.onclick = () => { chain.opts.failWith = 'TakerOrderSettlementFailed'; info('Every simulation now reverts.'); };

mountHedge(document.getElementById('hedge-root')!, { providers: scenario === 'nowallet' ? [] : [{ name: 'Fake wallet', provider: wallet }], fetchImpl: chain.fetch as unknown as typeof fetch, fake: true });
