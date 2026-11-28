import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import solc from 'solc';
import {
  BaseError, ContractFunctionRevertedError, concatHex, createPublicClient, createWalletClient, custom,
  decodeAbiParameters, decodeEventLog, getAddress, hexToBytes, hexToString, keccak256, parseEther, stringToHex, toHex,
} from 'viem';
import { foundry } from 'viem/chains';
import {
  budgetOf, deliverableHash, deliveryCommitment, deliveryMessage, deliveryNote, mandateMessage, reviewMessage,
  agreementCommitment, parseSignedRequest, paymentCommitment, paymentId, paymentNote, requiredSigners,
  signedRequest, splitAmounts, termsHash, termsMessage, termsNote, withdrawalMessage,
} from '../src/protocol.js';
import { forgerFor, verifyLocally } from '../sdk/pqc.js';
import { generatePqcKeypair, pqcSign } from '@qorechain/sdk';
import { mldsa87 } from '@qorechain/pqc';

process.env.HARDHAT_CONFIG = new URL('./hardhat.config.cjs', import.meta.url).pathname;
const { default: hre } = await import('hardhat');

const BRIDGE = '0x0000000000000000000000000000000000000901';
const PQC_VERIFY = '0x0000000000000000000000000000000000000a01';
const PQC_KEYS = '0x0000000000000000000000000000000000000a02';
const RECEIPTS = 'qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8';
const CHAIN_ID = 31337;
const { abi, bytecode, runtime } = JSON.parse(await readFile(new URL('../artifacts/Treaty.json', import.meta.url)));

// Stand-ins for QoreChain's precompiles, which a local EVM does not have (the same
// approach as the QoreChain workshop vault). A stand-in "signature" is valid when it
// equals keccak256("ok" ‖ pubkey ‖ message); the real ML-DSA-87 check runs on Diana,
// and the last test checks the real signing path against the contract's exact bytes.
const mockSource = `
pragma solidity ^0.8.26;
contract PqcMock {
    struct Key { bool registered; bool proven; bytes pubkey; }
    mapping(address => Key) private keys;
    function setKey(address account, bool registered, bool proven, bytes calldata pubkey) external {
        keys[account] = Key(registered, proven, pubkey);
    }
    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        Key storage key = keys[account];
        return (key.registered, 1, key.pubkey, key.proven);
    }
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external pure returns (bool)
    {
        return keccak256(signature) == keccak256(abi.encodePacked(keccak256(abi.encodePacked("ok", pubkey, message))));
    }
}
contract BridgeMock {
    bool public rejects;
    bool public emptyReply;
    uint256 public records;
    event NativeRecord(bytes payload);
    function setRejects(bool next) external { rejects = next; }
    function setEmptyReply(bool next) external { emptyReply = next; }
    function executeCrossVMCall(uint8 vm, string calldata target, bytes calldata payload)
        external returns (bytes memory)
    {
        require(vm == 1 && keccak256(bytes(target)) == keccak256(bytes("${RECEIPTS}")));
        ++records;
        emit NativeRecord(payload);
        require(!rejects, "Native receipt refused");
        if (emptyReply) return bytes("");
        return bytes('{"id":7,"sender":"qor1contract","note":"n","height":1}');
    }
}
contract RejectingReceiver {
    receive() external payable { revert("no"); }
}
`;
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'Mock.sol': { content: mockSource } },
  settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
}))).contracts['Mock.sol'];

let publicClient;
let wallet;
let contract;
let deployer, alice, bob, carol, dave, erin, payer, relayer, mallory;
// Agents and their human owners, for service treaties and mandates.
let buyer, owner, seller, helper, agentB;

const pubkeyOf = (account) => keccak256(concatHex([toHex('pk'), account]));
const mockSign = (pubkey, message) => keccak256(concatHex([toHex('ok'), pubkey, message]));
const signAs = (account, message) => mockSign(pubkeyOf(account), message);

const read = (functionName, args = []) => publicClient.readContract({ address: contract, abi, functionName, args });

async function send(account, functionName, args = [], value) {
  const hash = await wallet.writeContract({ address: contract, abi, account, functionName, args, value, gas: 3_000_000n });
  return publicClient.waitForTransactionReceipt({ hash });
}

async function sendOk(account, functionName, args = [], value) {
  const receipt = await send(account, functionName, args, value);
  assert.equal(receipt.status, 'success', functionName + ' reverted');
  return receipt;
}

async function reverts(account, functionName, args, errorName, value) {
  try {
    await publicClient.simulateContract({ address: contract, abi, account, functionName, args, value });
  } catch (error) {
    const revert = error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    assert.ok(revert, 'expected a contract revert, got: ' + error.message);
    assert.equal(revert.data?.errorName ?? revert.reason, errorName);
    return;
  }
  assert.fail(functionName + ' should revert with ' + errorName);
}

function events(receipt, eventAbi = abi, from = contract) {
  return receipt.logs.filter((log) => log.address.toLowerCase() === from.toLowerCase()).map((log) => {
    try { return decodeEventLog({ abi: eventAbi, ...log }); } catch { return undefined; }
  }).filter(Boolean);
}
const eventNamed = (receipt, name) => events(receipt).find((event) => event.eventName === name)?.args;

async function setCode(address, code) {
  await publicClient.request({ method: 'hardhat_setCode', params: [address, '0x' + code] });
}

async function setKey(account, registered = true, proven = true, pubkey = pubkeyOf(account)) {
  const hash = await wallet.writeContract({
    address: PQC_KEYS, abi: compiled.PqcMock.abi, account: deployer, functionName: 'setKey',
    args: [account, registered, proven, registered ? pubkey : '0x'],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function bridgeSet(functionName, value) {
  const hash = await wallet.writeContract({
    address: BRIDGE, abi: compiled.BridgeMock.abi, account: deployer, functionName, args: [value],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}
const bridgeRecords = () => publicClient.readContract({ address: BRIDGE, abi: compiled.BridgeMock.abi, functionName: 'records' });

async function propose(terms, from = deployer) {
  const receipt = await sendOk(from, 'propose', [terms.title, terms.price, terms.recipients, terms.shares, terms.previous ?? 0n]);
  return eventNamed(receipt, 'Proposed').id;
}

async function signTerms(id, signer, submitter = relayer) {
  const message = await read('termsMessage', [id, signer]);
  return sendOk(submitter, 'sign', [id, signer, signAs(signer, message)]);
}

async function activate(terms) {
  const id = await propose(terms);
  const agreement = await read('getAgreement', [id]);
  let receipt;
  for (const signer of agreement.signers) receipt = await signTerms(id, signer);
  return { id, receipt };
}

async function signWithdrawal(recipient, to, amount, signer = recipient) {
  const nonce = await read('nonces', [recipient]);
  return signAs(signer, await read('withdrawalMessage', [recipient, to, amount, nonce]));
}

before(async () => {
  // Hardhat reports reverts without the JSON-RPC code viem reads, so add it.
  const transport = custom({
    async request(args) {
      try {
        return await hre.network.provider.request(args);
      } catch (error) {
        if (typeof error.data === 'string') throw Object.assign(new Error(error.message), { code: 3, data: error.data });
        throw error;
      }
    },
  });
  publicClient = createPublicClient({ chain: foundry, transport });
  wallet = createWalletClient({ chain: foundry, transport });
  const all = (await wallet.getAddresses()).map((account) => getAddress(account));
  [deployer, alice, bob, carol, dave, erin, payer, relayer, mallory, buyer, owner, seller, helper, agentB] = all;
  await setCode(PQC_VERIFY, compiled.PqcMock.evm.deployedBytecode.object);
  await setCode(PQC_KEYS, compiled.PqcMock.evm.deployedBytecode.object);
  await setCode(BRIDGE, compiled.BridgeMock.evm.deployedBytecode.object);
  for (const account of [alice, bob, carol, dave, buyer, owner, seller, helper, agentB]) await setKey(account);
  await setKey(erin, true, false);
  const hash = await wallet.deployContract({ account: deployer, abi, bytecode, args: ['qorechain-diana'] });
  const deployed = await publicClient.waitForTransactionReceipt({ hash });
  contract = deployed.contractAddress;
  // The app and the signing tool recognise the deployment by its exact runtime code.
  assert.equal((await publicClient.getCode({ address: contract })).toLowerCase(), runtime.toLowerCase());
  assert.equal(await read('deployBlock'), deployed.blockNumber);
});

const workshop = (overrides = {}) => ({
  title: 'Community design workshop', price: parseEther('12.000001'),
  recipients: [alice, bob, carol], shares: [5000, 3000, 2000], ...overrides,
});

test('a link takes no payment until every collaborator signs with their post-quantum key', async () => {
  const terms = workshop();
  const id = await propose(terms);
  const agreement = await read('getAgreement', [id]);
  assert.equal(agreement.status, 1);
  assert.deepEqual(agreement.signers, [alice, bob, carol]);
  assert.equal(agreement.termsHash, termsHash({ ...terms, previous: 0n }));
  assert.equal(await read('termsMessage', [id, alice]),
    termsMessage({ chainId: CHAIN_ID, contract, id, signer: alice, hash: agreement.termsHash }));

  const reference = keccak256(stringToHex('early'));
  await reverts(payer, 'checkout', [id, reference], 'NotActive', terms.price);

  // A signature over the terms is bound to the signer, the agreement and the deployment.
  const aliceMessage = await read('termsMessage', [id, alice]);
  await reverts(relayer, 'sign', [id, alice, signAs(bob, aliceMessage)], 'BadPqcSignature');
  await reverts(relayer, 'sign', [id, bob, signAs(alice, aliceMessage)], 'BadPqcSignature');
  await reverts(relayer, 'sign', [id, mallory, signAs(mallory, await read('termsMessage', [id, mallory]))], 'NotASigner');

  const signed = eventNamed(await signTerms(id, alice), 'Signed');
  assert.deepEqual([signed.id, signed.signer], [id, alice]);
  await reverts(relayer, 'sign', [id, alice, signAs(alice, aliceMessage)], 'AlreadySigned');
  await signTerms(id, bob, bob);
  await reverts(payer, 'checkout', [id, reference], 'NotActive', terms.price);

  const recordsBefore = await bridgeRecords();
  const last = await signTerms(id, carol);
  const activated = eventNamed(last, 'Activated');
  const commitment = agreementCommitment({ chainId: CHAIN_ID, contract, id, hash: agreement.termsHash, signers: [alice, bob, carol] });
  assert.equal(activated.commitment, commitment);
  assert.equal(await read('agreementCommitment', [id]), commitment);
  const [record] = events(last, compiled.BridgeMock.abi, BRIDGE);
  assert.deepEqual(JSON.parse(hexToString(record.args.payload)), { record: { note: termsNote(commitment) } });
  assert.equal(await bridgeRecords(), recordsBefore + 1n);

  const active = await read('getAgreement', [id]);
  assert.equal(active.status, 2);
  assert.equal(active.signedMask, 7);
  assert.equal(active.activatedAt, last.blockNumber);
  assert.equal(JSON.parse(hexToString(decodeAbiParameters([{ type: 'bytes' }], active.nativeReply)[0])).id, 7);
  for (const account of [alice, bob, carol]) assert.deepEqual(await read('agreementsOf', [account]), [id]);
});

test('signers need a registered, proven key on chain', async () => {
  const id = await propose(workshop({ recipients: [alice, erin, mallory], shares: [4000, 3000, 3000] }));
  await reverts(relayer, 'sign', [id, erin, signAs(erin, await read('termsMessage', [id, erin]))], 'PqcKeyNotProven');
  await reverts(relayer, 'sign', [id, mallory, signAs(mallory, await read('termsMessage', [id, mallory]))], 'PqcKeyNotRegistered');
  await reverts(relayer, 'sign', [999n, alice, '0x00'], 'AgreementNotFound');
});

test('checkout credits exact shares and commits a Native receipt atomically', async () => {
  const terms = workshop();
  const { id } = await activate(terms);
  const quote = ['6', '3.6', '2.400001'].map((amount) => parseEther(amount));
  assert.deepEqual(await read('quote', [id]), quote);
  assert.deepEqual(splitAmounts(terms.price, terms.shares), quote);
  const before = await Promise.all([alice, bob, carol].map((account) => read('earned', [account])));

  const reference = keccak256(stringToHex('checkout-1'));
  await reverts(payer, 'checkout', [id, reference], 'IncorrectPayment', terms.price - 1n);
  await reverts(payer, 'checkout', [id, '0x' + '0'.repeat(64)], 'IncorrectPayment', terms.price);
  const receipt = await sendOk(payer, 'checkout', [id, reference], terms.price);
  const payment = eventNamed(receipt, 'Checkout');
  assert.deepEqual(payment.credits, quote);
  assert.equal(payment.paymentId, paymentId(id, payer, reference));
  const commitment = paymentCommitment({
    chainId: CHAIN_ID, contract, id, payer, paymentId: payment.paymentId, total: terms.price,
    recipients: terms.recipients, credits: quote,
  });
  assert.equal(payment.commitment, commitment);
  const [record] = events(receipt, compiled.BridgeMock.abi, BRIDGE);
  assert.deepEqual(JSON.parse(hexToString(record.args.payload)), { record: { note: paymentNote(commitment) } });
  await reverts(payer, 'checkout', [id, reference], 'AlreadyPaid', terms.price);

  const after = await Promise.all([alice, bob, carol].map((account) => read('earned', [account])));
  after.forEach((value, i) => assert.equal(value - before[i], quote[i]));
  assert.equal((await read('getAgreement', [id])).sales, 1n);
});

test('a stolen classical key cannot move earnings; the post-quantum signature can, through any relayer', async () => {
  const { id } = await activate(workshop({ recipients: [alice, bob], shares: [5000, 5000], price: parseEther('2') }));
  await sendOk(payer, 'checkout', [id, keccak256(stringToHex('withdrawals'))], parseEther('2'));
  const available = await read('claimable', [alice]);
  assert.ok(available >= parseEther('1'));

  // The attacker controls alice's EVM account but signs with an ML-DSA key of their own.
  const forged = mockSign(keccak256(toHex('attacker key')), await read('withdrawalMessage', [alice, mallory, available, 0n]));
  await reverts(alice, 'withdraw', [alice, mallory, available, forged], 'BadPqcSignature');
  await reverts(alice, 'withdraw', [alice, alice, available, '0x'], 'BadPqcSignature');

  const destination = dave;
  const amount = parseEther('0.4');
  const signature = await signWithdrawal(alice, destination, amount);
  // The signature fixes the destination and the amount.
  await reverts(relayer, 'withdraw', [alice, mallory, amount, signature], 'BadPqcSignature');
  await reverts(relayer, 'withdraw', [alice, destination, amount + 1n, signature], 'BadPqcSignature');
  await reverts(relayer, 'withdraw', [alice, destination, available + 1n, signature], 'InsufficientBalance');
  await reverts(relayer, 'withdraw', [alice, destination, 0n, signature], 'InvalidWithdrawal');

  const balanceBefore = await publicClient.getBalance({ address: destination });
  const receipt = await sendOk(relayer, 'withdraw', [alice, destination, amount, signature]);
  const withdrawn = eventNamed(receipt, 'Withdrawn');
  assert.deepEqual([withdrawn.recipient, withdrawn.to, withdrawn.amount, withdrawn.nonce], [alice, destination, amount, 0n]);
  assert.equal(await publicClient.getBalance({ address: destination }), balanceBefore + amount);
  assert.equal(await read('claimable', [alice]), available - amount);
  assert.equal(await read('withdrawn', [alice]), amount);
  assert.equal(await read('nonces', [alice]), 1n);
  await reverts(relayer, 'withdraw', [alice, destination, amount, signature], 'BadPqcSignature');

  // Bob's earnings are untouched by alice's withdrawal.
  assert.ok(await read('claimable', [bob]) >= parseEther('1'));
  const rest = await read('claimable', [alice]);
  await sendOk(alice, 'withdraw', [alice, alice, rest, await signWithdrawal(alice, alice, rest)]);
  assert.equal(await read('claimable', [alice]), 0n);
});

test('the split changes only when every old and new collaborator signs the new version', async () => {
  const original = workshop({ recipients: [alice, bob, carol], shares: [4000, 4000, 2000], price: parseEther('10') });
  const { id: v1 } = await activate(original);
  await sendOk(payer, 'checkout', [v1, keccak256(stringToHex('v1-sale'))], original.price);

  // Alice and bob try to drop carol and add dave.
  const amended = { title: original.title, price: parseEther('10'), recipients: [alice, bob, dave], shares: [4500, 4500, 1000], previous: v1 };
  const v2 = await propose(amended, alice);
  const proposal = await read('getAgreement', [v2]);
  assert.deepEqual(proposal.signers, requiredSigners(amended.recipients, original.recipients));
  assert.deepEqual(proposal.signers, [alice, bob, dave, carol]);
  for (const signer of [alice, bob, dave]) await signTerms(v2, signer);
  assert.equal((await read('getAgreement', [v2])).status, 1, 'still pending without carol');
  assert.equal((await read('getAgreement', [v1])).status, 2, 'the old version still takes payments');
  await reverts(payer, 'checkout', [v2, keccak256(stringToHex('too-early'))], 'NotActive', amended.price);

  const receipt = await signTerms(v2, carol);
  const superseded = eventNamed(receipt, 'Superseded');
  assert.deepEqual([superseded.previous, superseded.successor], [v1, v2]);
  const old = await read('getAgreement', [v1]);
  assert.equal(old.status, 3);
  assert.equal(old.successor, v2);
  assert.equal(old.sales, 1n, 'history stays');
  await reverts(payer, 'checkout', [v1, keccak256(stringToHex('old-link'))], 'NotActive', original.price);
  await sendOk(payer, 'checkout', [v2, keccak256(stringToHex('v2-sale'))], amended.price);
  assert.deepEqual(await read('agreementsOf', [dave]), [v2]);
  assert.ok((await read('agreementsOf', [carol])).includes(v1));
  assert.ok(!(await read('agreementsOf', [carol])).includes(v2));

  // A replaced version cannot be amended again, and a competing amendment goes stale.
  await reverts(alice, 'propose', [amended.title, amended.price, amended.recipients, amended.shares, v1], 'PreviousNotActive');
  const rivalA = await propose({ ...amended, shares: [5000, 4000, 1000], previous: v2 });
  const rivalB = await propose({ ...amended, shares: [4000, 5000, 1000], previous: v2 });
  for (const signer of [alice, bob, dave]) await signTerms(rivalA, signer);
  for (const signer of [alice, bob]) await signTerms(rivalB, signer);
  await reverts(relayer, 'sign', [rivalB, dave, signAs(dave, await read('termsMessage', [rivalB, dave]))], 'PreviousNotActive');
});

test('a pending proposal can be cancelled by its proposer or a signer only', async () => {
  const id = await propose(workshop(), payer);
  await reverts(mallory, 'cancel', [id], 'NotAuthorized');
  const receipt = await sendOk(bob, 'cancel', [id]);
  assert.equal(eventNamed(receipt, 'Cancelled').by, bob);
  assert.equal((await read('getAgreement', [id])).status, 4);
  await reverts(relayer, 'sign', [id, alice, signAs(alice, await read('termsMessage', [id, alice]))], 'NotPending');
  await reverts(payer, 'cancel', [id], 'NotPending');
  const own = await propose(workshop(), payer);
  await sendOk(payer, 'cancel', [own]);
});

test('Native failures roll back activation and checkout', async () => {
  const terms = workshop({ recipients: [alice, bob], shares: [5000, 5000], price: parseEther('2') });
  const id = await propose(terms);
  await signTerms(id, alice);
  const bobMessage = await read('termsMessage', [id, bob]);
  const recordsBefore = await bridgeRecords();

  await bridgeSet('setRejects', true);
  try {
    const rejected = await send(relayer, 'sign', [id, bob, signAs(bob, bobMessage)]);
    assert.equal(rejected.status, 'reverted');
    assert.deepEqual(rejected.logs, []);
    assert.equal((await read('getAgreement', [id])).status, 1);
    assert.equal(await bridgeRecords(), recordsBefore);
  } finally {
    await bridgeSet('setRejects', false);
  }
  await bridgeSet('setEmptyReply', true);
  try {
    await reverts(relayer, 'sign', [id, bob, signAs(bob, bobMessage)], 'BridgeUnavailable');
  } finally {
    await bridgeSet('setEmptyReply', false);
  }
  await sendOk(relayer, 'sign', [id, bob, signAs(bob, bobMessage)]);

  const reference = keccak256(stringToHex('atomicity'));
  const before = await read('earned', [alice]);
  const balance = await publicClient.getBalance({ address: contract });
  await bridgeSet('setRejects', true);
  try {
    const rejected = await send(payer, 'checkout', [id, reference], terms.price);
    assert.equal(rejected.status, 'reverted');
    assert.equal(await read('earned', [alice]), before);
    assert.equal(await publicClient.getBalance({ address: contract }), balance);
    assert.equal((await read('getAgreement', [id])).sales, 0n);
  } finally {
    await bridgeSet('setRejects', false);
  }
  await setCode(BRIDGE, '');
  try {
    await reverts(payer, 'checkout', [id, reference], 'BridgeUnavailable', terms.price);
  } finally {
    await setCode(BRIDGE, compiled.BridgeMock.evm.deployedBytecode.object);
  }
  await sendOk(payer, 'checkout', [id, reference], terms.price);
  assert.equal(await read('earned', [alice]), before + parseEther('1'));
});

test('invalid terms are refused and a failed payout keeps the balance', async () => {
  const price = parseEther('2');
  const invalid = [
    ['', price, [alice, bob], [5000, 5000]],
    ['x'.repeat(97), price, [alice, bob], [5000, 5000]],
    ['Workshop', price, [alice, alice], [5000, 5000]],
    ['Workshop', price, [alice], [10000]],
    ['Workshop', price, [alice, bob, carol, dave, erin, payer], [2000, 2000, 2000, 2000, 1000, 1000]],
    ['Workshop', price, [alice, bob], [5000, 4999]],
    ['Workshop', price, [alice, bob], [5000]],
    ['Workshop', 0n, [alice, bob], [5000, 5000]],
    ['Workshop', price + 1n, [alice, bob], [5000, 5000]],
    ['Workshop', 10n ** 12n, [alice, bob], [9999, 1]],
    ['Workshop', price, [alice, '0x0000000000000000000000000000000000000000'], [5000, 5000]],
    ['Workshop', price, [alice, contract], [5000, 5000]],
  ];
  for (const args of invalid) await reverts(deployer, 'propose', [...args, 0n], 'InvalidTerms');
  await reverts(deployer, 'propose', ['Workshop', price, [alice, bob], [5000, 5000], 999n], 'PreviousNotActive');
  const five = await propose(workshop({ recipients: [alice, bob, carol, dave, erin], shares: [2000, 2000, 2000, 2000, 2000] }));
  assert.equal((await read('getAgreement', [five])).signers.length, 5);

  const hash = await wallet.deployContract({
    account: deployer, abi: compiled.RejectingReceiver.abi, bytecode: '0x' + compiled.RejectingReceiver.evm.bytecode.object,
  });
  const { contractAddress: rejector } = await publicClient.waitForTransactionReceipt({ hash });
  const { id } = await activate(workshop({ recipients: [alice, bob], shares: [5000, 5000], price }));
  await sendOk(payer, 'checkout', [id, keccak256(stringToHex('payout'))], price);
  const available = await read('claimable', [bob]);
  const failed = await send(relayer, 'withdraw', [bob, rejector, available, await signWithdrawal(bob, rejector, available)]);
  assert.equal(failed.status, 'reverted');
  assert.equal(await read('claimable', [bob]), available);
  assert.equal(await read('nonces', [bob]), 0n);
});

test('real ML-DSA-87 signatures over the contract bytes verify, and only for the signed terms', async () => {
  const id = await propose(workshop());
  const agreement = await read('getAgreement', [id]);
  const message = await read('termsMessage', [id, alice]);
  const keypair = generatePqcKeypair();
  const signature = toHex(pqcSign(keypair.secretKey, Buffer.from(message.slice(2), 'hex')));
  assert.equal((signature.length - 2) / 2, 4627);
  assert.ok(verifyLocally(keypair.publicKey, message, signature));
  // The same signature verifies with @qorechain/pqc, the library checked against QoreChain's
  // shared cross-language test vectors: what the SDK signs is plain FIPS 204 ML-DSA-87.
  assert.ok(mldsa87.verify(keypair.publicKey, hexToBytes(message), hexToBytes(signature)));
  const otherTerms = termsMessage({ chainId: CHAIN_ID, contract, id, signer: alice, hash: termsHash({ ...workshop({ shares: [3000, 3000, 4000] }), previous: 0n }) });
  assert.notEqual(otherTerms, message);
  assert.equal(agreement.termsHash, termsHash({ ...workshop(), previous: 0n }));
  assert.ok(!verifyLocally(keypair.publicKey, otherTerms, signature));
  const forged = forgerFor(alice).sign(message);
  assert.ok(!verifyLocally(keypair.publicKey, message, forged));

  const nonce = await read('nonces', [alice]);
  const withdrawal = await read('withdrawalMessage', [alice, bob, 5n, nonce]);
  assert.equal(withdrawal, withdrawalMessage({ chainId: CHAIN_ID, contract, recipient: alice, to: bob, amount: 5n, nonce }));
});

test('signed requests carry exactly what the contract needs', () => {
  const scope = { chainId: CHAIN_ID, contract };
  const text = signedRequest('withdraw', { recipient: alice, to: bob, amount: 5n, signature: '0xabcd' }, scope);
  const parsed = parseSignedRequest(text, scope);
  assert.equal(parsed.action, 'withdraw');
  assert.deepEqual(parsed.args, [alice, bob, 5n, '0xabcd']);
  assert.throws(() => parseSignedRequest(text, { chainId: 9800, contract }), /different chain/);
  assert.throws(() => parseSignedRequest(text, { chainId: CHAIN_ID, contract: alice }), /different Treaty/);
  const sign = signedRequest('sign', { id: 3n, signer: carol, signature: '0x01' }, scope);
  assert.deepEqual(parseSignedRequest(sign, scope).args, [3n, carol, '0x01']);
  const deliver = signedRequest('deliver', { id: 1n, provider: bob, deliverable: '0x' + '12'.repeat(32), signature: '0x01' }, scope);
  assert.equal(parseSignedRequest(deliver, scope).label, 'Deliver work');
  assert.throws(() => parseSignedRequest(deliver.replace('"0x' + '12'.repeat(32), '"0x12'), scope), /valid deliverable/);
  assert.throws(() => parseSignedRequest('{}', scope), /not a Treaty/);
  assert.throws(() => signedRequest('drain', {}, scope), /Unknown action/);
});

// ------------------------------------------------------------ service treaties

const now = async () => (await publicClient.getBlock()).timestamp;
async function advance(seconds) {
  await publicClient.request({ method: 'evm_increaseTime', params: [Number(seconds)] });
  await publicClient.request({ method: 'evm_mine', params: [] });
}
const UNIT = parseEther('2');

async function proposeService(overrides = {}) {
  const terms = {
    title: 'Clean five datasets', price: UNIT, maxUnits: 5, deadline: (await now()) + 3600n, reviewPeriod: 600,
    client: buyer, recipients: [seller, helper], shares: [8000, 2000], ...overrides,
  };
  const receipt = await sendOk(deployer, 'proposeService', [
    terms.title, terms.price, terms.maxUnits, terms.deadline, terms.reviewPeriod, terms.client, terms.recipients, terms.shares,
  ]);
  return { id: eventNamed(receipt, 'Proposed').id, terms };
}

async function agreeService(overrides) {
  const { id, terms } = await proposeService(overrides);
  for (const signer of (await read('getAgreement', [id])).signers) await signTerms(id, signer);
  return { id, terms };
}

async function deliverAs(provider, id, content, signer = provider) {
  const deliverable = deliverableHash(content);
  const { deliveries } = await read('getAgreement', [id]);
  const message = await read('deliveryMessage', [id, BigInt(deliveries), provider, deliverable]);
  const receipt = await sendOk(relayer, 'deliver', [id, provider, deliverable, signAs(signer, message)]);
  return { unit: eventNamed(receipt, 'Delivered').unit, deliverable };
}

async function review(id, unit, accepted, signer = buyer) {
  const message = await read('reviewMessage', [id, unit, accepted]);
  return [id, unit, signAs(signer, message)];
}

test('a service treaty locks the budget, pays accepted work, releases ignored work and refunds the rest', async () => {
  const { id, terms } = await proposeService();
  const agreement = await read('getAgreement', [id]);
  assert.equal(agreement.kind, 1);
  assert.deepEqual(agreement.signers, [seller, helper, buyer], 'providers and the client all sign');
  assert.equal(agreement.termsHash, termsHash({ ...terms, kind: 1 }));
  await reverts(buyer, 'fund', [id], 'NotActive', budgetOf(terms));
  await reverts(payer, 'checkout', [id, keccak256(stringToHex('not a shop'))], 'WrongKind', UNIT);
  for (const signer of agreement.signers) await signTerms(id, signer);
  assert.equal((await read('getAgreement', [id])).status, 2);

  // Funding: exactly the budget, once.
  await reverts(relayer, 'deliver', [id, seller, deliverableHash('x'), '0x00'], 'NotFunded');
  // Only the client (or its owner) locks the budget, since unused budget is refunded to them.
  await reverts(payer, 'fund', [id], 'NotClient', parseEther('10'));
  await reverts(buyer, 'fund', [id], 'IncorrectPayment', UNIT);
  const funded = eventNamed(await sendOk(buyer, 'fund', [id], parseEther('10')), 'Funded');
  assert.equal(funded.amount, parseEther('10'));
  await reverts(buyer, 'fund', [id], 'AlreadyFunded', parseEther('10'));

  // Delivery: only providers, only with their own post-quantum signature.
  const content = 'dataset 1: 10,000 cleaned rows';
  const message = await read('deliveryMessage', [id, 0n, seller, deliverableHash(content)]);
  assert.equal(message, deliveryMessage({ chainId: CHAIN_ID, contract, id, unit: 0n, provider: seller, deliverable: deliverableHash(content) }));
  await reverts(relayer, 'deliver', [id, mallory, deliverableHash(content), signAs(mallory, message)], 'NotAProvider');
  await reverts(relayer, 'deliver', [id, seller, deliverableHash(content), signAs(helper, message)], 'BadPqcSignature');
  await reverts(relayer, 'deliver', [id, seller, '0x' + '0'.repeat(64), signAs(seller, message)], 'InvalidTerms');
  const first = await deliverAs(seller, id, content);
  assert.equal(first.unit, 0n);
  const stored = await read('getDelivery', [id, 0n]);
  assert.deepEqual([stored.deliverable, stored.provider, stored.status], [first.deliverable, seller, 1]);

  // Accepting pays one unit, split between the team, with a Native receipt.
  const before = await Promise.all([seller, helper].map((account) => read('earned', [account])));
  const acceptArgs = await review(id, 0n, true);
  assert.equal(await read('reviewMessage', [id, 0n, true]),
    reviewMessage({ chainId: CHAIN_ID, contract, id, unit: 0n, deliverable: first.deliverable, accepted: true }));
  await reverts(relayer, 'accept', [id, 0n, signAs(seller, await read('reviewMessage', [id, 0n, true]))], 'BadPqcSignature');
  await reverts(relayer, 'accept', [id, 0n, (await review(id, 0n, false))[2]], 'BadPqcSignature', undefined);
  const accepted = await sendOk(relayer, 'accept', acceptArgs);
  const payment = eventNamed(accepted, 'Paid');
  assert.equal(payment.how, 2);
  assert.deepEqual(payment.credits, [parseEther('1.6'), parseEther('0.4')]);
  const commitment = deliveryCommitment({
    chainId: CHAIN_ID, contract, id, unit: 0n, deliverable: first.deliverable, recipients: [seller, helper], credits: payment.credits,
  });
  assert.equal(payment.commitment, commitment);
  const [record] = events(accepted, compiled.BridgeMock.abi, BRIDGE);
  assert.deepEqual(JSON.parse(hexToString(record.args.payload)), { record: { note: deliveryNote(commitment) } });
  const after = await Promise.all([seller, helper].map((account) => read('earned', [account])));
  assert.deepEqual(after.map((value, i) => value - before[i]), payment.credits);
  await reverts(relayer, 'accept', acceptArgs, 'DeliveryNotPending');

  // Rejecting frees the unit, but only within the review period.
  const second = await deliverAs(helper, id, 'dataset 2: half empty');
  assert.equal(eventNamed(await sendOk(relayer, 'reject', await review(id, second.unit, false)), 'Rejected').unit, second.unit);
  assert.equal((await read('getDelivery', [id, second.unit])).status, 3);
  const third = await deliverAs(seller, id, 'dataset 2, fixed');
  await reverts(mallory, 'release', [id, third.unit], 'ReviewPeriodNotOver');
  await advance(601);
  await reverts(relayer, 'reject', await review(id, third.unit, false), 'ReviewPeriodOver');
  // The client went quiet: anyone releases the payment.
  assert.equal(eventNamed(await sendOk(mallory, 'release', [id, third.unit]), 'Paid').how, 4);

  // Units are capped by the budget.
  for (let i = 0; i < 3; i++) await deliverAs(seller, id, 'dataset ' + (3 + i));
  await reverts(relayer, 'deliver', [id, seller, deliverableHash('one too many'), '0x00'], 'NoUnitsLeft');
  assert.equal(await read('refundable', [id]), 0n);

  // After the deadline: no more deliveries; pending work stays reserved; the rest returns.
  await sendOk(relayer, 'reject', await review(id, 5n, false));
  await reverts(payer, 'refund', [id], 'DeadlineNotPassed');
  await advance(3600);
  await reverts(relayer, 'deliver', [id, seller, deliverableHash('late'), '0x00'], 'DeadlinePassed');
  assert.equal(await read('refundable', [id]), UNIT);
  const clientBefore = await publicClient.getBalance({ address: buyer });
  const refunded = eventNamed(await sendOk(mallory, 'refund', [id]), 'Refunded');
  assert.deepEqual([refunded.to, refunded.amount], [buyer, UNIT]);
  assert.equal(await publicClient.getBalance({ address: buyer }), clientBefore + UNIT);
  await reverts(mallory, 'refund', [id], 'NothingToRefund');
  // Work delivered before the deadline can still be paid.
  await sendOk(relayer, 'accept', await review(id, 4n, true));
  await sendOk(mallory, 'release', [id, 3n]);
  const final = await read('getAgreement', [id]);
  assert.deepEqual([final.sales, final.pendingUnits, final.refunded], [4n, 0, UNIT]);
  assert.ok((await read('agreementsOf', [helper])).includes(id));
  assert.ok((await read('treatiesAsClient', [buyer])).includes(id));
});

test('service terms are validated', async () => {
  const t = (await now()) + 3600n;
  const bad = [
    ['Job', UNIT, 0, t, 600, buyer, [seller], [10000]],
    ['Job', UNIT, 1001, t, 600, buyer, [seller], [10000]],
    ['Job', UNIT, 1, (await now()) - 1n, 600, buyer, [seller], [10000]],
    ['Job', UNIT, 1, t, 59, buyer, [seller], [10000]],
    ['Job', UNIT, 1, t, 30 * 86400 + 1, buyer, [seller], [10000]],
    ['Job', UNIT, 1, t, 600, seller, [seller], [10000]],
    ['Job', UNIT, 1, t, 600, '0x0000000000000000000000000000000000000000', [seller], [10000]],
    ['Job', UNIT, 1, t, 600, buyer, [], []],
  ];
  for (const args of bad) await reverts(deployer, 'proposeService', args, 'InvalidTerms');
  const { id } = await proposeService({ recipients: [seller], shares: [10000] });
  assert.equal((await read('getAgreement', [id])).signers.length, 2, 'a single provider is allowed');
});

test('an owner limits what its agent can commit, can switch it off, and then controls its money', async () => {
  const expiry = (await now()) + 86400n;
  const limits = [parseEther('10'), parseEther('15'), expiry];
  const message = await read('mandateMessage', [buyer, owner, ...limits]);
  assert.equal(message, mandateMessage({ chainId: CHAIN_ID, contract, agent: buyer, owner, maxPerTreaty: limits[0], maxTotal: limits[1], expiry, nonce: 0n }));
  await reverts(relayer, 'setMandate', [buyer, owner, ...limits, signAs(mallory, message), signAs(owner, message)], 'BadPqcSignature');
  await reverts(relayer, 'setMandate', [buyer, owner, ...limits, signAs(buyer, message), signAs(mallory, message)], 'BadPqcSignature');
  await reverts(relayer, 'setMandate', [buyer, buyer, ...limits, signAs(buyer, message), signAs(buyer, message)], 'InvalidMandate');
  await reverts(relayer, 'setMandate', [buyer, owner, parseEther('20'), parseEther('15'), expiry, '0x', '0x'], 'InvalidMandate');
  const set = eventNamed(await sendOk(relayer, 'setMandate', [buyer, owner, ...limits, signAs(buyer, message), signAs(owner, message)]), 'MandateSet');
  assert.deepEqual([set.agent, set.owner, set.maxTotal], [buyer, owner, parseEther('15')]);
  await reverts(relayer, 'setMandate', [buyer, owner, ...limits, signAs(buyer, message), signAs(owner, message)], 'BadPqcSignature');
  const stolen = await read('mandateMessage', [buyer, mallory, ...limits]);
  await reverts(relayer, 'setMandate', [buyer, mallory, ...limits, signAs(buyer, stolen), signAs(mallory, stolen)], 'InvalidMandate');

  // Over the per-treaty limit: the agent cannot even agree.
  const big = await proposeService({ maxUnits: 6 });
  for (const signer of [seller, helper]) await signTerms(big.id, signer);
  await reverts(relayer, 'sign', [big.id, buyer, signAs(buyer, await read('termsMessage', [big.id, buyer]))], 'MandateLimitExceeded');
  // Within limits: agreed and funded; the commitment counts against the total.
  const { id } = await agreeService();
  // The owner may lock its agent's budget too; it counts against the agent's limits all the same.
  await reverts(mallory, 'fund', [id], 'NotClient', parseEther('10'));
  await sendOk(owner, 'fund', [id], parseEther('10'));
  assert.equal((await read('getMandate', [buyer])).committed, parseEther('10'));
  const second = await proposeService({ maxUnits: 4 });
  for (const signer of [seller, helper]) await signTerms(second.id, signer);
  await reverts(relayer, 'sign', [second.id, buyer, signAs(buyer, await read('termsMessage', [second.id, buyer]))], 'MandateLimitExceeded');

  // The owner raises the limit; the agent must agree again.
  const raised = [parseEther('10'), parseEther('30'), expiry];
  const raiseMessage = await read('mandateMessage', [buyer, owner, ...raised]);
  await sendOk(relayer, 'setMandate', [buyer, owner, ...raised, signAs(buyer, raiseMessage), signAs(owner, raiseMessage)]);
  await signTerms(second.id, buyer);
  assert.equal((await read('getAgreement', [second.id])).status, 2);

  // The agent earns something as a provider in another treaty.
  const { id: job } = await agreeService({ client: agentB, recipients: [buyer], shares: [10000], maxUnits: 1 });
  await sendOk(agentB, 'fund', [job], UNIT);
  const { unit } = await deliverAs(buyer, job, 'summary');
  await sendOk(relayer, 'accept', await review(job, unit, true, agentB));
  assert.equal(await read('claimable', [buyer]), UNIT);

  // Switch it off.
  const revoke = await read('revokeMessage', [buyer]);
  await reverts(relayer, 'revokeMandate', [buyer, signAs(buyer, revoke)], 'BadPqcSignature');
  await sendOk(relayer, 'revokeMandate', [buyer, signAs(owner, revoke)]);
  assert.equal(await read('canAct', [buyer]), false);
  await reverts(relayer, 'revokeMandate', [buyer, signAs(owner, await read('revokeMessage', [buyer]))], 'InvalidMandate');
  const { unit: pendingUnit } = await deliverAs(seller, id, 'delivered to a switched-off agent');
  await reverts(relayer, 'accept', await review(id, pendingUnit, true), 'AgentNotAuthorized');
  const fresh = await proposeService();
  await reverts(relayer, 'sign', [fresh.id, buyer, signAs(buyer, await read('termsMessage', [fresh.id, buyer]))], 'AgentNotAuthorized');

  // Only the owner can move the agent's earnings now.
  assert.equal(await read('withdrawalSigner', [buyer]), owner);
  const ownByAgent = await signWithdrawal(buyer, buyer, UNIT);
  await reverts(relayer, 'withdraw', [buyer, buyer, UNIT, ownByAgent], 'BadPqcSignature');
  const ownerBalance = await publicClient.getBalance({ address: owner });
  await sendOk(relayer, 'withdraw', [buyer, owner, UNIT, await signWithdrawal(buyer, owner, UNIT, owner)]);
  assert.equal(await publicClient.getBalance({ address: owner }), ownerBalance + UNIT);

  // Unused budget goes back to the owner, and frees the commitment.
  await advance(3601);
  await sendOk(mallory, 'release', [id, pendingUnit]);
  const refund = eventNamed(await sendOk(mallory, 'refund', [id]), 'Refunded');
  assert.deepEqual([refund.to, refund.amount], [owner, parseEther('8')]);
  assert.equal((await read('getMandate', [buyer])).committed, parseEther('2'));
});

test('an expired mandate stops the agent like a revocation', async () => {
  const expiry = (await now()) + 120n;
  const limits = [UNIT, UNIT, expiry];
  const message = await read('mandateMessage', [agentB, owner, ...limits]);
  await sendOk(relayer, 'setMandate', [agentB, owner, ...limits, signAs(agentB, message), signAs(owner, message)]);
  assert.equal(await read('canAct', [agentB]), true);
  await advance(121);
  assert.equal(await read('canAct', [agentB]), false);
  assert.equal(await read('withdrawalSigner', [agentB]), owner);
  const { id } = await proposeService({ client: agentB, maxUnits: 1 });
  await reverts(relayer, 'sign', [id, agentB, signAs(agentB, await read('termsMessage', [id, agentB]))], 'AgentNotAuthorized');
});
