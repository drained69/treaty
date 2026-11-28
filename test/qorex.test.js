// The web app's QoreX signing against the official QoreX test double (@qorechain/qorex-wallet-mock),
// and its ML-DSA-87 signatures checked with the official @qorechain/pqc library: the bytes QoreX
// signs must be exactly the bytes Treaty's contract checks with pqcVerify.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQorexMock } from '@qorechain/qorex-wallet-mock';
import { mldsa87, shake256 } from '@qorechain/pqc';
import { bech32 } from '@scure/base';
import { bytesToHex, getAddress, hexToBytes } from 'viem';
import { deliveryMessage } from '../src/protocol.js';
import { qorexAccount, qorexAvailable, qorexStatus, signWithQorex } from '../src/qorex.js';

const mnemonic = 'test test test test test test test test test test test junk';
const chainId = 'qorechain-diana';
const contract = '0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6';

/** A browser window with the official QoreX mock injected, as QoreX injects itself. */
function browserWith(profile) {
  const window = Object.assign(new EventTarget(), { CustomEvent });
  createQorexMock({ profile, mnemonic, chainId }).install(window);
  globalThis.window = window;
  return window;
}

/** The canonical ML-DSA-87 key QoreX derives for an account, as the QoreChain docs specify. */
function canonicalPqcKey(qorAddress) {
  const seed = shake256(new TextEncoder().encode('qorechain:pqc:v1|' + qorAddress + '|' + mnemonic), 32);
  return mldsa87.keygen(seed).publicKey;
}

test('without QoreX, the app offers to install it', () => {
  globalThis.window = new EventTarget();
  assert.equal(qorexAvailable(), false);
  assert.equal(qorexStatus(), 'not-installed');
});

test('today’s QoreX cannot sign messages, so the app hides QoreX signing and explains why', async () => {
  const window = browserWith('current');
  assert.equal(qorexAvailable(), false);
  assert.equal(qorexStatus(), 'cannot-sign-messages');
  await assert.rejects(qorexAccount(chainId), /cannot sign messages yet/);
  // The wallet itself refuses before any prompt, as @qorechain/qorex-types documents.
  await assert.rejects(window.qorex.native.signArbitrary(chainId, 'qor1x', 'Treaty: x'), /signArbitrary not yet supported/);
});

test('a QoreX that signs messages produces signatures Treaty’s contract accepts', async () => {
  const window = browserWith('planned');
  // The planned build signs messages; a release that ships it announces the capability.
  window.qorex.native.capabilities.push('signArbitrary');
  assert.equal(qorexStatus(), 'ready');

  const account = await qorexAccount(chainId);
  const { words } = bech32.decode(account.qorAddress);
  assert.equal(account.address, getAddress(bytesToHex(bech32.fromWords(words))));

  const message = deliveryMessage({
    chainId: 9800n, contract, signingChain: chainId,
    id: 3n, unit: 0n, provider: account.address, deliverable: '0x' + 'ab'.repeat(32),
  });
  const { signature, signer } = await signWithQorex(message, { chainId, signingChain: chainId, expected: account.address });
  assert.equal(signer, account.address);
  // What pqcVerify checks on chain: the registered key, over the exact message bytes.
  assert.ok(mldsa87.verify(canonicalPqcKey(account.qorAddress), hexToBytes(message), hexToBytes(signature)));
  // A changed message does not verify.
  assert.equal(mldsa87.verify(canonicalPqcKey(account.qorAddress), hexToBytes(message + '00'), hexToBytes(signature)), false);
});

test('QoreX on the wrong account is refused before anything is signed', async () => {
  const window = browserWith('planned');
  window.qorex.native.capabilities.push('signArbitrary');
  const message = deliveryMessage({
    chainId: 9800n, contract, signingChain: chainId,
    id: 3n, unit: 0n, provider: contract, deliverable: '0x' + 'ab'.repeat(32),
  });
  await assert.rejects(signWithQorex(message, { chainId, signingChain: chainId, expected: contract }), /Switch QoreX to the account/);
});
