// Test page only (web/fake.html): the planting page wired to a fake wallet and a fake chain living in this tab.
// Nothing here touches a real network or a real wallet; it exists so every state of the flow can be walked through.
import { FakeChain, FakeWallet } from '../../test/helpers/fakechain.ts';
import { mountPlant } from './plant.ts';

const USER = '0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38';
const q = new URLSearchParams(location.search);
const scenario = q.get('scenario') ?? '';

const chain = new FakeChain(USER);
const wallet = new FakeWallet(chain, USER);
if (scenario === 'wrongchain') wallet.chainIdHex = '0x1';
if (scenario === 'unknownchain') { wallet.chainIdHex = '0x1'; wallet.knowsMonad = false; }
if (scenario === 'poor') { chain.walletUsdc = 1_000_000n; }
if (scenario === 'nogas') { chain.walletMon = 100_000_000_000_000_000n; }

(window as unknown as { __fake: unknown }).__fake = { chain, wallet };

const controls = document.getElementById('controls')!;
controls.innerHTML = `
  <p><strong>Test controls</strong> (fake chain in this tab). Scenarios: <a href="?scenario=">normal</a> · <a href="?scenario=wrongchain">wrong chain</a> · <a href="?scenario=unknownchain">chain unknown to wallet</a> · <a href="?scenario=poor">not enough USDC</a> · <a href="?scenario=nogas">not enough MON</a> · <a href="?scenario=nowallet">no wallet</a></p>
  <div class="actions">
    <button type="button" class="secondary" id="c-reject">Reject the next wallet pop-up</button>
    <button type="button" class="secondary" id="c-move">Move the book under my bids</button>
    <button type="button" class="secondary" id="c-fill">A taker fills my bids</button>
    <button type="button" class="secondary" id="c-fail">Make simulations fail</button>
  </div>
  <p id="c-info" class="help"></p>`;
const info = (m: string): void => { document.getElementById('c-info')!.textContent = m; };
document.getElementById('c-reject')!.onclick = () => { wallet.rejectNext = true; info('The next eth_sendTransaction will be rejected like a user pressing Reject.'); };
document.getElementById('c-move')!.onclick = () => { chain.bestAsk = chain.bestBid; info(`Best ask moved down to ${chain.bestAsk}: any ladder bid is now at or above it.`); };
document.getElementById('c-fill')!.onclick = () => { for (const [id, o] of chain.orders) if (o.isBuy && o.size > 0n) chain.fillBid(id); info('Every live bid was filled; the flipped sells have new ids.'); };
document.getElementById('c-fail')!.onclick = () => { chain.opts.failWith = 'SizeError'; info('Every simulation now reverts with SizeError.'); };

mountPlant(document.getElementById('plant-root')!, { providers: scenario === 'nowallet' ? [] : [{ name: 'Fake wallet', provider: wallet }], fetchImpl: chain.fetch as unknown as typeof fetch, fake: true });
