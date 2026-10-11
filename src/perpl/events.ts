// Decoder for the Perpl exchange events the read model and the simulations need.
// None of these events has an indexed parameter (checked in the ABI), so a log query can only be
// filtered by address and event, never by account: the account id is a data word, and callers
// filter after decoding. test/perpl-encode.test.ts checks this table against the ABI in
// config/perpl.exchange.abi.json so it cannot drift.
import { splitWords, topic0, wordToBool, wordToInt, wordToUint, wordToAddress } from './abi.ts';

export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
};

type T = 'uint256' | 'int256' | 'uint8' | 'bool' | 'address';
// Static fields only. OrderRequestV2 ends with a dynamic `bytes extension`; it is not decoded and
// the table lists the static prefix (the signature below still includes it for the topic hash).
const TABLE: Array<{ name: string; sig: string; fields: Array<[string, T]> }> = [
  { name: 'AccountCreated', sig: 'AccountCreated(address,uint256)', fields: [['account', 'address'], ['id', 'uint256']] },
  { name: 'CollateralDeposit', sig: 'CollateralDeposit(uint256,uint256,uint256)', fields: [['accountId', 'uint256'], ['amountCNS', 'uint256'], ['balanceCNS', 'uint256']] },
  { name: 'CollateralWithdrawal', sig: 'CollateralWithdrawal(uint256,uint256,uint256)', fields: [['accountId', 'uint256'], ['amountCNS', 'uint256'], ['balanceCNS', 'uint256']] },
  {
    name: 'OrderRequestV2',
    sig: 'OrderRequestV2(uint256,uint256,uint256,uint256,uint8,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256,uint256,bytes)',
    fields: [
      ['perpId', 'uint256'], ['accountId', 'uint256'], ['orderDescId', 'uint256'], ['orderId', 'uint256'], ['orderType', 'uint8'],
      ['pricePNS', 'uint256'], ['lotLNS', 'uint256'], ['expiryBlock', 'uint256'], ['postOnly', 'bool'], ['fillOrKill', 'bool'],
      ['immediateOrCancel', 'bool'], ['maxMatches', 'uint256'], ['leverageHdths', 'uint256'], ['lastExecutionBlock', 'uint256'],
      ['amountCNS', 'uint256'], ['maxNegPnlCollatBPS', 'uint256'], ['gasLeft', 'uint256'],
    ],
  },
  { name: 'OrderPlaced', sig: 'OrderPlaced(uint256,uint256,uint256,int256,uint256)', fields: [['orderId', 'uint256'], ['lotLNS', 'uint256'], ['lockedBalanceCNS', 'uint256'], ['amountCNS', 'int256'], ['balanceCNS', 'uint256']] },
  { name: 'OrderCancelled', sig: 'OrderCancelled(uint256,int256,uint256)', fields: [['lockedBalanceCNS', 'uint256'], ['amountCNS', 'int256'], ['balanceCNS', 'uint256']] },
  { name: 'OrderChanged', sig: 'OrderChanged(uint256,uint256,uint256,uint256,uint256,uint256)', fields: [['orderId', 'uint256'], ['pricePNS', 'uint256'], ['lotLNS', 'uint256'], ['expiryBlock', 'uint256'], ['lockedBalanceCNS', 'uint256'], ['balanceCNS', 'uint256']] },
  {
    name: 'PositionOpenedV2',
    sig: 'PositionOpenedV2(uint256,uint256,uint8,uint256,uint256,int256,uint256,uint256,uint256,uint256,uint256)',
    fields: [['perpId', 'uint256'], ['accountId', 'uint256'], ['positionType', 'uint8'], ['leverageHdths', 'uint256'], ['depositCNS', 'uint256'], ['pnlCollateralizedCNS', 'int256'], ['pricePNS', 'uint256'], ['lotLNS', 'uint256'], ['insFeeCNS', 'uint256'], ['protFeeCNS', 'uint256'], ['priceResiduePNSQ16', 'uint256']],
  },
  {
    name: 'PositionDecreased',
    sig: 'PositionDecreased(uint256,uint256,uint8,uint256,uint256,uint256,uint256,int256,int256)',
    fields: [['perpId', 'uint256'], ['accountId', 'uint256'], ['positionType', 'uint8'], ['startDepositCNS', 'uint256'], ['endDepositCNS', 'uint256'], ['startLotLNS', 'uint256'], ['endLotLNS', 'uint256'], ['deltaPnlCNS', 'int256'], ['fundingCNS', 'int256']],
  },
  { name: 'PositionClosed', sig: 'PositionClosed(uint256,uint256,uint8,uint256,int256,int256)', fields: [['perpId', 'uint256'], ['accountId', 'uint256'], ['positionType', 'uint8'], ['pricePNS', 'uint256'], ['deltaPnlCNS', 'int256'], ['fundingCNS', 'int256']] },
  {
    name: 'MakerOrderFilledV2',
    sig: 'MakerOrderFilledV2(uint256,uint256,uint256,uint256,uint256,uint256,uint256,int256,uint256,uint256,uint256)',
    fields: [['perpId', 'uint256'], ['accountId', 'uint256'], ['orderId', 'uint256'], ['pricePNS', 'uint256'], ['lotLNS', 'uint256'], ['feeCNS', 'uint256'], ['lockedBalanceCNS', 'uint256'], ['amountCNS', 'int256'], ['balanceCNS', 'uint256'], ['builderId', 'uint256'], ['builderFeeCNS', 'uint256']],
  },
  {
    name: 'TakerOrderFilledV2',
    sig: 'TakerOrderFilledV2(uint256,uint256,uint256,uint256,uint256,int256,uint256,uint256,uint256)',
    fields: [['entryPricePNS', 'uint256'], ['collatPricePNS', 'uint256'], ['pnlPricePNS', 'uint256'], ['lotLNS', 'uint256'], ['feeCNS', 'uint256'], ['amountCNS', 'int256'], ['balanceCNS', 'uint256'], ['builderId', 'uint256'], ['builderFeeCNS', 'uint256']],
  },
  { name: 'OrderBatchCompleted', sig: 'OrderBatchCompleted(uint256)', fields: [['gasLeft', 'uint256']] },
];

export const EVENT_SIGNATURES: Record<string, string> = Object.fromEntries(TABLE.map((e) => [e.name, e.sig]));
export const EVENT_TOPICS: Record<string, string> = Object.fromEntries(TABLE.map((e) => [e.name, topic0(e.sig)]));
const BY_TOPIC = new Map(TABLE.map((e) => [topic0(e.sig), e]));

export type PerplEvent = { name: string; fields: Record<string, bigint | boolean | string>; log: RawLog };

export function decodePerplLog(log: RawLog): PerplEvent | null {
  const e = BY_TOPIC.get(log.topics[0]);
  if (!e) return null;
  const w = splitWords(log.data);
  if (w.length < e.fields.length) throw new Error(`${e.name}: expected at least ${e.fields.length} words, got ${w.length}`);
  const fields: PerplEvent['fields'] = {};
  e.fields.forEach(([k, t], i) => {
    fields[k] = t === 'bool' ? wordToBool(w[i]) : t === 'int256' ? wordToInt(w[i]) : t === 'address' ? wordToAddress(w[i]) : wordToUint(w[i]);
  });
  return { name: e.name, fields, log };
}

export const fieldOf = (e: PerplEvent, k: string): bigint => {
  const v = e.fields[k];
  if (typeof v !== 'bigint') throw new Error(`${e.name}.${k} is not an integer`);
  return v;
};
