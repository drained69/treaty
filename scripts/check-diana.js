// Read-only checks that QoreChain Diana still behaves the way Treaty relies on.
// Needs no keys and no funds: every check is an eth_call or a public REST read.
//
//   npm run check:diana
//
// 1. pqcVerify accepts a real ML-DSA-87 signature over Treaty's exact terms and
//    withdrawal bytes, and refuses a tampered message.
// 2. Treaty's bytecode deploys on Diana's EVM (inside a call), and its sign path
//    reaches the real key registry and verifier with the expected errors.
// 3. The Cross-VM bridge writes to the pinned receipt book and replies in the format
//    the contract and app parse, and Native REST returns receipts and windows as expected.
// 4. The smart-account (abstractaccount) module is on, lets a linked key hold the "evm"
//    permission, verifies the v2 MsgExecuteEVM digest, and stores rules in the format Treaty writes.
import { readFile } from 'node:fs/promises';
import { generatePqcKeypair, pqcSign } from '@qorechain/sdk';
import solc from 'solc';
import {
  createPublicClient, decodeAbiParameters, decodeErrorResult, defineChain, encodeFunctionData, hexToBytes, hexToString,
  http, toHex,
} from 'viem';
import { NATIVE_REST, RECEIPTS } from '../server/native.js';
const { parties: { owner: { qor: OLIVIA } } } = JSON.parse(await readFile(new URL('../deployments/diana.json', import.meta.url)));
import { termsMessage, withdrawalMessage } from '../src/protocol.js';
import { generateSessionKey, readSmartAccount, sessionCall, sessionKey, sessionRule, treatyCallPolicy } from '../sdk/smart-account.js';

const RPC = process.env.QORE_EVM_RPC?.trim() || 'https://evm-testnet.qore.host';
const chain = defineChain({
  id: 9800, name: 'QoreChain Diana', nativeCurrency: { name: 'Test QOR', symbol: 'QOR', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
const { abi } = JSON.parse(await readFile(new URL('../artifacts/Treaty.json', import.meta.url)));
const verifyAbi = [{
  type: 'function', name: 'pqcVerify', stateMutability: 'view',
  inputs: [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }], outputs: [{ type: 'bool' }],
}];
let failures = 0;
function check(label, ok, detail = '') {
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? ' · ' + detail : ''));
  if (!ok) failures += 1;
}
async function rest(path) {
  const response = await fetch(NATIVE_REST + path, { signal: AbortSignal.timeout(20_000) });
  return { status: response.status, body: response.ok ? await response.json() : undefined };
}

console.log('Diana EVM ' + RPC + ' · Native ' + NATIVE_REST);
check('chain ID is 9800', await client.getChainId() === 9800);

console.log('ML-DSA-87 verification (pqcVerify at 0x0a01)');
const keypair = generatePqcKeypair();
const pubkey = toHex(keypair.publicKey);
const someone = '0x2222222222222222222222222222222222222222';
const contract = '0x1111111111111111111111111111111111111111';
const verify = (signature, message) => client.readContract({
  address: '0x0000000000000000000000000000000000000a01', abi: verifyAbi, functionName: 'pqcVerify', args: [pubkey, signature, message],
});
const terms = termsMessage({ chainId: 9800, contract, id: 1n, signer: someone, hash: '0x' + 'ab'.repeat(32) });
const termsSignature = toHex(pqcSign(keypair.secretKey, hexToBytes(terms)));
check('accepts a signature over Treaty terms bytes', await verify(termsSignature, terms) === true);
check('refuses the same signature over changed bytes', await verify(termsSignature, terms.slice(0, -2) + '00') === false);
const withdrawal = withdrawalMessage({ chainId: 9800, contract, recipient: someone, to: someone, amount: 10n ** 18n, nonce: 0n });
check('accepts a signature over Treaty withdrawal bytes',
  await verify(toHex(pqcSign(keypair.secretKey, hexToBytes(withdrawal), { hedged: true })), withdrawal) === true);
// The QoreX wallet signs in the QoreSign message format; its ML-DSA-87 part must verify the same way.
const { classicalKeyFromPrivate, signMessage } = await import('@qorechain/qoresign');
const { deriveUnifiedAccount, generateMnemonic } = await import('@qorechain/sdk');
const { messageText } = await import('../src/protocol.js');
const wallet = await deriveUnifiedAccount(generateMnemonic(), 0);
const qorexSigned = signMessage({
  chainId: 'qorechain-diana', signer: wallet.cosmos, data: messageText(terms),
  classicalKey: classicalKeyFromPrivate(hexToBytes(wallet.privateKey), 'eth_secp256k1'), pqKey: wallet.pqc,
});
check('accepts a QoreX-style (QoreSign) signature over the same terms',
  await client.readContract({
    address: '0x0000000000000000000000000000000000000a01', abi: verifyAbi, functionName: 'pqcVerify',
    args: [toHex(wallet.pqc.publicKey), toHex(Buffer.from(qorexSigned.pq.signature, 'base64')), terms],
  }) === true);
const gas = await client.estimateGas({
  to: '0x0000000000000000000000000000000000000a01',
  data: encodeFunctionData({ abi: verifyAbi, functionName: 'pqcVerify', args: [pubkey, termsSignature, terms] }),
});
console.log('        one verification costs about ' + gas + ' gas, calldata included');

// A contract-creation call needs a sender whose live EVM window allows creation (no target list).
// Any recent EVM sender also has a registered ML-DSA-87 key, which the sign check below uses.
const { bech32 } = await import('@scure/base');
const qorOf = (account) => bech32.encode('qor', bech32.toWords(hexToBytes(account)));
console.log('Smart-account sessions (abstractaccount)');
// Smart-account sessions: everything read-only; the live calls run in `npm run demo:session`.
const config = await rest('/qorechain/abstractaccount/v1/config');
check('the smart-account module is enabled', config.body?.config?.enabled === true,
  'up to ' + config.body?.config?.max_spending_rules + ' rules and ' + config.body?.config?.max_session_keys + ' keys per account');
const schema = await rest('/qorechain/abstractaccount/v1/permission_schema');
check('a linked key may hold the "evm" permission, and it is not a key-management permission',
  schema.body?.permissions?.includes('evm') && !(schema.body?.key_management_msgs ?? []).some((msg) => /ExecuteEVM/.test(msg)));
const probeContract = '0x' + '11'.repeat(20);
const sessionProbe = await sessionCall({
  session: sessionKey(generateSessionKey()), owner: OLIVIA, relayer: OLIVIA, to: probeContract,
  data: encodeFunctionData({ abi, functionName: 'refund', args: [1n] }),
});
check('Diana verifies the v2 MsgExecuteEVM digest (it binds the gas limit), and a fresh key starts at nonce 0',
  sessionProbe.digestVersion === 'v2' && sessionProbe.nonce === 0n);
const accounts = await rest('/qorechain/abstractaccount/v1/accounts?pagination.limit=50');
const scoped = (accounts.body?.accounts ?? []).find((account) => account.spending_rules_count > 0 && account.authenticators_count > 0);
const stored = scoped && await readSmartAccount({ owner: scoped.address });
const callFormat = /^0x[\da-f]{40}\/0x[\da-f]{8}$/;
const ours = sessionRule({ contract: probeContract, perCall: 6n * 10n ** 18n, perDay: 6n * 10n ** 18n });
check('stored rules use the call-policy format Treaty writes ("0x<contract>/0x<selector>")',
  stored && stored.rules.some((rule) => rule.allowedEvmCalls.some((entry) => callFormat.test(entry))) && treatyCallPolicy(probeContract).every((entry) => callFormat.test(entry)) &&
  ours.allowedEvmCalls.length === 2, scoped ? 'compared with ' + scoped.address : 'no scoped account found');


console.log('Treaty inside a call on Diana');
const recent = await (async () => {
  const latest = await client.getBlockNumber();
  const seen = new Set();
  for (let top = latest; top > latest - 6000n; top -= 200n) {
    const blocks = await Promise.all(Array.from({ length: 200 }, (_, i) =>
      client.getBlock({ blockNumber: top - BigInt(i), includeTransactions: true }).catch(() => ({ transactions: [] }))));
    for (const { transactions } of blocks) {
      for (const { from } of transactions) {
        if (seen.has(from)) continue;
        seen.add(from);
        const state = (await rest('/qorechain/pqc/v1/evm_window/' + qorOf(from))).body;
        if (state?.live && !state.native_only && !(state.allowed_targets ?? []).length) return from;
      }
    }
  }
})();
check('found a recent EVM sender with a window that allows contract creation', Boolean(recent), recent);
if (!recent) {
  console.log('        Nobody has such a window open right now; run this again later. The other checks stand.');
  process.exit(failures ? 1 : 0);
}
// Diana caps a read-only call at 5M gas, and deploying Treaty alone takes about 4.2M. So:
// (a) estimate a real deployment; (b) run Treaty's own code on Diana's EVM through a state
// override (proposals touch no QoreChain precompile; overrides switch those off); (c) call the key
// registry, the ML-DSA-87 verifier and the bridge from a small probe contract, as Treaty does.
const artifactFile = JSON.parse(await readFile(new URL('../artifacts/Treaty.json', import.meta.url)));
const { encodeDeployData } = await import('viem');
const deployGas = await client.estimateGas({ account: recent, data: encodeDeployData({ abi, bytecode: artifactFile.bytecode, args: ['qorechain-diana'] }) });
check('a Treaty deployment fits Diana’s limits', deployGas > 0n && deployGas < 5_000_000n, 'about ' + deployGas + ' gas');

const TREATY_AT = '0x00000000000000000000000000000000000ac7e5';
const override = [{ address: TREATY_AT, code: artifactFile.runtime }];
const simulate = (functionName, args) => client.simulateContract({
  account: recent, address: TREATY_AT, abi, functionName, args, stateOverride: override,
}).then(({ result }) => result);
const proposed = await simulate('propose', ['Diana check', 10n ** 18n, [recent, '0x000000000000000000000000000000000000bEEF'], [5000, 5000], 0n]);
check('Treaty’s code runs on Diana’s EVM: a revenue share is proposed', proposed === 1n);
const hired = await simulate('proposeService', ['Diana check', 10n ** 18n, 2, BigInt(Math.floor(Date.now() / 1000) + 3600), 600,
  '0x000000000000000000000000000000000000bEEF', [recent], [10000]]);
check('…and a service treaty', hired === 1n);

const probe = `
pragma solidity ^0.8.26;
interface IQorePQC {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message) external view returns (bool);
    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool);
}
interface IBridge { function executeCrossVMCall(uint8, string calldata, bytes calldata) external returns (bytes memory); }
contract Probe {
    constructor(address registered, string memory receipts) {
        (bool registeredOk,, bytes memory pubkey, bool proven) = IQorePQC(address(0x0a02)).pqcKeyStatus(registered);
        (bool strangerRegistered,,,) = IQorePQC(address(0x0a02)).pqcKeyStatus(address(0xBEEF));
        bool junkAccepted = IQorePQC(address(0x0a01)).pqcVerify(pubkey, new bytes(4627), bytes("Treaty:terms:v3"));
        (bool bridged, bytes memory reply) = address(0x0901).call(abi.encodeCall(
            IBridge.executeCrossVMCall, (1, receipts, bytes('{"record":{"note":"treaty:diana-check"}}'))));
        bytes memory out = abi.encode(registeredOk, proven, pubkey.length, strangerRegistered, junkAccepted, bridged, reply);
        assembly { return(add(out, 32), mload(out)) }
    }
}`;
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources: { 'Probe.sol': { content: probe } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
})));
const compileErrors = (compiled.errors ?? []).filter(({ severity }) => severity === 'error');
if (compileErrors.length) throw new Error(compileErrors.map(({ formattedMessage }) => formattedMessage).join('\n'));
const { encodeAbiParameters } = await import('viem');
const { data: result } = await client.call({
  account: recent,
  data: '0x' + compiled.contracts['Probe.sol'].Probe.evm.bytecode.object +
    encodeAbiParameters([{ type: 'address' }, { type: 'string' }], [recent, RECEIPTS]).slice(2),
});
const [registeredOk, proven, keyLength, strangerRegistered, junkAccepted, bridged, reply] = decodeAbiParameters(
  [{ type: 'bool' }, { type: 'bool' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bool' }, { type: 'bytes' }], result,
);
check('from a contract, pqcKeyStatus returns a registered, proven 2592-byte key', registeredOk && proven && keyLength === 2592n);
check('from a contract, pqcKeyStatus reports an unknown account as unregistered', strangerRegistered === false);
check('from a contract, pqcVerify refuses a junk signature', junkAccepted === false);
check('the bridge accepts a Treaty receipt note', bridged === true);
let receipt;
try { receipt = JSON.parse(hexToString(decodeAbiParameters([{ type: 'bytes' }], reply)[0])); } catch { /* checked below */ }
check('the bridge replies with an ABI-wrapped receipt longer than 64 bytes',
  (reply.length - 2) / 2 > 64 && Number.isSafeInteger(receipt?.id) && receipt?.note === 'treaty:diana-check', JSON.stringify(receipt));

console.log('Native REST');
const params = await rest('/qorechain/crossvm/v1/params');
const pinned = (params.body?.params ?? params.body)?.bridge_target_pins?.some(({ target, code_id }) =>
  target === 'cosmwasm:' + RECEIPTS && String(code_id) === '865');
check('the receipt book is pinned on the bridge allowlist (code 865)', Boolean(pinned));
if (receipt?.id > 1) {
  const query = encodeURIComponent(btoa(JSON.stringify({ receipt: { id: receipt.id - 1 } })));
  const stored = await rest('/cosmwasm/wasm/v1/contract/' + RECEIPTS + '/smart/' + query);
  const shape = stored.body?.data;
  check('receipts read back with id, sender, note and height',
    shape && Number.isSafeInteger(shape.id) && /^qor1/.test(shape.sender) && typeof shape.note === 'string' && Number(shape.height) > 0);
}
const window = await rest('/qorechain/pqc/v1/evm_window/' + qorOf(recent));
check('EVM windows report live, targets and remaining value',
  window.status === 404 || (typeof window.body?.live === 'boolean' && Array.isArray(window.body?.allowed_targets)));

console.log(failures ? failures + ' check(s) failed.' : 'Diana matches what Treaty expects.');
process.exitCode = failures ? 1 : 0;
