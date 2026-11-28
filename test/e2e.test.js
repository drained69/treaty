// End-to-end: the real deploy script, the real signing tool (as separate processes, with
// real ML-DSA-87 keys from mnemonics) and the real web app in a browser, against a local
// Diana stand-in whose signature checks are backed by real ML-DSA-87 verification.
// Run with: npm run e2e
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMnemonic, generatePqcKeypair } from '@qorechain/sdk';
import {
  createWalletClient, formatEther, getAddress, hexToBytes, http, keccak256, parseEther, stringToHex, toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  agreementCommitment, parseSignedRequest, paymentCommitment, paymentNote, termsNote, windowProblem,
} from '../src/protocol.js';
import { loadSigner } from '../sdk/pqc.js';
import { qorAddressOf, startDiana } from '../scripts/local-diana.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const { abi } = JSON.parse(await readFile(new URL('../artifacts/Treaty.json', import.meta.url)));
// Hardhat's first default account, used only on the local stand-in.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let diana;
let contract;
let work;
const people = {};
let payer;
let mallory;

function runNode(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr, output: stdout + stderr }));
  });
}

/** Run the signing tool as a collaborator would: npm run pq -- <args>. */
function pq(person, ...args) {
  return runNode('scripts/treaty.js', args, {
    QORE_MNEMONIC: person?.mnemonic ?? '', VITE_TREATY_ADDRESS: contract,
    QORE_EVM_RPC: diana.url, QORE_REST_URL: diana.url,
  });
}

async function pqOk(person, ...args) {
  const result = await pq(person, ...args);
  assert.equal(result.code, 0, 'npm run pq -- ' + args.join(' ') + ' failed:\n' + result.output);
  return result.stdout;
}

const read = (functionName, args = []) => diana.client.readContract({ address: contract, abi, functionName, args });

/** Send through the stand-in's RPC, like any wallet on Diana would. */
let relay;
async function send(account, functionName, args, value) {
  const hash = await relay.writeContract({ account, address: contract, abi, functionName, args, value, gas: 5_000_000n });
  return diana.client.waitForTransactionReceipt({ hash });
}

async function nativeReceipt(id) {
  const query = encodeURIComponent(btoa(JSON.stringify({ receipt: { id } })));
  const response = await fetch(diana.url + '/cosmwasm/wasm/v1/contract/qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8/smart/' + query);
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

async function lastNativeReceipt() {
  for (let id = 1; ; ++id) {
    const response = await fetch(diana.url + '/cosmwasm/wasm/v1/contract/qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8/smart/' +
      encodeURIComponent(btoa(JSON.stringify({ receipt: { id } }))));
    if (response.status === 404) return nativeReceipt(id - 1);
  }
}

before(async () => {
  diana = await startDiana({ abi });
  work = await mkdtemp(join(tmpdir(), 'treaty-e2e-'));
  [, payer, mallory] = diana.accounts;

  // Collaborators: fresh mnemonics, real ML-DSA-87 keys, registered on the stand-in chain.
  for (const name of ['alice', 'bob', 'carol', 'dave']) {
    const mnemonic = generateMnemonic();
    const signer = await loadSigner({ QORE_MNEMONIC: mnemonic });
    people[name] = { mnemonic, address: signer.address };
    await diana.fund(signer.address);
    await diana.registerKey(signer.address, signer.publicKey);
  }
  // The deployer needs a registered key too: the deploy preflight checks it.
  await diana.registerKey(privateKeyToAccount(DEPLOYER_KEY).address, generatePqcKeypair().publicKey);

  const deployed = await runNode('scripts/deploy.js', [], {
    DIANA_DEPLOYER_KEY: DEPLOYER_KEY, QORE_EVM_RPC: diana.url, QORE_NATIVE_REST: diana.url,
  });
  assert.equal(deployed.code, 0, deployed.output);
  contract = getAddress(deployed.stdout.match(/VITE_TREATY_ADDRESS=(0x[\da-fA-F]{40})/)[1]);
  diana.useContract(contract);
  relay = createWalletClient({ chain: diana.client.chain, transport: http(diana.url) });
});

after(async () => {
  await diana?.stop();
  if (work) await rm(work, { recursive: true, force: true });
});

test('signing tool: consent, checkout, attack, withdrawal, replay and amendment with real ML-DSA-87', async () => {
  const { alice, bob, carol, dave } = people;
  const price = parseEther('12');

  const whoami = await pqOk(alice, 'whoami');
  assert.match(whoami, /registered, proven, and matches your local key/);
  assert.match(whoami, new RegExp(alice.address));

  // Someone proposes terms. Nothing can be paid yet.
  const proposed = await send(payer, 'propose', ['Community design workshop', price, [alice.address, bob.address, carol.address], [5000, 3000, 2000], 0n]);
  assert.equal(proposed.status, 'success');
  const id = await read('agreementCount');
  assert.match(await pqOk(alice, 'show', String(id)), /Pending[\s\S]*50%\s+6 QOR[\s\S]*30%\s+3\.6 QOR[\s\S]*20%\s+2\.4 QOR/);
  assert.equal((await send(payer, 'checkout', [id, keccak256(stringToHex('too early'))], price)).status, 'reverted');

  // Collaborators sign with their own keys.
  assert.match(await pqOk(alice, 'sign', String(id), '--yes'), /Waiting for the other signatures/);
  assert.match((await pq(alice, 'sign', String(id), '--yes')).output, /already signed/);
  assert.match((await pq(dave, 'sign', String(id), '--yes')).output, /is not a signer/);
  assert.match((await pq(bob, 'sign', String(id))).output, /Pass --yes/, 'refuses to sign without confirmation');
  await pqOk(bob, 'sign', String(id), '--yes');
  assert.equal((await read('getAgreement', [id])).status, 1);

  // Carol saves a signed request instead, and an unrelated wallet relays it.
  const carolFile = join(work, 'carol.json');
  assert.match(await pqOk(carol, 'sign', String(id), '--yes', '--out', carolFile), /Saved the signed request/);
  assert.equal((await read('getAgreement', [id])).status, 1, 'saving does not send');
  const request = parseSignedRequest(await readFile(carolFile, 'utf8'), { chainId: 9800, contract });
  assert.equal(request.action, 'sign');
  const activation = await send(mallory, request.action, request.args);
  assert.equal(activation.status, 'success');
  const agreement = await read('getAgreement', [id]);
  assert.equal(agreement.status, 2);

  // The terms' receipt is on Native, written by the contract in the same block.
  const termsReceipt = await lastNativeReceipt();
  const commitment = agreementCommitment({ chainId: 9800, contract, id, hash: agreement.termsHash, signers: agreement.signers });
  assert.deepEqual([termsReceipt.note, termsReceipt.sender, BigInt(termsReceipt.height)],
    [termsNote(commitment), qorAddressOf(contract), agreement.activatedAt]);

  // A sale credits every share and writes its own Native receipt.
  const sale = await send(payer, 'checkout', [id, keccak256(stringToHex('sale 1'))], price);
  assert.equal(sale.status, 'success');
  assert.deepEqual(await Promise.all([alice, bob, carol].map(({ address }) => read('claimable', [address]))),
    ['6', '3.6', '2.4'].map((qor) => parseEther(qor)));
  const saleReceipt = await lastNativeReceipt();
  assert.equal(saleReceipt.sender, qorAddressOf(contract));
  assert.equal(BigInt(saleReceipt.height), sale.blockNumber);
  assert.ok(saleReceipt.note.startsWith('treaty:'));

  // An attacker with alice's classical key, but not her ML-DSA-87 key.
  const before = diana.stats.refused;
  assert.match(await pqOk(alice, 'attack'), /BLOCKED by Treaty: BadPqcSignature/);
  assert.ok(diana.stats.refused > before, 'the forged signature was checked and refused');
  assert.equal(await read('claimable', [alice.address]), parseEther('6'));

  // Alice withdraws part of her earnings to a fresh address.
  const destination = getAddress(toHex(crypto.getRandomValues(new Uint8Array(20))));
  await pqOk(alice, 'withdraw', '2', '--to', destination, '--yes');
  assert.equal(await diana.client.getBalance({ address: destination }), parseEther('2'));
  assert.match(await pqOk(alice, 'statement'), /earned\s+6 QOR[\s\S]*withdrawn\s+2 QOR[\s\S]*available\s+4 QOR/);
  assert.match((await pq(alice, 'withdraw', '5', '--yes')).output, /You can withdraw up to 4 QOR/);

  // Bob's signed withdrawal works once, from any wallet.
  const bobFile = join(work, 'bob-withdraw.json');
  await pqOk(bob, 'withdraw', 'all', '--out', bobFile, '--yes');
  const { args: [recipient, to, amount, signature] } = parseSignedRequest(await readFile(bobFile, 'utf8'), { chainId: 9800, contract });
  const withdrawal = { recipient, to, amount, signature };
  const bobBefore = await diana.client.getBalance({ address: bob.address });
  assert.equal((await send(mallory, 'withdraw', [withdrawal.recipient, withdrawal.to, withdrawal.amount, withdrawal.signature])).status, 'success');
  assert.equal(await diana.client.getBalance({ address: bob.address }), bobBefore + parseEther('3.6'));
  assert.equal((await send(mallory, 'withdraw', [withdrawal.recipient, withdrawal.to, withdrawal.amount, withdrawal.signature])).status, 'reverted');
  // The same signature cannot be redirected.
  assert.equal((await send(mallory, 'withdraw', [withdrawal.recipient, mallory, withdrawal.amount, withdrawal.signature])).status, 'reverted');

  // Change the split: drop carol, add dave. Carol must agree.
  const amended = await send(payer, 'propose',
    ['Community design workshop', price, [alice.address, bob.address, dave.address], [4500, 3500, 2000], id]);
  assert.equal(amended.status, 'success');
  const v2 = await read('agreementCount');
  for (const person of [alice, bob, dave]) await pqOk(person, 'sign', String(v2), '--yes');
  assert.equal((await read('getAgreement', [v2])).status, 1, 'still pending without carol');
  assert.equal((await send(payer, 'checkout', [id, keccak256(stringToHex('old link still works'))], price)).status, 'success');
  assert.match(await pqOk(carol, 'sign', String(v2), '--yes'), /is live/);
  assert.equal((await read('getAgreement', [id])).status, 3);
  assert.equal((await send(payer, 'checkout', [id, keccak256(stringToHex('old link closed'))], price)).status, 'reverted');
  assert.equal((await send(payer, 'checkout', [v2, keccak256(stringToHex('new link'))], price)).status, 'success');
  const carolStatement = await pqOk(carol, 'statement');
  assert.match(carolStatement, /#1 .*Superseded · 20% · 2 sales · 4\.8 QOR/);
  assert.doesNotMatch(carolStatement, /#2 /);
  assert.match(await pqOk(dave, 'statement'), /#2 .*Active · 20% · 1 sale · 2\.4 QOR/);
  assert.ok(diana.stats.verified >= 9, 'every accepted signature was verified with real ML-DSA-87');
});

test('window rules are explained before sending', () => {
  const contractAddress = '0x8b79177437a59fccac3096665f2f4eca4c63a8f4';
  // The shape Diana returns.
  const live = { found: true, live: true, native_only: false, allowed_targets: [contractAddress], remaining_txs: '19', remaining_value: '14967528' };
  assert.equal(windowProblem(live, { contract: contractAddress, valueWei: parseEther('12') }), undefined);
  assert.match(windowProblem(live, { contract: '0x0000000000000000000000000000000000000001' }), /does not allow Treaty/);
  assert.match(windowProblem(live, { contract: contractAddress, valueWei: parseEther('15') }), /less value left/);
  assert.match(windowProblem({ ...live, remaining_txs: '0' }, { contract: contractAddress }), /used every transaction/);
  assert.match(windowProblem({ found: false }, { contract: contractAddress }), /no live EVM window/);
  assert.equal(windowProblem({ ...live, allowed_targets: [] }, { contract: '0x0000000000000000000000000000000000000001' }), undefined);
});

test('agents: limits from an owner, a service treaty, delivery, review, release, off switch and refund', async () => {
  const { alice: owner, bob: agent, carol: provider, dave: helper } = people;
  // The agent agrees to its owner's limits; the owner sets them.
  const approval = join(work, 'approval.json');
  assert.match(await pqOk(agent, 'approve-owner', '--owner', owner.address, '--max-per-treaty', '10', '--max-total', '15', '--days', '7', '--out', approval, '--yes'),
    /Saved the agent’s approval/);
  assert.match((await pq(helper, 'set-limits', '--approval', approval, '--yes')).output, /names .* as owner, not you/);
  await pqOk(owner, 'set-limits', '--approval', approval, '--yes');
  assert.match(await pqOk(agent, 'statement'), /owner\s+.*\n\s+limits\s+10 QOR per treaty, 0 QOR of 15 QOR committed/);

  const earnedBefore = await Promise.all([provider, helper].map(({ address }) => read('claimable', [address])));
  // The agent's service treaty: 2 QOR per unit, up to 5, with a two-minute review.
  const deadline = (await diana.client.getBlock()).timestamp + 3600n;
  const propose = (maxUnits) => send(payer, 'proposeService', ['Clean five datasets', parseEther('2'), maxUnits, deadline, 120,
    agent.address, [provider.address, helper.address], [8000, 2000]]);
  assert.equal((await propose(5)).status, 'success');
  const id = await read('agreementCount');
  assert.match(await pqOk(agent, 'show', String(id)), /Service treaty #\d+ · Pending[\s\S]*budget 10 QOR/);
  for (const person of [provider, helper, agent]) await pqOk(person, 'sign', String(id), '--yes');
  assert.equal((await read('getAgreement', [id])).status, 2);

  // Over the owner's per-treaty limit: the agent cannot even agree.
  assert.equal((await propose(6)).status, 'success');
  const greedy = await read('agreementCount');
  for (const person of [provider, helper]) await pqOk(person, 'sign', String(greedy), '--yes');
  assert.match((await pq(agent, 'sign', String(greedy), '--yes')).output, /MandateLimitExceeded/);

  await pqOk(agent, 'fund', String(id), '--yes');
  assert.equal((await read('getMandate', [agent.address])).committed, parseEther('10'));

  // Delivery, acceptance, rejection relayed by someone else, and release.
  // The first delivery is private: sealed to the client with QoreSeal, only its hash on chain.
  const sealKey = join(work, 'client.sealkey');
  await (await import('node:fs/promises')).writeFile(sealKey, await pqOk(agent, 'seal-key'));
  const envelope = join(work, 'delivery-0.qoreseal');
  const sealed = await pqOk(provider, 'deliver', String(id), '--text', 'dataset 1', '--seal', sealKey, '--envelope', envelope, '--yes');
  assert.match(sealed, /Sealed envelope saved/);
  assert.match(sealed, /This is delivery 0/);
  assert.match(await readFile(envelope, 'utf8'), /^qoreseal:/);
  assert.equal((await readFile(envelope, 'utf8')).includes('dataset 1'), false, 'the envelope does not contain the work');
  assert.match((await pq(helper, 'open', String(id), '0', '--file', envelope)).output, /does not open with your seal keys/);
  assert.match((await pq(agent, 'open', String(id), '1', '--file', envelope)).output, /has no delivery 1|does not open/);
  assert.equal((await pqOk(agent, 'open', String(id), '0', '--file', envelope)).trim(), 'dataset 1');
  assert.match((await pq(helper, 'accept', String(id), '0', '--yes')).output, /Only the client/);
  await pqOk(agent, 'accept', String(id), '0', '--yes');
  assert.equal(await read('claimable', [provider.address]), earnedBefore[0] + parseEther('1.6'));
  const file = join(work, 'dataset-2.csv');
  await (await import('node:fs/promises')).writeFile(file, 'id,value\n1,\n');
  await pqOk(helper, 'deliver', String(id), '--file', file, '--yes');
  const rejection = join(work, 'reject.json');
  await pqOk(agent, 'reject', String(id), '1', '--out', rejection, '--yes');
  const relayed = parseSignedRequest(await readFile(rejection, 'utf8'), { chainId: 9800, contract });
  assert.equal((await send(mallory, relayed.action, relayed.args)).status, 'success');
  await pqOk(provider, 'deliver', String(id), '--text', 'dataset 2, fixed', '--yes');
  assert.match((await pq(helper, 'release', String(id), '2')).output, /ReviewPeriodNotOver/);
  await diana.advance(121);
  await pqOk(helper, 'release', String(id), '2');
  assert.match(await pqOk(helper, 'show', String(id)), /delivery 0 · Accepted[\s\S]*delivery 1 · Rejected[\s\S]*delivery 2 · Released/);

  // A stolen classical key cannot deliver junk or withdraw.
  assert.match(await pqOk(provider, 'attack'), /BLOCKED by Treaty: BadPqcSignature/);

  // The owner switches the agent off; the agent cannot accept anything any more.
  await pqOk(owner, 'revoke', agent.address, '--yes');
  await pqOk(provider, 'deliver', String(id), '--text', 'dataset 3', '--yes');
  assert.match((await pq(agent, 'accept', String(id), '3', '--yes')).output, /AgentNotAuthorized/);
  assert.match(await pqOk(agent, 'statement'), /switched off/);

  // After the deadline: the ignored delivery is released, and the unused budget goes to the owner.
  await diana.advance(3600);
  await pqOk(helper, 'release', String(id), '3');
  const before = await diana.client.getBalance({ address: owner.address });
  assert.match(await pqOk(helper, 'refund', String(id)), /Unused budget: 4 QOR/);
  assert.equal(await diana.client.getBalance({ address: owner.address }), before + parseEther('4'));
  assert.equal((await read('getMandate', [agent.address])).committed, parseEther('6'));

  // Three units paid, split 80/20 between the team.
  assert.equal(await read('claimable', [provider.address]), earnedBefore[0] + parseEther('4.8'));
  assert.equal(await read('claimable', [helper.address]), earnedBefore[1] + parseEther('1.2'));
  // The provider withdraws with its own key, to another address.
  const destination = getAddress(toHex(crypto.getRandomValues(new Uint8Array(20))));
  await pqOk(provider, 'withdraw', 'all', '--to', destination, '--yes');
  assert.equal(await read('claimable', [provider.address]), 0n);
  assert.equal(await diana.client.getBalance({ address: destination }), earnedBefore[0] + parseEther('4.8'));
});

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    return undefined;
  }
}

test('web app in a browser: revenue share and service treaty, relay, pay, verify on both VMs, statements and amendments', { timeout: 240_000 }, async (t) => {
  const playwright = loadPlaywright();
  if (!playwright) {
    t.skip('Playwright is not installed. Install it to run the browser part: npm i -D playwright && npx playwright install chromium');
    return;
  }
  const { alice, dave: bob, carol } = people;
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '0', '--strictPort=false', '--host', '127.0.0.1'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_TREATY_ADDRESS: contract, VITE_TREATY_RPC: diana.url, QORE_NATIVE_REST: diana.url },
  });
  let viteLog = '';
  const appUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite did not start:\n' + viteLog)), 30_000);
    vite.on('exit', (code) => reject(new Error('Vite exited ' + code + ':\n' + viteLog)));
    for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => {
      viteLog += chunk;
      const match = viteLog.replace(/\x1b\[[\d;]*m/g, '').match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)\//);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const browser = await playwright.chromium.launch();
  t.after(async () => {
    await browser.close();
    vite.kill();
    await once(vite, 'exit').catch(() => {});
  });

  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  // A stand-in wallet: the payer's unlocked account on the local chain.
  // A stand-in QoreX wallet: it signs with the official QoreSign library, as QoreX does, with the
  // keys of whichever person the test puts it on. Its ML-DSA-87 signatures are real.
  const { classicalKeyFromPrivate, signMessage } = await import('@qorechain/qoresign');
  const { deriveUnifiedAccount } = await import('@qorechain/sdk');
  let qorexPerson = alice;
  const qorexKeys = async () => deriveUnifiedAccount(qorexPerson.mnemonic, 0);
  await page.exposeFunction('__qorexAddress', async () => (await qorexKeys()).cosmos);
  await page.exposeFunction('__qorexSign', async (chainId, signer, data) => {
    const keys = await qorexKeys();
    assert.equal(signer, keys.cosmos, 'QoreX is asked to sign for its own account');
    assert.ok(data.startsWith('Treaty: '), 'the person sees readable Treaty text');
    return signMessage({
      chainId, signer, data, classicalKey: classicalKeyFromPrivate(hexToBytes(keys.privateKey), 'eth_secp256k1'), pqKey: keys.pqc,
    });
  });
  await page.addInitScript(() => {
    // Announces message signing, which today's QoreX does not yet; test/qorex.test.js checks
    // the same flow against the official QoreX mock.
    window.qorex = { native: {
      isQoreX: true,
      capabilities: ['signArbitrary'],
      async signDirect() { throw new Error('not used by Treaty'); },
      async enable() {},
      async getKey() { return { bech32Address: await window.__qorexAddress() }; },
      signArbitrary: (chainId, signer, data) => window.__qorexSign(chainId, signer, data),
    } };
  });
  await page.addInitScript(({ from, rpc }) => {
    window.ethereum = {
      isMetaMask: true, on() {},
      async request({ method, params }) {
        // A test can switch the wallet's account; the local chain impersonates it.
        const current = sessionStorage.getItem('wallet-account') || from;
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [current];
        if (method === 'eth_chainId') return '0x2648';
        if (method.startsWith('wallet_')) return null;
        const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const body = await response.json();
        if (body.error) throw Object.assign(new Error(body.error.message), body.error);
        return body.result;
      },
    };
  }, { from: payer, rpc: diana.url });
  const statusText = async () => (await page.textContent('#status')).trim();
  const loaded = (target) => target.waitForFunction(() => {
    const heading = document.querySelector('#content h1')?.textContent ?? '';
    return heading && !heading.startsWith('Reading QoreChain');
  }, null, { timeout: 30_000 });
  const go = async (hash) => {
    const target = appUrl + '/' + hash;
    // Going to the same hash is not a navigation, so reload to read fresh chain state.
    if (page.url() === target) await page.reload();
    else await page.goto(target);
    await loaded(page);
  };

  // Propose in the app.
  await go('#create');
  await page.fill('#title', 'Zine print run');
  await page.fill('#price', '3');
  const fields = await page.$$('input[name=recipient]');
  await fields[0].fill(alice.address);
  await fields[1].fill(bob.address);
  await page.fill('#share-2', '40');
  await page.click('#create-form button[type=submit]');
  await page.waitForURL(/#agreement\//, { timeout: 30_000 });
  await page.waitForSelector('.signers li');
  const id = page.url().split('/').pop();
  assert.match(await page.textContent('.tag'), /Waiting for signatures · 0 of 2/);
  assert.match(await page.textContent('.command code'), new RegExp('npm run pq -- sign ' + id));
  assert.match(await page.textContent('.signers'), /ML-DSA-87 key registered/);

  // Pending link: no checkout yet.
  await go('#pay/' + contract + '/' + id);
  assert.match(await page.textContent('.intro'), /opens when every party has signed/);

  // Alice signs in the browser with QoreX; Bob's saved signature is relayed from the app.
  await go('#agreement/' + contract + '/' + id);
  await page.click('[data-qorex-sign="' + alice.address + '"]');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Your signature is recorded'), null, { timeout: 30_000 });
  const bobFile = join(work, 'bob-zine.json');
  await pqOk(bob, 'sign', id, '--yes', '--out', bobFile);
  await go('#agreement/' + contract + '/' + id);
  assert.match(await page.textContent('.tag'), /1 of 2/);
  await page.fill('#signed-request', await readFile(bobFile, 'utf8'));
  await page.click('.relay-form button');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('The treaty is live'), null, { timeout: 30_000 });
  await page.waitForSelector('.tag.ok');
  assert.match(await page.textContent('.tag'), /Live · terms recorded on EVM and Native/);

  // Pay and verify the receipt on both VMs.
  await go('#pay/' + contract + '/' + id);
  await page.click('#pay');
  await page.waitForURL(/#receipt\//, { timeout: 30_000 });
  await page.waitForSelector('.tag');
  assert.match(await page.textContent('.tag'), /Verified on EVM and Native/);
  assert.match(await page.textContent('.breakdown'), /1\.8 QOR[\s\S]*1\.2 QOR/);
  const receiptHash = page.url().split('/').pop();
  const receipt = await diana.client.getTransactionReceipt({ hash: receiptHash });
  assert.equal(receipt.status, 'success');

  // A forged withdrawal pasted into the app is refused with a clear reason.
  await go('#submit');
  await page.fill('#signed-request', JSON.stringify({
    kind: 'treaty-signed-request', version: 3, chainId: 9800, contract, action: 'withdraw',
    recipient: alice.address, to: mallory, amount: parseEther('1').toString(), signature: '0x' + '11'.repeat(4627),
  }));
  await page.click('.relay-form button');
  await page.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'error', null, { timeout: 30_000 });
  assert.match(await statusText(), /does not match the signer’s registered key/);

  // A real withdrawal relayed from the app lands on the statement page.
  const aliceFile = join(work, 'alice-withdraw.json');
  await pqOk(alice, 'withdraw', '1.8', '--out', aliceFile, '--yes');
  await page.fill('#signed-request', await readFile(aliceFile, 'utf8'));
  await page.click('.relay-form button');
  await page.waitForURL(/#statement\//, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Withdrew 1.8 QOR'), null, { timeout: 30_000 });
  const available = await read('claimable', [alice.address]);
  assert.match(await page.textContent('.amount'), new RegExp(formatEther(available).replace('.', '\\.') + ' QOR'));
  assert.match(await page.textContent('.tag'), /Balances match the signed treaties/);
  await page.waitForSelector('.history li');
  assert.match(await page.textContent('#withdrawals'), /1\.8 QOR/);

  // The replaced workshop link sends payers to the current version.
  await go('#pay/' + contract + '/1');
  assert.match(await page.textContent('.intro'), /replaced this payment link/);
  await page.click('.intro a');
  await page.waitForSelector('#pay');
  assert.match(page.url(), new RegExp('#pay/' + contract + '/2$'));

  // Propose a change in the app: replace bob with carol. Bob must still sign it.
  await go('#create/' + contract + '/' + id);
  assert.equal(await page.inputValue('#title'), 'Zine print run');
  assert.equal(await page.inputValue('#price'), '3');
  const amendFields = await page.$$('input[name=recipient]');
  await amendFields[1].fill(carol.address);
  await page.click('#create-form button[type=submit]');
  await page.waitForURL((url) => /#agreement\//.test(url.href) && !url.href.endsWith('/' + id), { timeout: 30_000 });
  await page.waitForSelector('.signers li');
  const signers = await page.textContent('.signers');
  assert.match(signers, new RegExp(bob.address));
  assert.match(signers, /on the version being replaced/);
  assert.match(await page.textContent('.tag'), /0 of 3/);

  // A service treaty made in the app: alice hires carol, anyone funds, work is delivered and paid.
  await go('#service');
  const inThreeDays = new Date(Date.now() + 3 * 86_400_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.fill('#title', 'Translate ten pages');
  await page.fill('#client', alice.address);
  await page.fill('#price', '1');
  await page.fill('#units', '3');
  await page.fill('#deadline', inThreeDays);
  await page.fill('#review', '2');
  await (await page.$('input[name=recipient]')).fill(carol.address);
  assert.match(await page.textContent('#split-preview'), /3 × 1 QOR = 3 QOR/);
  await page.click('#create-form button[type=submit]');
  await page.waitForURL(/#agreement\//, { timeout: 30_000 });
  await page.waitForSelector('.signers li');
  const job = page.url().split('/').pop();
  assert.match(await page.textContent('.eyebrow'), /Service treaty/);
  assert.match(await page.textContent('.signers'), /Provider[\s\S]*Client/);
  await pqOk(carol, 'sign', job, '--yes');
  await pqOk(alice, 'sign', job, '--yes');
  await go('#agreement/' + contract + '/' + job);
  assert.match(await page.textContent('.tag'), /waiting for the budget/);
  // Only the client can lock the budget: the payer's wallet is refused before anything is sent.
  await page.click('#fund');
  await page.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'error', null, { timeout: 30_000 });
  assert.match(await statusText(), /Only the client/);
  await diana.client.request({ method: 'hardhat_impersonateAccount', params: [alice.address] });
  await page.evaluate((account) => sessionStorage.setItem('wallet-account', account), alice.address);
  await go('#agreement/' + contract + '/' + job);
  await page.click('#fund');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('is locked'), null, { timeout: 30_000 });
  assert.match(await page.textContent('.tag'), /budget locked/);
  // Carol delivers a file with QoreX in the browser; only its hash goes on chain.
  qorexPerson = carol;
  await go('#agreement/' + contract + '/' + job);
  const pages = Buffer.from('ten translated pages');
  await page.setInputFiles('#work', { name: 'pages.txt', mimeType: 'text/plain', buffer: pages });
  await page.click('#deliver-form button');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Delivery 0 recorded'), null, { timeout: 30_000 });
  assert.equal((await read('getDelivery', [BigInt(job), 0n])).deliverable, keccak256(pages));
  // Alice's acceptance is saved by the tool and relayed from the app.
  const acceptance = join(work, 'alice-accept.json');
  await pqOk(alice, 'accept', job, '0', '--out', acceptance, '--yes');
  await go('#agreement/' + contract + '/' + job);
  await page.fill('#signed-request', await readFile(acceptance, 'utf8'));
  await page.click('.relay-form button');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('accepted and paid'), null, { timeout: 30_000 });
  assert.match(await page.textContent('.ledger table'), /Accepted · paid/);
  await page.waitForSelector('#payments li');
  assert.match(await page.textContent('#payments'), /Delivery 0 · accepted[\s\S]*Verified on EVM and Native/);
  // Alice ignores the next delivery; after the review period anyone releases it from the app.
  await pqOk(carol, 'deliver', job, '--text', 'ten more pages', '--yes');
  await diana.advance(121);
  await go('#agreement/' + contract + '/' + job);
  await page.click('[data-release="1"]');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('released and paid'), null, { timeout: 30_000 });
  assert.match(await page.textContent('.action h2'), /2 units paid of 3/);
  // A third delivery: alice rejects it in the browser with QoreX, so that unit is not paid.
  await pqOk(carol, 'deliver', job, '--text', 'one page, untranslated', '--yes');
  qorexPerson = alice;
  await go('#agreement/' + contract + '/' + job);
  await page.click('[data-qorex-review="reject"][data-unit="2"]');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Delivery 2 rejected'), null, { timeout: 30_000 });
  // After the deadline the unused unit goes back to alice, from the app.
  await diana.advance(4 * 86_400);
  await go('#agreement/' + contract + '/' + job);
  // Anyone may return the unused budget; the payer's wallet does it, so alice pays no gas here.
  await page.evaluate((account) => sessionStorage.setItem('wallet-account', account), payer);
  await go('#agreement/' + contract + '/' + job);
  const aliceBefore = await diana.client.getBalance({ address: alice.address });
  await page.click('#refund');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('returned to'), null, { timeout: 30_000 });
  assert.equal(await diana.client.getBalance({ address: alice.address }), aliceBefore + parseEther('1'));
  // Carol withdraws her earnings in the browser with QoreX.
  qorexPerson = carol;
  const carolEarned = await read('claimable', [carol.address]);
  await go('#statement/' + contract + '/' + carol.address);
  await page.click('#qorex-withdraw');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Withdrew'), null, { timeout: 30_000 });
  assert.equal(await read('claimable', [carol.address]), 0n);
  assert.ok(carolEarned > 0n);

  // The explainer pages: the home page and the live deal replay.
  await go('#home');
  assert.match(await page.textContent('.hero h1'), /Binding deals between AI agents/);
  for (const section of ['what', 'how', 'proof', 'track', 'questions', 'start']) {
    assert.ok(await page.$('#' + section), 'the home page has its ' + section + ' section');
  }
  await go('#live');
  assert.ok((await page.$$('.timeline .event')).length >= 18, 'the live deal shows every step');
  assert.match(await page.textContent('.timeline'), /BadPqcSignature/);

  // Phone width: no horizontal scrolling on the main pages.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const hash of ['#home', '#live', '#create', '#service', '#agreement/' + contract + '/' + id, '#agreement/' + contract + '/' + job, '#statement/' + contract + '/' + alice.address, '#receipt/' + contract + '/' + receiptHash]) {
    await phone.goto(appUrl + '/' + hash);
    await loaded(phone);
    await phone.waitForLoadState('networkidle');
    const width = await phone.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, hash + ' scrolls sideways at phone width (' + width + 'px)');
  }
  assert.deepEqual(errors, []);
});

test('the checkout commitment the app verifies matches the contract event', async () => {
  // Re-derive one checkout commitment from chain data, the way the app's verifier does.
  const { alice, carol: bob } = people;
  const price = parseEther('2');
  await send(payer, 'propose', ['Commitment check', price, [alice.address, bob.address], [5000, 5000], 0n]);
  const id = await read('agreementCount');
  for (const person of [alice, bob]) await pqOk(person, 'sign', String(id), '--yes');
  const reference = keccak256(stringToHex('commitment'));
  const sale = await send(payer, 'checkout', [id, reference], price);
  const { decodeEventLog } = await import('viem');
  const checkout = sale.logs.map((log) => {
    try { return decodeEventLog({ abi, ...log }); } catch { return undefined; }
  }).find((event) => event?.eventName === 'Checkout').args;
  const expected = paymentCommitment({
    chainId: 9800, contract, id, payer, paymentId: checkout.paymentId, total: price,
    recipients: [alice.address, bob.address], credits: [parseEther('1'), parseEther('1')],
  });
  assert.equal(checkout.commitment, expected);
  assert.equal((await lastNativeReceipt()).note, paymentNote(expected));
});

test('the agents demo runs start to finish', { timeout: 180_000 }, async () => {
  const demo = await runNode('examples/agents-demo.js', [], {});
  assert.equal(demo.code, 0, demo.output);
  for (const line of [
    /refused \(MandateLimitExceeded\)\. Olivia’s limit holds/,
    /rejects it: only 40 rows/,
    /tries to withdraw its 3\.2 QOR: BLOCKED \(BadPqcSignature\)/,
    /tries to deliver junk to get paid: BLOCKED \(BadPqcSignature\)/,
    /can no longer sign anything: AgentNotAuthorized/,
    /The unused budget, 4 QOR, goes back to Olivia/,
    /Data agent .* withdrew 4\.8 QOR/,
    /3 datasets paid, 1 rejected, budget settled/,
    /2 forged ones refused/,
  ]) assert.match(demo.stdout, line);
});
