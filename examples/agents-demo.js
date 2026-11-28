// Treaty demo: AI agents make a deal, deliver work, get paid, and a stolen key gets nothing.
//
//   npm run demo               the story locally, in about 30 seconds
//   npm run demo -- --serve    then keep the local chain running and open the web app on it
//   npm run demo -- --diana    the same story on the real QoreChain Diana testnet (about 10 minutes),
//                              with the accounts from `npm run accounts`; every transaction is saved
//                              to deployments/runs/treaty-<id>.json (one file per run)
//
// Locally, everything runs on the Diana stand-in (scripts/local-diana.js): a chain with ID 9800
// whose ML-DSA-87 checks are backed by real ML-DSA-87 verification. On Diana, the chain's own
// pqcVerify and pqcKeyStatus precompiles and the Cross-VM bridge do the work, and each party acts
// through its own scoped EVM window. Every party has its own keys and acts only through the
// Treaty SDK, as separate agents would.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateMnemonic, generatePqcKeypair, pqcSign } from '@qorechain/sdk';
import { hexToBytes, isAddress, parseEther, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deliverableHash } from '../src/protocol.js';
import { Treaty, abi, explain, qor } from '../sdk/treaty.js';
import { loadSigner } from '../sdk/pqc.js';

const live = process.argv.includes('--diana');
const serve = !live && process.argv.includes('--serve');
const root = fileURLToPath(new URL('..', import.meta.url));
const artifact = JSON.parse(await readFile(new URL('../artifacts/Treaty.json', import.meta.url)));
const step = (text) => console.log('\n' + text);
const say = (text) => console.log('   ' + text);
const short = (address) => address.slice(0, 6) + '…' + address.slice(-4);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** An AI agent: its own keys, its own Treaty connection, and a little judgement. */
class Agent {
  constructor(name, treaty) {
    this.name = name;
    this.treaty = treaty;
    this.address = treaty.address;
  }

  toString() { return this.name + ' (' + short(this.address) + ')'; }
}

/** Where the story runs: the local stand-in, or Diana itself. */
async function localNetwork() {
  const { startDiana } = await import('../scripts/local-diana.js');
  const diana = await startDiana({ abi });
  const hash = await diana.wallet.deployContract({ account: diana.accounts[0], abi, bytecode: artifact.bytecode, args: ['qorechain-diana'] });
  const contract = (await diana.client.waitForTransactionReceipt({ hash })).contractAddress;
  diana.useContract(contract);
  return {
    name: 'a local QoreChain Diana stand-in', contract, rpc: diana.url, rest: diana.url, review: 120, deadlineIn: 3600,
    async party(name) {
      const mnemonic = generateMnemonic();
      const signer = await loadSigner({ QORE_MNEMONIC: mnemonic });
      await diana.fund(signer.address, parseEther('50'));
      await diana.registerKey(signer.address, signer.publicKey);
      return new Agent(name, await Treaty.connect({ contract, rpc: diana.url, rest: diana.url, mnemonic }));
    },
    now: async () => (await diana.client.getBlock()).timestamp,
    wait: (seconds) => diana.advance(seconds),
    stats: () => diana.stats.verified + ' ML-DSA-87 signatures checked and accepted; ' + diana.stats.refused + ' forged ones refused.',
    stop: () => diana.stop(),
    diana,
  };
}

async function dianaNetwork() {
  const contract = process.env.VITE_TREATY_ADDRESS;
  if (!isAddress(contract ?? '')) throw new Error('No Treaty deployment in .env.diana. Run: npm run accounts -- deploy');
  const roles = { 'Olivia, a human': 'OWNER', 'Research agent': 'RESEARCHER', 'Data agent': 'DATA', 'Cleaning agent': 'CLEANER' };
  let client;
  return {
    name: 'QoreChain Diana', contract, review: 60, deadlineIn: 9 * 60,
    async party(name) {
      const mnemonic = process.env['MNEMONIC_' + roles[name]];
      if (!mnemonic) throw new Error('.env.diana has no MNEMONIC_' + roles[name] + '. Run: npm run accounts -- create');
      const treaty = await Treaty.connect({ contract, mnemonic });
      client = treaty.client;
      const key = await treaty.keyCheck();
      if (!key.ok) throw new Error(name + ': ' + key.reason + ' Run: npm run accounts -- register');
      return new Agent(name, treaty);
    },
    now: async () => (await client.getBlock()).timestamp,
    /** Real time passes on Diana: wait until the chain's clock has moved on. */
    async wait(seconds) {
      const target = (await this.now()) + BigInt(seconds);
      say('Waiting ' + seconds + ' seconds of chain time on Diana…');
      while ((await this.now()) < target) await sleep(5000);
    },
    stats: () => 'Every signature above was checked by Diana’s own pqcVerify precompile.',
    stop: async () => {},
  };
}

let network;
try {
  network = live ? await dianaNetwork() : await localNetwork();
} catch (error) {
  console.error('The demo could not start: ' + explain(error));
  process.exit(1);
}
/** On Diana, each transaction's Cosmos hash (the explorer's form) is looked up in the background. */
const pending = [];
let researcherLink = async () => undefined;
const record = { network: live ? 'qorechain-diana' : 'local', contract: network.contract, startedAt: new Date().toISOString(), parties: {}, steps: [] };
/** Keep each transaction for the record, and show its explorer link on Diana. */
function track(label, result) {
  const receipt = result?.receipt ?? result;
  if (receipt?.transactionHash) {
    const entry = { step: label, tx: receipt.transactionHash, block: String(receipt.blockNumber) };
    record.steps.push(entry);
    if (live) pending.push(researcherLink(receipt.transactionHash).then((cosmosTx) => {
      if (cosmosTx) entry.cosmosTx = cosmosTx;
    }));
    if (live) say('  ↳ ' + receipt.transactionHash);
  }
  return result;
}

let vite;
async function shutdown() {
  vite?.kill();
  await network.stop();
}
process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)); });

try {
  const olivia = await network.party('Olivia, a human');
  const researcher = await network.party('Research agent');
  const databot = await network.party('Data agent');
  const cleaner = await network.party('Cleaning agent');
  for (const agent of [olivia, researcher, databot, cleaner]) record.parties[agent.name] = agent.address;
  researcherLink = (hash) => researcher.treaty.cosmosHash(hash);

  console.log('Treaty demo on ' + network.name + '. Every party has its own ML-DSA-87 key.');
  console.log('Treaty contract: ' + network.contract);
  say(olivia + ' owns the research agent.');
  say(researcher + ' needs survey data cleaned.');
  say(databot + ' and ' + cleaner + ' sell data cleaning as a team, 80/20.');

  step('1. Olivia puts her agent on a budget');
  const already = await researcher.treaty.mandate();
  const committed = already?.committed ?? 0n;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
  const limits = { owner: olivia.address, maxPerTreaty: parseEther('10'), maxTotal: committed + parseEther('15'), expiry };
  const agentSignature = await researcher.treaty.approveOwner(limits);
  track('owner sets the agent’s limits', await olivia.treaty.setMandate({ agent: researcher.address, ...limits, agentSignature }));
  say('Both signed with ML-DSA-87: at most 10 QOR per treaty, 15 QOR more in total, for 7 days. The contract enforces it.');

  step('2. The research agent proposes a deal');
  const deadline = (await network.now()) + BigInt(network.deadlineIn);
  const terms = {
    title: 'Clean five survey datasets', unitPrice: '2', maxUnits: 5, deadline, reviewPeriod: network.review,
    client: researcher.address, providers: [databot.address, cleaner.address], shares: [8000, 2000],
  };
  const id = await researcher.treaty.proposeService(terms);
  record.treaty = String(id);
  say('Treaty #' + id + ': 2 QOR per cleaned dataset, up to 5, within ' + Math.round(network.deadlineIn / 60) +
    ' minutes. The client has ' + network.review + ' seconds to review each delivery.');

  step('3. Every party reads the terms and signs them');
  for (const agent of [databot, cleaner, researcher]) {
    const agreement = await agent.treaty.agreement(id);
    track(agent.name + ' signs the terms', await agent.treaty.sign(id));
    say(agent + ' checked "' + agreement.title + '" and signed.');
  }
  say('All signed: the treaty is live, and its terms are recorded on QoreChain Native.');

  step('4. The research agent locks the budget');
  track('the client locks the budget', await researcher.treaty.fund(id));
  say('10 QOR is locked in the contract. The data team can see it is there before they start.');
  const greedy = await researcher.treaty.proposeService({ ...terms, title: 'Label 5,000 images', unitPrice: '1', maxUnits: 10, providers: [databot.address], shares: [10000] });
  track('a second treaty for the data agent', await databot.treaty.sign(greedy));
  try {
    await researcher.treaty.sign(greedy);
    say('Unexpected: a second 10 QOR treaty was accepted.');
  } catch (error) {
    say('It tries to commit another 10 QOR elsewhere: refused (' + explain(error) + '). Olivia’s limit holds.');
  }

  step('5. Work is delivered, checked and paid');
  const datasets = [
    JSON.stringify({ survey: 'north', rows: 1200, nulls: 0 }),
    JSON.stringify({ survey: 'south', rows: 40, nulls: 312 }),
    JSON.stringify({ survey: 'south', rows: 1100, nulls: 0 }),
  ];
  /** The research agent's judgement: the delivery must match its hash and be a usable dataset. */
  const judge = (content, onChain) => {
    if (deliverableHash(content) !== onChain) return 'it does not match what was delivered on chain';
    const data = JSON.parse(content);
    if (data.rows < 1000 || data.nulls > 0) return 'only ' + data.rows + ' rows with ' + data.nulls + ' empty values';
  };
  // Deliveries are private: the data agent seals each dataset to the research agent with QoreSeal
  // (ML-KEM-1024 + X25519). Only the hash goes on chain; only the research agent can read the data.
  const sealKey = researcher.treaty.sealKey();
  say('The research agent shares its QoreSeal key, so datasets are encrypted to it with ML-KEM-1024.');
  /** The research agent opens a sealed delivery: it refuses if the data does not match the hash on chain. */
  const receive = async (unit, envelope) => new TextDecoder().decode(await researcher.treaty.openDelivery(id, unit, envelope));
  for (const [i, dataset] of datasets.slice(0, 2).entries()) {
    const { unit, envelope } = track('the data agent delivers dataset ' + (i + 1), await databot.treaty.deliver(id, dataset, { sealTo: sealKey }));
    if (i === 0) {
      say('Dataset 1 travels as a ' + envelope.length.toLocaleString('en') + '-character sealed envelope; on chain there is only its hash.');
      try {
        await cleaner.treaty.openDelivery(id, unit, envelope);
        say('Unexpected: the cleaning agent opened data sealed to the research agent.');
      } catch {
        say('The cleaning agent tries to open it: it cannot. Only the client holds the ML-KEM-1024 key.');
      }
    }
    const content = await receive(unit, envelope);
    const delivery = await researcher.treaty.read('getDelivery', [id, unit]);
    const problem = judge(content, delivery.deliverable);
    if (problem) {
      track('the client rejects it', await researcher.treaty.reject(id, unit));
      say('Dataset ' + (i + 1) + ' delivered. The research agent rejects it: ' + problem + '. Nothing is paid.');
    } else {
      track('the client accepts it', await researcher.treaty.accept(id, unit));
      say('Dataset ' + (i + 1) + ' delivered. The research agent checks it and accepts: 1.6 QOR to the data agent, 0.4 to the cleaner.');
    }
  }
  const { unit: late } = track('the data agent delivers a fixed dataset', await databot.treaty.deliver(id, datasets[2], { sealTo: sealKey }));
  say('Dataset 2 is delivered again, fixed. This time the research agent is busy and does not answer.');
  await network.wait(network.review + 1);
  track('the cleaning agent releases the ignored delivery', await cleaner.treaty.release(id, late));
  say('After the review period anyone may release it, and the cleaning agent does: the team is paid without waiting.');

  step('6. An attacker steals the data agent’s wallet key');
  const thief = '0x000000000000000000000000000000000000dEaD';
  const stolen = privateKeyToAccount(databot.treaty.signer.privateKey);
  const forge = (message) => toHex(pqcSign(generatePqcKeypair().secretKey, hexToBytes(message)));
  const earnings = await databot.treaty.read('claimable', [databot.address]);
  const nonce = await databot.treaty.read('nonces', [databot.address]);
  const { deliveries } = await databot.treaty.read('getAgreement', [id]);
  const attempts = [
    ['withdraw its ' + qor(earnings), 'withdraw', [databot.address, thief, earnings,
      forge(await databot.treaty.read('withdrawalMessage', [databot.address, thief, earnings, nonce]))]],
    ['deliver junk to get paid', 'deliver', [id, databot.address, deliverableHash('junk'),
      forge(await databot.treaty.read('deliveryMessage', [id, BigInt(deliveries), databot.address, deliverableHash('junk')]))]],
  ];
  for (const [what, functionName, args] of attempts) {
    try {
      await databot.treaty.client.simulateContract({ account: stolen, address: network.contract, abi, functionName, args });
      say('Unexpected: the attacker managed to ' + what + '.');
    } catch (error) {
      say('With the classical key alone it tries to ' + what + ': BLOCKED (' + explain(error) + ').');
    }
  }

  step('7. Olivia switches her agent off');
  track('the owner switches the agent off', await olivia.treaty.revoke(researcher.address));
  const { unit: after } = track('the data agent delivers another dataset', await databot.treaty.deliver(id, JSON.stringify({ survey: 'east', rows: 1500, nulls: 0 })));
  try {
    await researcher.treaty.accept(id, after);
  } catch (error) {
    say('The research agent can no longer sign anything: ' + explain(error) + '.');
  }

  step('8. The deadline passes');
  const remaining = Number(deadline - (await network.now())) + 1;
  if (remaining > 0) await network.wait(remaining);
  track('the cleaning agent releases the last delivery', await cleaner.treaty.release(id, after));
  say('The last delivery was never reviewed, so it is released and paid.');
  const before = await databot.treaty.client.getBalance({ address: olivia.address });
  track('the unused budget goes back', await databot.treaty.refund(id));
  const returned = (await databot.treaty.client.getBalance({ address: olivia.address })) - before;
  say('The unused budget, ' + qor(returned) + ', goes back to Olivia, not to the switched-off agent.');

  step('9. The team withdraws with their post-quantum keys');
  for (const agent of [databot, cleaner]) {
    const amount = await agent.treaty.read('claimable', [agent.address]);
    track(agent.name + ' withdraws', await agent.treaty.withdraw('all'));
    say(agent + ' withdrew ' + qor(amount) + '.');
  }

  const treaty = await researcher.treaty.agreement(id);
  step('Done');
  say('Treaty #' + id + ': ' + treaty.sales + ' datasets paid, 1 rejected, budget settled.');
  say(network.stats());
  if (live) {
    await Promise.all(pending);
    record.finishedAt = new Date().toISOString();
    record.explorer = 'https://explore.qore.network/tx/<cosmosTx> (choose Testnet at the top of the explorer first)';
    await mkdir(new URL('../deployments/', import.meta.url), { recursive: true });
    // Each run gets its own file, so later runs never replace the record the website and README cite
    // (deployments/diana-demo.json, the first full run on Diana).
    const file = 'deployments/runs/treaty-' + record.treaty + '.json';
    await mkdir(new URL('../deployments/runs/', import.meta.url), { recursive: true });
    await writeFile(new URL('../' + file, import.meta.url), JSON.stringify(record, null, 2) + '\n');
    say('Saved every transaction to ' + file + '. List these addresses on your project page:');
    for (const [name, address] of Object.entries(record.parties)) say('  ' + name + ': ' + address);
  }

  if (serve) {
    const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
    vite = spawn(process.execPath, [viteBin, '--port', '5173'], {
      cwd: root, stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, VITE_TREATY_ADDRESS: network.contract, VITE_TREATY_RPC: network.rpc, QORE_NATIVE_REST: network.rest },
    });
    let log = '';
    const url = await new Promise((resolve, reject) => {
      vite.on('exit', (code) => reject(new Error('The app server exited (' + code + ').')));
      vite.stdout.on('data', (chunk) => {
        log += chunk;
        const match = log.replace(/\x1b\[[\d;]*m/g, '').match(/Local:\s+(http:\/\/\S+?)\/?\s/);
        if (match) resolve(match[1]);
      });
    });
    step('The web app is running on this chain:');
    say('Treaty    ' + url + '/#agreement/' + network.contract + '/' + id);
    say('Agent     ' + url + '/#statement/' + network.contract + '/' + researcher.address);
    say('Provider  ' + url + '/#statement/' + network.contract + '/' + databot.address);
    say('Press Ctrl+C to stop.');
    await once(vite, 'exit');
  }
} catch (error) {
  console.error('\nThe demo stopped: ' + explain(error));
  process.exitCode = 1;
} finally {
  if (!serve || process.exitCode) await shutdown();
}
