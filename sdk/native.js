// QoreChain Native lane: sign with an account's hybrid keys (secp256k1 + ML-DSA-87), broadcast,
// and read back what the chain recorded. Shared by the account tools, the smart-account session
// and the demos.
import { StargateClient } from '@cosmjs/stargate';
import { EthNativeSigner, getNetwork } from '@qorechain/sdk';

const testnet = getNetwork('testnet');
export const NET = {
  chainId: testnet.chainId,
  rest: globalThis.process?.env?.QORE_REST_URL?.trim() || testnet.endpoints.rest,
  rpc: globalThis.process?.env?.QORE_RPC_URL?.trim() || testnet.endpoints.rpc,
  evm: globalThis.process?.env?.QORE_EVM_RPC?.trim() || 'https://evm-testnet.qore.host',
};
/** Native-lane fee price: 0.15 uqor per unit of gas covers hybrid transactions on Diana. */
const GAS_PRICE_MILLI = 150n;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function getJson(path, rest = NET.rest) {
  const response = await fetch(rest + path, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error('Diana REST ' + path.split('?')[0] + ': HTTP ' + response.status);
  return response.json();
}

export async function accountSequence(address, rest = NET.rest) {
  const body = await getJson('/cosmos/auth/v1beta1/accounts/' + address, rest);
  if (!body) throw new Error(address + ' does not exist on chain yet: fund it from the faucet first.');
  const account = body.account?.base_account ?? body.account ?? {};
  return { accountNumber: BigInt(account.account_number ?? 0), sequence: BigInt(account.sequence ?? 0) };
}

export async function balanceUqor(address, rest = NET.rest) {
  const body = await getJson('/cosmos/bank/v1beta1/balances/' + address + '/by_denom?denom=uqor', rest);
  return BigInt(body?.balance?.amount ?? 0);
}

/**
 * Sign `messages` as `account` (hybrid by default; `classical` only for the ML-DSA-87 key
 * registration) and broadcast. Throws if the chain refuses the transaction itself.
 */
export async function broadcast(account, messages, { mode = 'hybrid', gas = 800_000n, memo = '', net = NET } = {}) {
  const { accountNumber, sequence } = await accountSequence(account.cosmos, net.rest);
  const signer = new EthNativeSigner(account, { signMode: mode, rest: net.rest });
  const transport = await StargateClient.connect(net.rpc);
  const fee = { amount: [{ denom: 'uqor', amount: String((BigInt(gas) * GAS_PRICE_MILLI + 999n) / 1000n) }], gas: String(gas) };
  try {
    const result = await signer.signAndBroadcast(transport, { chainId: net.chainId, accountNumber, sequence, fee, memo, messages });
    if (result.code) throw new Error('Refused by the chain (code ' + result.code + '): ' + (result.rawLog ?? ''));
    return result;
  } finally {
    transport.disconnect();
  }
}

const attributes = (event) => Object.fromEntries((event.attributes ?? []).map(({ key, value }) => [key, value]));

/** The chain's record of a delivered transaction: code, height, events, and whether the hybrid signature verified. */
export async function lookupTx(hash, net = NET) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const body = await getJson('/cosmos/tx/v1beta1/txs/' + hash, net.rest).catch(() => undefined);
    const response = body?.tx_response;
    if (response) {
      const events = response.events ?? [];
      return {
        hash: response.txhash, code: response.code, height: response.height, events,
        hybrid: events.some((event) => event.type === 'pqc_hybrid_verify' && attributes(event).status === 'verified'),
        find: (type) => events.filter((event) => event.type === type).map(attributes),
      };
    }
    await sleep(3000);
  }
  throw new Error('Transaction ' + hash + ' was not found on Diana.');
}
