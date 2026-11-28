// Smart-account sessions: the messages Treaty builds for QoreChain's abstractaccount module.
// These run offline against the SDK's own byte builders; the live behaviour is exercised on Diana
// by `npm run demo -- --diana --smart-account`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519';
import { evmAuthSignBytes, evmAuthSignBytesV2, verifyAuthenticatorLinkProof } from '@qorechain/sdk';
import { encodeFunctionData, parseEther, toFunctionSelector } from 'viem';
import {
  SESSION_PERMISSIONS, accountForms, describeCall, executionOutcome, generateSessionKey, linkSessionMsgs,
  revokeSessionMsg, sessionCall, sessionKey, sessionRule, treatyCallPolicy,
} from '../sdk/smart-account.js';

const { abi } = JSON.parse(await readFile(new URL('../artifacts/Treaty.json', import.meta.url)));
const CONTRACT = '0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6';
const OWNER = '0x83247522D8f37598111CeB0B4ECC6C4C6747BEC2';
const AGENT = '0x378C243566d8e545e3E32e8555De03403f66b998';
const CHAIN = 'qorechain-diana';

/** A stand-in REST node: the key's nonce, and whether v3.2.3 (the v2 digest) is applied. */
const restStub = ({ nonce = 0, v2 = true } = {}) => async (url) => ({
  ok: true, status: 200, text: async () => '',
  json: async () => url.includes('auth_nonce') ? { nonce: String(nonce), linked: true }
    : url.includes('applied_plan') ? { height: v2 ? '1200' : '0' } : {},
});

test('the session may only call Treaty.fund and Treaty.refund on this contract', () => {
  const policy = treatyCallPolicy(CONTRACT);
  const selectors = Object.fromEntries(abi.filter((item) => item.type === 'function')
    .map((item) => [toFunctionSelector(item), item.name]));
  assert.deepEqual(policy.map((entry) => entry.split('/')[0]), [CONTRACT.toLowerCase(), CONTRACT.toLowerCase()]);
  assert.deepEqual(policy.map((entry) => selectors[entry.split('/')[1]]), ['fund', 'refund']);
  assert.deepEqual(policy.map((entry) => describeCall(entry, CONTRACT)), ['Treaty.fund', 'Treaty.refund']);
  assert.equal(describeCall('0x97143b771d34ddb9130b807b135ae675a5a963ca', CONTRACT), 'any function of 0x97143b771d34ddb9130b807b135ae675a5a963ca');
});

test('the spending rule caps every call and every day, in uqor, for QOR only', () => {
  const rule = sessionRule({ contract: CONTRACT, perCall: parseEther('6'), perDay: parseEther('9') });
  assert.equal(rule.perTxLimit, '6000000');
  assert.equal(rule.dailyLimit, '9000000');
  assert.deepEqual(rule.allowedDenoms, ['uqor']);
  assert.equal(rule.enabled, true);
  assert.throws(() => sessionRule({ contract: CONTRACT, perCall: parseEther('10'), perDay: parseEther('9') }), /per-call/);
  assert.throws(() => sessionRule({ contract: CONTRACT, perCall: 1n, perDay: parseEther('9') }), /whole uqor/);
});

test('linking is one owner transaction: the rule, then the key with only the evm permission and a proof it agreed', () => {
  const session = sessionKey(generateSessionKey());
  const now = Date.UTC(2026, 10, 28);
  const [rules, register] = linkSessionMsgs({ owner: OWNER, session, contract: CONTRACT, perCall: parseEther('6'), perDay: parseEther('6'), hours: 24, now });
  const owner = accountForms(OWNER).qor;
  assert.equal(rules.typeUrl, '/qorechain.abstractaccount.v1.MsgUpdateSpendingRules');
  assert.equal(register.typeUrl, '/qorechain.abstractaccount.v1.MsgRegisterAuthenticator');
  assert.equal(rules.value.owner, owner);
  assert.deepEqual(rules.value.rules[0].allowedEvmCalls, treatyCallPolicy(CONTRACT));
  assert.deepEqual(register.value.permissions, [...SESSION_PERMISSIONS]);
  assert.equal(register.value.scheme, 'ed25519');
  assert.deepEqual(register.value.pubkey, session.publicKey);
  assert.equal(BigInt(register.value.expiryUnix), BigInt(now / 1000 + 86400));
  assert.ok(verifyAuthenticatorLinkProof({ chainId: CHAIN, account: owner, scheme: 'ed25519', pubkey: session.publicKey, possessionProof: register.value.possessionProof }));
  // A proof for another account does not transfer.
  assert.ok(!verifyAuthenticatorLinkProof({ chainId: CHAIN, account: accountForms(AGENT).qor, scheme: 'ed25519', pubkey: session.publicKey, possessionProof: register.value.possessionProof }));
  assert.throws(() => linkSessionMsgs({ owner: OWNER, session, contract: CONTRACT, perCall: parseEther('1'), perDay: parseEther('1'), hours: 0 }), /session lasts/);
});

test('a session call is signed over the v2 digest: target, value, call data, the key’s nonce and the gas limit', async () => {
  const session = sessionKey(generateSessionKey());
  const data = encodeFunctionData({ abi, functionName: 'fund', args: [7n] });
  const { message, nonce, digestVersion } = await sessionCall({
    session, owner: OWNER, relayer: AGENT, to: CONTRACT, data, value: parseEther('6'), fetch: restStub({ nonce: 4 }),
  });
  const value = message.value;
  assert.equal(message.typeUrl, '/qorechain.abstractaccount.v1.MsgExecuteEVM');
  assert.equal(digestVersion, 'v2');
  assert.equal(nonce, 4n);
  assert.equal(value.account, accountForms(OWNER).qor, 'the money comes from the owner’s account');
  assert.equal(value.relayer, accountForms(AGENT).qor, 'the agent relays and pays the fee');
  assert.equal(value.value, parseEther('6').toString());
  const input = { chainId: CHAIN, account: value.account, pubkey: session.publicKey, to: value.to, value: value.value, data: value.data, nonce: BigInt(value.nonce) };
  assert.ok(ed25519.verify(value.signature, evmAuthSignBytesV2({ ...input, gasLimit: BigInt(value.gasLimit) }), session.publicKey));
  // Changing the gas limit, the value or the nonce breaks the signature: a relayer cannot alter the call.
  assert.ok(!ed25519.verify(value.signature, evmAuthSignBytesV2({ ...input, gasLimit: BigInt(value.gasLimit) + 1n }), session.publicKey));
  assert.ok(!ed25519.verify(value.signature, evmAuthSignBytesV2({ ...input, value: '1', gasLimit: BigInt(value.gasLimit) }), session.publicKey));
  assert.ok(!ed25519.verify(value.signature, evmAuthSignBytesV2({ ...input, nonce: 5n, gasLimit: BigInt(value.gasLimit) }), session.publicKey));
  // Before v3.2.3 the chain verifies the v1 digest instead, and the session follows it.
  const old = await sessionCall({ session, owner: OWNER, relayer: AGENT, to: CONTRACT, data, rest: 'http://node-before-v3-2-3', fetch: restStub({ v2: false }) });
  assert.equal(old.digestVersion, 'v1');
  assert.ok(ed25519.verify(old.message.value.signature, evmAuthSignBytes({ ...input, value: '0', nonce: 0n }), session.publicKey));
});

test('revoking names exactly the linked key', () => {
  const session = sessionKey(generateSessionKey());
  const message = revokeSessionMsg({ owner: OWNER, session });
  assert.equal(message.typeUrl, '/qorechain.abstractaccount.v1.MsgRevokeAuthenticator');
  assert.deepEqual(message.value.pubkey, session.publicKey);
  assert.equal(message.value.owner, accountForms(OWNER).qor);
});

test('a refused execution is reported as refused even though its transaction has code 0', () => {
  const events = (list) => list.map(([type, attributes]) => ({ type, attributes: Object.entries(attributes).map(([key, value]) => ({ key, value })) }));
  const tx = (list) => ({ hash: 'AB', height: '9', hybrid: true, events: events(list), find: (type) => events(list).filter((event) => event.type === type).map((event) => Object.fromEntries(event.attributes.map(({ key, value }) => [key, value]))) });
  const refused = executionOutcome(tx([['abstractaccount_execution_failed', { account: 'qor1…', lane: 'evm', nonce: '2', reason: 'evm call not allowed by spending rule' }]]));
  assert.deepEqual([refused.success, refused.reason], [false, 'evm call not allowed by spending rule']);
  const ok = executionOutcome(tx([['ethereum_tx', { ethereumTxHash: '0x' + 'ab'.repeat(32) }]]));
  assert.deepEqual([ok.success, ok.evmHash], [true, '0x' + 'ab'.repeat(32)]);
});

test('account forms: 0x and qor1 are the same 20 bytes', () => {
  const { evm, qor } = accountForms(OWNER);
  assert.equal(qor, 'qor1svj82gkc7d6esyguav95anrvf3n500kz7zglfn');
  assert.equal(accountForms(qor).evm, evm);
  assert.throws(() => accountForms('cosmos1xyz'), /Expected/);
});
