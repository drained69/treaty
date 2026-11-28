// Chain-enforced spending rules for Treaty agents: QoreChain smart-account sessions.
//
// Treaty's mandate caps what an agent may commit, and the contract checks it. A session goes one
// layer deeper. The owner links a key the agent holds (an ed25519 session key) to the OWNER's own
// account, under a spending rule that QoreChain's abstractaccount module enforces on every call:
//
//   - permission "evm" only: the key cannot send native coins, stake, vote or deploy;
//   - allowed_evm_calls: only Treaty.fund(uint256) and Treaty.refund(uint256) on this contract;
//   - a per-call and a per-day cap on what leaves the owner's account, in QOR;
//   - an expiry, and an instant revoke by the owner.
//
// Linking, changing and revoking need the owner's hybrid signature (secp256k1 + ML-DSA-87).
// The agent's session key signs each call (MsgExecuteEVM); the agent's own account relays it and
// pays the fee, so the agent never holds the owner's money. The call runs FROM the owner's 0x
// address, and Treaty accepts a budget locked by the client's owner, so unused budget is refunded
// to the owner. A stolen session key can at most lock budget into treaties the agent already
// signed with ML-DSA-87, within the caps, and that budget can only flow out per accepted delivery
// or back to the owner.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ed25519 } from '@noble/curves/ed25519';
import {
  buildPhantomExecuteEvm, fetchAuthNonce, fetchAuthenticators, fetchSpendingRules, linkAuthenticatorMsgs,
  resolveEvmAuthDigestVersion, revokeAuthenticatorMsg, signAuthenticatorLinkEd25519, validateSpendingRules,
} from '@qorechain/sdk';
import { bech32 } from '@scure/base';
import { bytesToHex, encodeFunctionData, getAddress, hexToBytes, isAddress, toFunctionSelector } from 'viem';
import { NET, broadcast, lookupTx } from './native.js';

const artifact = JSON.parse(await readFile(new URL('../artifacts/Treaty.json', import.meta.url)));
const { abi } = artifact;

/** The Treaty functions a session key may call. Both only ever move money into the treaty, or back to the owner. */
export const SESSION_FUNCTIONS = Object.freeze(['fund(uint256)', 'refund(uint256)']);
export const SESSION_PERMISSIONS = Object.freeze(['evm']);
export const WEI_PER_UQOR = 10n ** 12n;
/** Gas for the Treaty call inside MsgExecuteEVM (fund uses about 64k), and for the relayer's outer transaction. */
export const CALL_GAS = 250_000n;
const OUTER_GAS = 1_200_000n;

const qorOf = (evm) => bech32.encode('qor', bech32.toWords(hexToBytes(getAddress(evm))));
const evmOf = (qor) => getAddress(bytesToHex(Uint8Array.from(bech32.fromWords(bech32.decode(qor).words))));
/** Accept either form of an account and return both. */
export function accountForms(value) {
  if (isAddress(value ?? '')) return { evm: getAddress(value), qor: qorOf(value) };
  if (/^qor1[02-9ac-hj-np-z]{38}$/.test(value ?? '')) return { evm: evmOf(value), qor: value };
  throw new Error('Expected a 0x or qor1 account address, got ' + value + '.');
}
const toUqor = (wei) => {
  if (typeof wei !== 'bigint' || wei <= 0n || wei % WEI_PER_UQOR) throw new Error('Limits must be positive amounts in whole uqor.');
  return (wei / WEI_PER_UQOR).toString();
};

/** "0x<contract>/0x<selector>" entries: the only EVM calls the session key may make. */
export function treatyCallPolicy(contract, functions = SESSION_FUNCTIONS) {
  const target = getAddress(contract).toLowerCase();
  return functions.map((signature) => target + '/' + toFunctionSelector('function ' + signature));
}

/** Read an allowed_evm_calls entry back as words: "Treaty.fund" when it is this contract. */
export function describeCall(entry, contract) {
  const [target, selector] = entry.split('/');
  const known = Object.fromEntries(SESSION_FUNCTIONS.map((signature) => [toFunctionSelector('function ' + signature), signature.split('(')[0]]));
  const name = contract && target?.toLowerCase() === contract.toLowerCase() ? 'Treaty' : target;
  return selector ? name + '.' + (known[selector] ?? selector) : 'any function of ' + name;
}

/** The spending rule the chain enforces on the session key. Amounts in wei, stored in uqor. */
export function sessionRule({ contract, perCall, perDay, id = 'treaty-session' }) {
  if (perCall > perDay) throw new Error('The per-call limit cannot be above the daily limit.');
  const rule = {
    id, enabled: true, perTxLimit: toUqor(perCall), dailyLimit: toUqor(perDay),
    allowedDenoms: ['uqor'], allowedEvmCalls: treatyCallPolicy(contract), denomLimits: [],
  };
  validateSpendingRules([rule]);
  return rule;
}

/** A new random ed25519 session key, as hex. It holds no money. */
export const generateSessionKey = () => randomBytes(32).toString('hex');

/** The session key from its hex secret: its public key and a signer the SDK's builders take. */
export function sessionKey(secretHex) {
  if (!/^(0x)?[\da-fA-F]{64}$/.test(secretHex ?? '')) throw new Error('A session key is 32 bytes of hex.');
  const secretKey = hexToBytes(secretHex.startsWith('0x') ? secretHex : '0x' + secretHex);
  const publicKey = ed25519.getPublicKey(secretKey);
  return {
    secretKey, publicKey, publicHex: bytesToHex(publicKey).slice(2),
    wallet: { publicKey, async signMessage(message) { return { signature: ed25519.sign(message, secretKey) }; } },
  };
}

/**
 * The owner's one transaction that links the session key: [MsgUpdateSpendingRules, MsgRegisterAuthenticator].
 * The session key signs a proof that it agrees to be linked to exactly this account on this chain.
 */
export function linkSessionMsgs({ owner, session, contract, perCall, perDay, hours = 24, label = 'Treaty agent session', chainId = NET.chainId, now = Date.now() }) {
  const { qor } = accountForms(owner);
  if (!(hours > 0 && hours <= 30 * 24)) throw new Error('A session lasts between a few minutes and 30 days.');
  const proof = signAuthenticatorLinkEd25519({ chainId, account: qor, privateKey: session.secretKey });
  return linkAuthenticatorMsgs({
    owner: qor, chainId, ...proof, permissions: [...SESSION_PERMISSIONS], label,
    expiryUnix: Math.floor(now / 1000 + hours * 3600),
    spendingRule: sessionRule({ contract, perCall, perDay }),
  });
}

export function revokeSessionMsg({ owner, session }) {
  return revokeAuthenticatorMsg({ owner: accountForms(owner).qor, scheme: 'ed25519', pubkey: session.publicKey });
}

/** Build the MsgExecuteEVM the session key signs: the v2 digest binds the target, value, call data, nonce and gas. */
export async function sessionCall({ session, owner, relayer, to, data, value = 0n, gasLimit = CALL_GAS, rest = NET.rest, chainId = NET.chainId, fetch }) {
  const account = accountForms(owner).qor;
  const [{ nonce }, digestVersion] = await Promise.all([
    fetchAuthNonce({ rest, address: account, pubkey: session.publicKey, fetch }),
    resolveEvmAuthDigestVersion({ rest, fetch }),
  ]);
  const message = await buildPhantomExecuteEvm({
    wallet: session.wallet, relayer: accountForms(relayer).qor, chainId, account, to: getAddress(to),
    value: value.toString(), data: hexToBytes(data), gasLimit, nonce, digestVersion,
  });
  return { message, nonce, digestVersion };
}

/** What happened to an authorised execution: from chain v3.2.8 a refused call is a code-0 tx with a failure event. */
export function executionOutcome(tx) {
  const [failure] = tx.find('abstractaccount_execution_failed');
  const evmHash = tx.events.flatMap((event) => event.attributes ?? [])
    .find(({ key, value }) => /hash/i.test(key) && /^0x[\da-f]{64}$/i.test(value ?? ''))?.value;
  return failure
    ? { success: false, reason: failure.reason || 'refused', cosmosTx: tx.hash, height: tx.height }
    : { success: true, cosmosTx: tx.hash, height: tx.height, evmHash, hybrid: tx.hybrid };
}

/** Everything the chain enforces for an account's sessions, read over REST. */
export async function readSmartAccount({ owner, session, contract, rest = NET.rest, fetch }) {
  const { qor } = accountForms(owner);
  // An account becomes a smart account when its owner first links a key: before that Diana answers 404.
  const orNone = (promise, none) => promise.catch((error) => {
    if (/HTTP 404|not found/i.test(String(error?.message))) return none;
    throw error;
  });
  const [rules, authenticators, nonce] = await Promise.all([
    orNone(fetchSpendingRules({ rest, address: qor, fetch }), { rules: [], authenticatorRules: [] }),
    orNone(fetchAuthenticators({ rest, address: qor, fetch }), []),
    session ? orNone(fetchAuthNonce({ rest, address: qor, pubkey: session.publicKey, fetch }), { nonce: 0n, linked: false }) : undefined,
  ]);
  const key = session && authenticators.find((entry) => entry.pubkeyHex.toLowerCase() === session.publicHex);
  return {
    account: qor, smartAccount: authenticators.length > 0 || rules.rules.length > 0, rules: rules.rules, authenticators, key, calls: nonce?.nonce,
    describe: (entry) => describeCall(entry, contract),
  };
}

/**
 * An agent acting on its owner's account through a linked session key. `relayer` is the agent's
 * own hybrid account (it signs the outer transaction and pays the fee); `owner` is the account the
 * money comes from. Every call is checked by the chain against the owner's rule before it runs.
 */
export class OwnerSession {
  constructor({ contract, owner, session, relayer, client, net = NET }) {
    this.contract = getAddress(contract);
    this.owner = accountForms(owner);
    this.session = session;
    this.relayer = relayer;
    this.client = client;
    this.net = net;
  }

  /** Sign a call with the session key, relay it, and report the chain's verdict. Never throws for a refusal. */
  async call({ to = this.contract, data, value = 0n, gasLimit = CALL_GAS, memo = 'Treaty session call' }) {
    const { message, nonce } = await sessionCall({
      session: this.session, owner: this.owner.qor, relayer: this.relayer.cosmos, to, data, value, gasLimit,
      rest: this.net.rest, chainId: this.net.chainId,
    });
    const sent = await broadcast(this.relayer, [message], { gas: OUTER_GAS + BigInt(gasLimit), memo, net: this.net });
    return { ...executionOutcome(await lookupTx(sent.transactionHash, this.net)), nonce };
  }

  /** Lock a treaty's whole budget from the owner's account. Treaty accepts it because the owner is the client's owner. */
  async fund(id) {
    const agreement = await this.client.readContract({ address: this.contract, abi, functionName: 'getAgreement', args: [BigInt(id)] });
    const value = BigInt(agreement.price) * BigInt(agreement.maxUnits);
    return this.call({ data: encodeFunctionData({ abi, functionName: 'fund', args: [BigInt(id)] }), value, memo: 'Treaty: lock the budget of treaty #' + id });
  }

  /** Return a treaty's unused budget after its deadline: it goes to the owner. */
  async refund(id) {
    return this.call({ data: encodeFunctionData({ abi, functionName: 'refund', args: [BigInt(id)] }), memo: 'Treaty: refund treaty #' + id });
  }

  status() {
    return readSmartAccount({ owner: this.owner.qor, session: this.session, contract: this.contract, rest: this.net.rest });
  }
}
