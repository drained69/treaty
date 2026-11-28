// Post-quantum signing for Treaty, with the official QoreChain SDK.
// Browser wallets cannot produce ML-DSA-87 signatures over arbitrary bytes yet
// (QoreX refuses signArbitrary), so the signatures are made here, on your computer.
import { deriveUnifiedAccount, generatePqcKeypair, pqcSign, pqcVerify, unifiedAccountFromSeed } from '@qorechain/sdk';
import { bytesToHex, getAddress, hexToBytes } from 'viem';
import { sealKeysFor } from './seal.js';

export const PQC_KEYS = '0x0000000000000000000000000000000000000a02';
export const pqcKeysAbi = [{
  type: 'function', name: 'pqcKeyStatus', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [
    { name: 'registered', type: 'bool' }, { name: 'algorithmId', type: 'uint8' },
    { name: 'pubkey', type: 'bytes' }, { name: 'possessionProven', type: 'bool' },
  ],
}];

/**
 * The account in the environment: QORE_MNEMONIC (with QORE_ACCOUNT_INDEX), or
 * PRIVATE_KEY with QORE_PQC_RECOVERY_CODE. The same inputs the QoreChain workshop
 * tools use, so the ML-DSA-87 key matches the one registered on chain.
 */
export async function loadSigner(env = process.env) {
  const mnemonic = env.QORE_MNEMONIC?.trim();
  let account;
  let index = 0;
  if (mnemonic) {
    index = Number(env.QORE_ACCOUNT_INDEX ?? 0);
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('QORE_ACCOUNT_INDEX must be a whole number.');
    account = await deriveUnifiedAccount(mnemonic, index);
  } else {
    const key = env.PRIVATE_KEY?.trim();
    const recoveryCode = env.QORE_PQC_RECOVERY_CODE?.trim();
    if (!/^0x[\da-fA-F]{64}$/.test(key ?? '') || !recoveryCode) {
      throw new Error('Set QORE_MNEMONIC, or PRIVATE_KEY and QORE_PQC_RECOVERY_CODE, in .env.');
    }
    account = unifiedAccountFromSeed(hexToBytes(key), { recoveryCode });
  }
  return {
    address: getAddress(account.evm),
    qorAddress: account.cosmos,
    privateKey: account.privateKey,
    publicKey: account.pqc.publicKey,
    sign: (messageHex) => bytesToHex(pqcSign(account.pqc.secretKey, hexToBytes(messageHex))),
    /** The full hybrid account, for Native-lane transactions (for example relaying a smart-account call). */
    unified: account,
    /** QoreSeal (ML-KEM-1024 + X25519) keys for private deliveries; see seal.js. */
    sealKeys: () => sealKeysFor(mnemonic ? { mnemonic, accountIndex: index } : { privateKey: account.privateKey }),
  };
}

/** A signer with a fresh, unregistered ML-DSA-87 key: what an attacker holding only the classical key has. */
export function forgerFor(address) {
  const keypair = generatePqcKeypair();
  return { address, sign: (messageHex) => bytesToHex(pqcSign(keypair.secretKey, hexToBytes(messageHex))) };
}

export function verifyLocally(publicKey, messageHex, signatureHex) {
  return pqcVerify(publicKey, hexToBytes(messageHex), hexToBytes(signatureHex));
}

/** Read the key the chain's registry holds for `address` through the pqcKeyStatus precompile. */
export async function registeredKey(client, address) {
  const [registered, , pubkey, proven] = await client.readContract({
    address: PQC_KEYS, abi: pqcKeysAbi, functionName: 'pqcKeyStatus', args: [address],
  });
  return { registered, proven, pubkey };
}
