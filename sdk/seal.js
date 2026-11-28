// Private deliveries with QoreSeal: the provider encrypts the work to the client with
// ML-KEM-1024 (FIPS 203), so only the client can read it. The contract still records only the
// hash of the plaintext, so after opening, the client checks the work against the chain.
//
//   const key = client.sealKey();                                  // share this text with providers
//   const { envelope } = await provider.deliver(id, work, { sealTo: key });
//   const work = await client.openDelivery(id, unit, envelope);    // refuses if the hash differs
import {
  deriveSealKeys, envelopeFromText, envelopeToText, open, recipientOf, seal, sealKeysFromSeed,
  validateMlkemPublicKey, validateX25519PublicKey,
} from '@qorechain/qoreseal';
import { fetchMlkemPublicKey } from '@qorechain/qoreseal/network';
import { shake256 } from '@qorechain/pqc';
import { base64urlnopad } from '@scure/base';
import { hexToBytes, stringToBytes } from 'viem';

/** QoreSeal's `purpose` for Treaty deliveries: an envelope for anything else will not open as one. */
export const SEAL_PURPOSE = 'treaty-delivery';
const KEY_PREFIX = 'treaty-seal-key:';
const MLKEM_KEY_LENGTH = 1568;

/**
 * The account's QoreSeal keys. From a mnemonic they are QoreSeal's standard derivation, so any
 * QoreSeal tool can open the same envelopes. From a private key, the seed is
 * SHAKE-256("treaty:qoreseal:v1|" + key), so the same key always gives the same seal keys.
 */
export function sealKeysFor({ mnemonic, accountIndex = 0, privateKey }) {
  if (mnemonic) return deriveSealKeys({ mnemonic, index: Number(accountIndex) });
  if (!privateKey) throw new Error('Seal keys need a mnemonic or a private key.');
  const seed = shake256(new Uint8Array([...stringToBytes('treaty:qoreseal:v1|'), ...hexToBytes(privateKey)]), 32);
  return sealKeysFromSeed(seed);
}

/** The public half of seal keys as one line of text a client can share with its providers. */
export function sealKeyText(keys) {
  return KEY_PREFIX + base64urlnopad.encode(new Uint8Array([...keys.mlkemPublicKey, ...keys.x25519PublicKey]));
}

/** Read a shared seal key. Checks both keys the way the chain and QoreSeal do. */
export function parseSealKey(text) {
  if (typeof text !== 'string' || !text.startsWith(KEY_PREFIX)) throw new Error('This is not a Treaty seal key (it starts with "' + KEY_PREFIX + '").');
  const bytes = base64urlnopad.decode(text.slice(KEY_PREFIX.length).trim());
  if (bytes.length !== MLKEM_KEY_LENGTH + 32) throw new Error('A Treaty seal key holds an ML-KEM-1024 key and an X25519 key.');
  const recipient = recipientOf({ mlkemPublicKey: bytes.slice(0, MLKEM_KEY_LENGTH), x25519PublicKey: bytes.slice(MLKEM_KEY_LENGTH) });
  validateMlkemPublicKey(recipient.mlkemPublicKey);
  validateX25519PublicKey(recipient.x25519PublicKey);
  return recipient;
}

/**
 * Who to seal to. A shared seal key gives the hybrid mode (ML-KEM-1024 + X25519); `'chain'`
 * reads the client's ML-KEM-1024 key from QoreChain's KEM key registry and seals with it alone.
 */
export async function sealRecipient(sealTo, { rest, client }) {
  if (sealTo === 'chain') {
    return { recipient: { mlkemPublicKey: await fetchMlkemPublicKey({ rest, address: client }) }, mode: 'mlkem' };
  }
  const recipient = typeof sealTo === 'string' ? parseSealKey(sealTo) : sealTo;
  return { recipient, mode: recipient.x25519PublicKey ? 'hybrid' : 'mlkem' };
}

/** Binds an envelope to one delivery, so it cannot be presented as another treaty's or unit's work. */
export function deliveryBinding({ contract, id, unit }) {
  return stringToBytes('treaty ' + contract.toLowerCase() + ' #' + BigInt(id) + ' unit ' + BigInt(unit));
}

/** Encrypt `plaintext` to the recipient. Returns the envelope as text (`qoreseal:…`). */
export function sealDelivery({ plaintext, recipient, mode, signingChain, ...binding }) {
  const envelope = seal({
    chainId: signingChain, purpose: SEAL_PURPOSE, recipients: [recipient], plaintext, mode,
    aad: deliveryBinding(binding),
  });
  return envelopeToText(envelope);
}

/** Decrypt an envelope with the client's keys. Throws if it was not sealed to them, or for another delivery. */
export function openDelivery({ envelope, keys, signingChain, ...binding }) {
  return open({
    chainId: signingChain, purpose: SEAL_PURPOSE, keys, aad: deliveryBinding(binding),
    envelope: typeof envelope === 'string' ? envelopeFromText(envelope.trim()) : envelope,
  });
}
