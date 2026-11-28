// A local stand-in for QoreChain Diana, for end-to-end runs and demos of the real deploy
// script, signing tool, agent SDK and web app. No network is needed.
//
// - A Hardhat node with chain ID 9800 runs the EVM.
// - The ML-DSA-87 precompiles are stand-ins, but their answers come from real
//   cryptography: before a Treaty call signed with ML-DSA-87 reaches the node,
//   this server verifies the ML-DSA-87 signature with @qorechain/sdk against the
//   registered key and the exact bytes the contract will check, and only then
//   attests it to the pqcVerify stand-in. A forged signature is never attested.
// - The Cross-VM bridge stand-in keeps a receipt book with the same reply and
//   REST shapes as Diana's governance-pinned `qday-receipts` contract.
// - The Native REST routes the app and scripts use are served from that state.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { bech32 } from '@scure/base';
import { pqcVerify } from '@qorechain/sdk';
import solc from 'solc';
import {
  createPublicClient, createWalletClient, decodeFunctionData, defineChain, encodeAbiParameters, getAddress, hexToBytes, http,
  keccak256, parseEther, parseTransaction,
} from 'viem';

export const RECEIPTS = 'qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8';
export const PQC_VERIFY = '0x0000000000000000000000000000000000000a01';
export const PQC_KEYS = '0x0000000000000000000000000000000000000a02';
export const BRIDGE = '0x0000000000000000000000000000000000000901';
export const qorAddressOf = (account) => bech32.encode('qor', bech32.toWords(hexToBytes(account)));

const standIns = `
pragma solidity ^0.8.26;
contract PqcVerifyStandIn {
    mapping(bytes32 => bool) public attested;
    function attest(bytes32 digest) external { attested[digest] = true; }
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message) external view returns (bool) {
        return attested[keccak256(abi.encode(pubkey, signature, message))];
    }
}
contract PqcKeysStandIn {
    struct Key { bool registered; bool proven; bytes pubkey; }
    mapping(address => Key) private keys;
    function setKey(address account, bytes calldata pubkey) external { keys[account] = Key(true, true, pubkey); }
    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        Key storage key = keys[account];
        return (key.registered, key.registered ? 1 : 0, key.pubkey, key.proven);
    }
}
contract ReceiptBookStandIn {
    struct Receipt { address sender; string note; uint256 height; }
    Receipt[] private book;
    bool public rejects;
    function setRejects(bool next) external { rejects = next; }
    function count() external view returns (uint256) { return book.length; }
    function receipt(uint256 id) external view returns (address, string memory, uint256) {
        Receipt storage r = book[id - 1];
        return (r.sender, r.note, r.height);
    }
    function executeCrossVMCall(uint8 vm, string calldata target, bytes calldata payload) external returns (bytes memory) {
        require(vm == 1 && keccak256(bytes(target)) == keccak256(bytes("${RECEIPTS}")), "target not allowed");
        require(!rejects, "Native receipt refused");
        bytes memory prefix = bytes('{"record":{"note":"');
        require(payload.length > prefix.length + 3 && keccak256(payload[:prefix.length]) == keccak256(prefix), "bad message");
        string memory note = string(payload[prefix.length:payload.length - 3]);
        book.push(Receipt(msg.sender, note, block.number));
        return abi.encodePacked('{"id":', _decimal(book.length), ',"note":"', note, '","height":', _decimal(block.number), '}');
    }
    function _decimal(uint256 value) private pure returns (bytes memory text) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) ++digits;
        text = new bytes(digits);
        for (; value != 0; value /= 10) text[--digits] = bytes1(uint8(48 + value % 10));
    }
}`;

function compileStandIns() {
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'StandIns.sol': { content: standIns } },
    settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } },
  })));
  const errors = (output.errors ?? []).filter(({ severity }) => severity === 'error');
  if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'));
  return output.contracts['StandIns.sol'];
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

export async function startDiana({ abi }) {
  const nodePort = await freePort();
  const hardhat = fileURLToPath(new URL('../node_modules/hardhat/internal/cli/bootstrap.js', import.meta.url));
  const config = fileURLToPath(new URL('./local-diana.hardhat.cjs', import.meta.url));
  const node = spawn(process.execPath, [hardhat, 'node', '--config', config, '--port', String(nodePort)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let nodeLog = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The local chain did not start:\n' + nodeLog)), 30_000);
    node.once('exit', (code) => { clearTimeout(timer); reject(new Error('The local chain exited (' + code + '):\n' + nodeLog)); });
    for (const stream of [node.stdout, node.stderr]) {
      stream.on('data', (chunk) => {
        nodeLog += chunk;
        if (nodeLog.includes('Started HTTP')) { clearTimeout(timer); resolve(); }
      });
    }
  });
  const nodeUrl = 'http://127.0.0.1:' + nodePort;
  const transport = http(nodeUrl, { timeout: 60_000 });
  const chain = defineChain({
    id: 9800, name: 'Diana stand-in', nativeCurrency: { name: 'Test QOR', symbol: 'QOR', decimals: 18 },
    rpcUrls: { default: { http: [nodeUrl] } },
  });
  const client = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport });
  const accounts = (await wallet.getAddresses()).map((account) => getAddress(account));
  const operator = accounts[0];
  const compiled = compileStandIns();
  const install = (address, name) => client.request({
    method: 'hardhat_setCode', params: [address, '0x' + compiled[name].evm.deployedBytecode.object],
  });
  await install(PQC_VERIFY, 'PqcVerifyStandIn');
  await install(PQC_KEYS, 'PqcKeysStandIn');
  await install(BRIDGE, 'ReceiptBookStandIn');

  async function operate(address, name, functionName, args) {
    const hash = await wallet.writeContract({ account: operator, address, abi: compiled[name].abi, functionName, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(functionName + ' failed on the stand-in');
  }
  const registered = new Map();
  /** Distinct signatures checked with real ML-DSA-87: accepted, and refused. */
  const stats = { verified: 0, refused: 0 };
  const verified = new Set();
  const refused = new Set();
  let contract;

  const view = (functionName, args) => client.readContract({ address: contract, abi, functionName, args });

  /** The (account, message, signature) pairs a Treaty call will ask pqcVerify about. */
  async function signaturesIn(functionName, args) {
    switch (functionName) {
      case 'sign': {
        const [id, signer, signature] = args;
        return [[signer, await view('termsMessage', [id, signer]), signature]];
      }
      case 'deliver': {
        const [id, provider, deliverable, signature] = args;
        const { deliveries } = await view('getAgreement', [id]);
        return [[provider, await view('deliveryMessage', [id, BigInt(deliveries), provider, deliverable]), signature]];
      }
      case 'accept':
      case 'reject': {
        const [id, unit, signature] = args;
        const { client: payer } = await view('getAgreement', [id]);
        return [[payer, await view('reviewMessage', [id, unit, functionName === 'accept']), signature]];
      }
      case 'withdraw': {
        const [recipient, to, amount, signature] = args;
        const [signer, nonce] = await Promise.all([view('withdrawalSigner', [recipient]), view('nonces', [recipient])]);
        return [[signer, await view('withdrawalMessage', [recipient, to, amount, nonce]), signature]];
      }
      case 'setMandate': {
        const [agent, owner, maxPerTreaty, maxTotal, expiry, agentSignature, ownerSignature] = args;
        const message = await view('mandateMessage', [agent, owner, maxPerTreaty, maxTotal, expiry]);
        return [[agent, message, agentSignature], [owner, message, ownerSignature]];
      }
      case 'revokeMandate': {
        const [agent, ownerSignature] = args;
        const { owner } = await view('getMandate', [agent]);
        return [[owner, await view('revokeMessage', [agent]), ownerSignature]];
      }
      default:
        return [];
    }
  }

  /** Verify Treaty signatures for real, and attest the valid ones to the pqcVerify stand-in. */
  async function attestIfValid(to, data) {
    if (!contract || !to || !data || to.toLowerCase() !== contract.toLowerCase()) return;
    let call;
    try { call = decodeFunctionData({ abi, data }); } catch { return; }
    let pairs;
    try {
      pairs = await signaturesIn(call.functionName, call.args);
    } catch {
      return; // The node reports the real error, for example an unknown agreement.
    }
    for (const [account, message, signature] of pairs) {
      const pubkey = registered.get(account.toLowerCase());
      if (!pubkey) continue;
      const digest = keccak256(encodeAbiParameters(
        [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }], [pubkey, signature, message],
      ));
      if (verified.has(digest) || refused.has(digest)) continue;
      let valid = false;
      try { valid = pqcVerify(hexToBytes(pubkey), hexToBytes(message), hexToBytes(signature)); } catch { valid = false; }
      if (!valid) {
        refused.add(digest);
        stats.refused += 1;
        continue;
      }
      verified.add(digest);
      stats.verified += 1;
      await operate(PQC_VERIFY, 'PqcVerifyStandIn', 'attest', [digest]);
    }
  }

  async function handleRpc(body) {
    const requests = Array.isArray(body) ? body : [body];
    for (const request of requests) {
      const params = request.params ?? [];
      if (['eth_call', 'eth_estimateGas', 'eth_sendTransaction'].includes(request.method)) {
        await attestIfValid(params[0]?.to, params[0]?.data ?? params[0]?.input);
      } else if (request.method === 'eth_sendRawTransaction') {
        const transaction = parseTransaction(params[0]);
        await attestIfValid(transaction.to, transaction.data);
      }
    }
    const response = await fetch(nodeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.text();
  }

  async function handleRest(path) {
    if (path === '/qorechain/crossvm/v1/params') {
      return { params: { enabled: true, bridge_target_pins: [{ target: 'cosmwasm:' + RECEIPTS, code_id: '865' }] } };
    }
    const window = path.match(/^\/qorechain\/pqc\/v1\/evm_window\/(qor1[a-z0-9]+)$/);
    if (window) {
      return { found: true, live: true, native_only: false, allowed_targets: [], remaining_txs: '1000', remaining_value: '1000000000000' };
    }
    const smart = path.match(/^\/cosmwasm\/wasm\/v1\/contract\/(qor1[a-z0-9]+)\/smart\/(.+)$/);
    if (smart && smart[1] === RECEIPTS) {
      const query = JSON.parse(atob(decodeURIComponent(smart[2])));
      const id = Number(query?.receipt?.id);
      const total = await client.readContract({ address: BRIDGE, abi: compiled.ReceiptBookStandIn.abi, functionName: 'count' });
      if (!Number.isSafeInteger(id) || id < 1 || BigInt(id) > total) return undefined;
      const [sender, note, height] = await client.readContract({
        address: BRIDGE, abi: compiled.ReceiptBookStandIn.abi, functionName: 'receipt', args: [BigInt(id)],
      });
      return { data: { id, sender: qorAddressOf(sender), note, height: Number(height) } };
    }
  }

  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    try {
      if (request.method === 'POST') {
        const text = await handleRpc(JSON.parse(await readBody(request)));
        response.writeHead(200, { 'content-type': 'application/json' }).end(text);
        return;
      }
      const body = await handleRest(new URL(request.url, 'http://local').pathname);
      if (body === undefined) response.writeHead(404, { 'content-type': 'application/json' }).end('{"code":5,"message":"not found"}');
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;

  return {
    url, client, wallet, accounts, stats,
    /** Tell the stand-in which deployment to verify signatures for. */
    useContract(address) { contract = getAddress(address); },
    /** Register an account's real ML-DSA-87 public key, as a Native key registration would. */
    async registerKey(account, publicKey) {
      const pubkey = typeof publicKey === 'string' ? publicKey : '0x' + Buffer.from(publicKey).toString('hex');
      registered.set(account.toLowerCase(), pubkey);
      await operate(PQC_KEYS, 'PqcKeysStandIn', 'setKey', [account, pubkey]);
    },
    async fund(account, amount = parseEther('1000')) {
      const hash = await wallet.sendTransaction({ account: operator, to: account, value: amount });
      await client.waitForTransactionReceipt({ hash });
    },
    /** Move the local chain's clock forward, for deadlines and review periods. */
    async advance(seconds) {
      await client.request({ method: 'evm_increaseTime', params: [Number(seconds)] });
      await client.request({ method: 'evm_mine', params: [] });
    },
    async setNativeRejects(value) { await operate(BRIDGE, 'ReceiptBookStandIn', 'setRejects', [value]); },
    async stop() {
      server.close();
      if (node.exitCode === null) {
        node.kill();
        await once(node, 'exit');
      }
    },
  };
}
