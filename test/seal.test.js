// Private deliveries with QoreSeal (ML-KEM-1024 + X25519): only the client can open the work,
// and an envelope opens only for the treaty and unit it was sealed for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveSealKeys, generateSealKeys, parseEnvelope, envelopeFromText } from '@qorechain/qoreseal';
import { deliverableHash } from '../src/protocol.js';
import { openDelivery, parseSealKey, sealDelivery, sealKeysFor, sealKeyText, sealRecipient } from '../sdk/seal.js';

const mnemonic = 'test test test test test test test test test test test junk';
const scope = { signingChain: 'qorechain-diana', contract: '0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6', id: 3n, unit: 1n };
const work = new TextEncoder().encode(JSON.stringify({ survey: 'north', rows: 1200, nulls: 0 }));

test('seal keys are QoreSeal’s standard derivation from a mnemonic, and stable from a private key', () => {
  const keys = sealKeysFor({ mnemonic, accountIndex: 0 });
  assert.deepEqual(keys.mlkemPublicKey, deriveSealKeys({ mnemonic, index: 0 }).mlkemPublicKey);
  assert.notDeepEqual(keys.mlkemPublicKey, sealKeysFor({ mnemonic, accountIndex: 1 }).mlkemPublicKey);
  const privateKey = '0x' + '11'.repeat(32);
  assert.deepEqual(sealKeysFor({ privateKey }).mlkemPublicKey, sealKeysFor({ privateKey }).mlkemPublicKey);
  assert.notDeepEqual(sealKeysFor({ privateKey }).mlkemPublicKey, sealKeysFor({ privateKey: '0x' + '22'.repeat(32) }).mlkemPublicKey);
});

test('the client opens what the provider sealed with its shared key, and the hash matches the chain', async () => {
  const client = sealKeysFor({ mnemonic });
  const { recipient, mode } = await sealRecipient(sealKeyText(client), {});
  assert.equal(mode, 'hybrid');
  const envelope = sealDelivery({ plaintext: work, recipient, mode, ...scope });
  assert.match(envelope, /^qoreseal:/);
  const parsed = parseEnvelope(envelopeFromText(envelope));
  assert.equal(parsed.mode, 'hybrid');
  assert.equal(parsed.entries.length, 1);
  // The plaintext is not in the envelope.
  assert.equal(Buffer.from(envelopeFromText(envelope)).includes(Buffer.from('north')), false);
  const opened = openDelivery({ envelope, keys: client, ...scope });
  assert.deepEqual(opened, work);
  assert.equal(deliverableHash(opened), deliverableHash(work));
});

test('nobody else can open a delivery, and it opens only as the treaty and unit it was sealed for', async () => {
  const client = sealKeysFor({ mnemonic });
  const { recipient, mode } = await sealRecipient(sealKeyText(client), {});
  const envelope = sealDelivery({ plaintext: work, recipient, mode, ...scope });
  assert.throws(() => openDelivery({ envelope, keys: generateSealKeys(), ...scope }), (error) => error.code === 'NOT_A_RECIPIENT' || error.code === 'DECRYPTION_FAILED');
  assert.throws(() => openDelivery({ envelope, keys: client, ...scope, unit: 2n }));
  assert.throws(() => openDelivery({ envelope, keys: client, ...scope, id: 4n }));
  assert.throws(() => openDelivery({ envelope, keys: client, ...scope, contract: '0x' + '00'.repeat(20) }));
  assert.throws(() => openDelivery({ envelope, keys: client, ...scope, signingChain: 'qorechain-vladi' }));
});

test('ML-KEM-1024 alone works too, as with a key read from the chain’s KEM registry', () => {
  const client = sealKeysFor({ mnemonic });
  const envelope = sealDelivery({ plaintext: work, recipient: { mlkemPublicKey: client.mlkemPublicKey }, mode: 'mlkem', ...scope });
  assert.equal(parseEnvelope(envelopeFromText(envelope)).mode, 'mlkem');
  assert.deepEqual(openDelivery({ envelope, keys: client, ...scope }), work);
});

test('a malformed or foreign seal key is refused before anything is sealed', () => {
  assert.throws(() => parseSealKey('qor1abc'), /not a Treaty seal key/);
  assert.throws(() => parseSealKey('treaty-seal-key:AAAA'), /ML-KEM-1024 key and an X25519 key/);
  const text = sealKeyText(sealKeysFor({ mnemonic }));
  assert.equal(parseSealKey(text).mlkemPublicKey.length, 1568);
});
