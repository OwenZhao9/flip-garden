// Sending MON, USDC or AUSD from the signed-in account to another wallet: planning, the guard, and reading a call back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MON_FEE_RESERVE, SEND_ASSETS, guardSend, isRecipient, planSend, readSend } from '../src/send.ts';
import { CHAIN } from '../src/plant.ts';
import { AUSD } from '../src/swapguard.ts';

const ME = '0xdEbE9fCBc6A14963f555c63045ec8885D5f619EA';
const MM = '0x5e56e252589B2C0ACd1E983eE75520C5EB71abaD';

test('a MON send is a plain transfer with the amount as value', () => {
  const tx = planSend(ME, MM, 'MON', 5n * 10n ** 18n) as unknown as { to: string; data: string; value: string; from: string };
  assert.equal(tx.to, MM);
  assert.equal(tx.data, '0x');
  assert.equal(BigInt(tx.value), 5n * 10n ** 18n);
  assert.equal(guardSend(tx), null);
  assert.deepEqual(readSend(tx), { asset: 'MON', recipient: MM, amount: 5n * 10n ** 18n });
});

test('a USDC or AUSD send is transfer(recipient, amount) on the token, with no value', () => {
  for (const [asset, token] of [['USDC', CHAIN.usdc], ['AUSD', AUSD]] as const) {
    const tx = planSend(ME, MM, asset, 12_345_678n) as unknown as { to: string; data: string; value: string; from: string };
    assert.equal(tx.to.toLowerCase(), token.toLowerCase());
    assert.equal(tx.value, '0x0');
    assert.ok(tx.data.startsWith('0xa9059cbb'));
    assert.equal(guardSend(tx), null);
    const r = readSend(tx)!;
    assert.equal(r.asset, asset);
    assert.equal(r.recipient.toLowerCase(), MM.toLowerCase());
    assert.equal(r.amount, 12_345_678n);
  }
});

test('the guard refuses anything that is not a capped send to another wallet', () => {
  const ok = planSend(ME, MM, 'USDC', 1_000_000n) as unknown as { to: string; data: string; value: string; from: string };
  assert.match(guardSend({ ...ok, to: '0x1111111111111111111111111111111111111111' })!, /only MON, USDC or AUSD/);
  assert.match(guardSend({ ...ok, value: '0x1' })!, /only MON, USDC or AUSD/);
  assert.match(guardSend(planSend(ME, ME, 'MON', 1n) as never)!, /same account/);
  assert.match(guardSend(planSend(ME, CHAIN.usdc, 'USDC', 1n) as never)!, /token contract/);
  assert.match(guardSend(planSend(ME, MM, 'MON', 0n) as never)!, /above 0/);
  assert.match(guardSend(planSend(ME, MM, 'AUSD', SEND_ASSETS.AUSD.cap + 1n) as never)!, /at most/);
  assert.match(guardSend(planSend(ME, MM, 'MON', SEND_ASSETS.MON.cap + 1n) as never)!, /at most/);
  assert.match(guardSend({ ...ok, data: '0x095ea7b3' + ok.data.slice(10) })!, /only MON, USDC or AUSD/);
});

test('recipient addresses are checked', () => {
  assert.equal(isRecipient(MM), true);
  assert.equal(isRecipient(` ${MM} `), true);
  assert.equal(isRecipient('0x0000000000000000000000000000000000000000'), false);
  assert.equal(isRecipient('0x123'), false);
  assert.ok(MON_FEE_RESERVE > 0n);
});
