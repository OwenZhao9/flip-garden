// Regression for "Cannot convert undefined to a BigInt" seen in the browser during the first real run (2026-10-11):
// an RPC answer without `result` used to be returned as undefined and blew up later inside BigInt().
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpc } from '../src/rpc.ts';
import { parseNote, serializeNote } from '../web/src/plantnote.ts';

const reply = (body: unknown) => async () => ({ json: async () => body });

test('an answer without a result is retried, then reported with the method name', async () => {
  let calls = 0;
  const flaky = async (): Promise<{ json(): Promise<unknown> }> => {
    calls++;
    return { json: async () => (calls === 1 ? { jsonrpc: '2.0', id: 1 } : { jsonrpc: '2.0', id: 2, result: '0x10' }) };
  };
  const rpc = new JsonRpc('x://rpc', { retries: 2, fetch: flaky as unknown as typeof fetch });
  assert.equal(await rpc.blockNumber(), 16);
  assert.equal(calls, 2);

  const dead = new JsonRpc('x://rpc', { retries: 0, fetch: reply({ jsonrpc: '2.0', id: 1 }) as unknown as typeof fetch });
  await assert.rejects(dead.blockNumber(), /eth_blockNumber: the node answered without a result/);
  const empty = new JsonRpc('x://rpc', { retries: 0, fetch: reply(null) as unknown as typeof fetch });
  await assert.rejects(empty.walletBalance('0x' + '1'.repeat(40), '0x' + '0'.repeat(40)), /without a result/);
});

test('a null result is still a valid answer (a receipt that is not there yet)', async () => {
  const rpc = new JsonRpc('x://rpc', { retries: 0, fetch: reply({ jsonrpc: '2.0', id: 1, result: null }) as unknown as typeof fetch });
  assert.equal(await rpc.call('eth_getTransactionReceipt', ['0x1']), null);
});

test('the saved planting note survives corrupt, partial or foreign content', () => {
  const ok = parseNote(serializeNote({ startBlock: 112416427, orderIds: [5000n, 5001n] }));
  assert.deepEqual(ok, { startBlock: 112416427, orderIds: [5000n, 5001n] });
  assert.deepEqual(parseNote(serializeNote({ orderIds: [] })), { orderIds: [] });
  for (const bad of [null, '', 'nope', '[]', '"x"', '{"orderIds":[null,"undefined",7,"12x",{}],"startBlock":"112"}', '{"orderIds":"1","startBlock":-5}']) {
    assert.deepEqual(parseNote(bad), { orderIds: [] }, String(bad));
  }
  assert.deepEqual(parseNote('{"orderIds":["7",null,"undefined","9"],"startBlock":42}'), { startBlock: 42, orderIds: [7n, 9n] });
});
