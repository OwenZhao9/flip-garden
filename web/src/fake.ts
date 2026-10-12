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
    <button type="button" class="secondary" id="c-part">A taker fills 40% of my newest live order</button>
    <button type="button" class="secondary" id="c-next">A taker fills my newest live order completely</button>
    <button type="button" class="secondary" id="c-nudge">Nudge the book up (makes the preview stale)</button>
    <button type="button" class="secondary" id="c-age">Make the garden 8 days older</button>
    <button type="button" class="secondary" id="c-fail">Make simulations fail</button>
  </div>
  <h3>Game feel walk-through</h3>
  <ol class="help">
    <li><strong>First fill, stage change:</strong> plant, then press "A taker fills 40%". The plot grows from seed to sprout and the first-fill achievement plays.</li>
    <li><strong>Stage change:</strong> press "A taker fills my newest live order completely" (sprout to flower, then flower to fruit when the flipped leg fills).</li>
    <li><strong>Level up:</strong> a completed round trip, or "Make the garden 8 days older", moves the level to Sprout; "Seven days old" is an achievement.</li>
    <li>Each moment plays once per wallet. To see them again press "Forget what was celebrated".</li>
  </ol>
  <div class="actions"><button type="button" class="secondary" id="c-forget">Forget what was celebrated</button></div>
  <h3>Gardener walk-through</h3>
  <div class="actions">
    <button type="button" class="secondary" id="c-up">Market moves up 0.5% (a bid is left behind)</button>
    <button type="button" class="secondary" id="c-race">The next transaction loses the race with the market</button>
    <button type="button" class="secondary" id="c-blocks">Mine 20 empty blocks</button>
  </div>
  <p class="help">The garden card refreshes by itself every 3 seconds here (10 seconds on the real page). Plant first; the buttons that fill orders work on whatever rests on the fake book.</p>
  <p id="c-info" class="help"></p>`;
const info = (m: string): void => { document.getElementById('c-info')!.textContent = m; };
document.getElementById('c-reject')!.onclick = () => { wallet.rejectNext = true; info('The next eth_sendTransaction will be rejected like a user pressing Reject.'); };
document.getElementById('c-move')!.onclick = () => { chain.bestAsk = chain.bestBid; info(`Best ask moved down to ${chain.bestAsk}: any ladder bid is now at or above it.`); };
const newestLive = (): bigint | null => { let best: bigint | null = null; for (const [id, o] of chain.orders) if (o.size > 0n && o.owner === chain.user && (best === null || id > best)) best = id; return best; };
document.getElementById('c-fill')!.onclick = () => { for (const [id, o] of [...chain.orders]) if (o.isBuy && o.size > 0n && o.owner === chain.user) chain.fillOrder(id); info('Every live bid was filled completely; the flipped sells have new ids.'); };
document.getElementById('c-part')!.onclick = () => { const id = newestLive(); if (id === null) return info('Nothing rests on the book yet.'); chain.fillOrder(id, (chain.orders.get(id)!.size * 2n) / 5n); info(`40% of order #${id} was filled; the flipped part rests under a new id.`); };
document.getElementById('c-next')!.onclick = () => { const id = newestLive(); if (id === null) return info('Nothing rests on the book yet.'); const n = chain.fillOrder(id); info(`Order #${id} was filled completely; its flipped order is #${n}.`); };
document.getElementById('c-nudge')!.onclick = () => { chain.bestBid += 400n; chain.bestAsk += 400n; info(`The book moved up: best bid ${chain.bestBid}, best ask ${chain.bestAsk} (price units). A preview built earlier is stale now.`); };
document.getElementById('c-age')!.onclick = () => { chain.ageBy(8 * 86_400); info('The next block is 8 days later: the garden reads as eight days old.'); };
document.getElementById('c-forget')!.onclick = () => {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('flipgarden:fx:v1:')) localStorage.removeItem(k); } catch { /* storage blocked */ }
  info('The memory of celebrated moments for this tab was cleared; reload the page to start from a fresh first view.');
};
document.getElementById('c-up')!.onclick = () => { chain.bestBid = (chain.bestBid * 1005n) / 1000n / 100n * 100n; chain.bestAsk = chain.bestBid + 500n; info(`The book moved up 0.5%: best bid ${chain.bestBid}, best ask ${chain.bestAsk}.`); };
document.getElementById('c-race')!.onclick = () => {
  const send = wallet.request.bind(wallet);
  wallet.request = async (a) => {
    if (a.method !== 'eth_sendTransaction') return send(a);
    wallet.request = send;
    const ask = chain.bestAsk;
    chain.bestAsk = chain.bestBid + 100n; // the market moves between the last check and inclusion
    try { return await send(a); } finally { chain.bestAsk = ask; }
  };
  info('The next transaction is included after the market moved: a bid in it crosses and fails on chain.');
};
document.getElementById('c-blocks')!.onclick = () => { chain.block += 20; info(`Block ${chain.block}.`); };
// the fake chain only advances when something happens; the Gardener treats a frozen head as stale data
setInterval(() => { chain.block += 1; }, 1000);
document.getElementById('c-fail')!.onclick = () => { chain.opts.failWith = 'SizeError'; info('Every simulation now reverts with SizeError.'); };

mountPlant(document.getElementById('plant-root')!, { providers: scenario === 'nowallet' ? [] : [{ name: 'Fake wallet', provider: wallet }], fetchImpl: chain.fetch as unknown as typeof fetch, fake: true });
