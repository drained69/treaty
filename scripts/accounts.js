// Treaty accounts on QoreChain Diana: create them, register their ML-DSA-87 keys, deploy,
// and open each party's scoped EVM window. Run with: npm run accounts -- <command>
//
//   create     make five fresh testnet accounts in .env.diana (git-ignored) and print their addresses
//   status     balance, ML-DSA-87 key and EVM window of every account
//   register   register the ML-DSA-87 key of every funded account that has none
//   deploy     open a short window for the deployer, deploy Treaty, and save its address
//   windows    open each party's scoped window: only the Treaty contract, capped transactions,
//              value and blocks. These are the agents' on-chain limits the AI Agents track asks for.
//   session [perCall] [perDay] [hours]
//              the owner links the research agent's session key to the OWNER's account, under a
//              spending rule QoreChain enforces: only Treaty.fund and Treaty.refund, at most perCall
//              and perDay QOR (default 6 and 6), for `hours` (default 24). One hybrid transaction.
//   session-status   what the chain enforces for that session, read back from Diana
//   session-revoke   the owner switches the session key off, in one transaction
//   seal-keys  publish each agent's ML-KEM-1024 key in QoreChain's KEM key registry, so providers
//              can seal deliveries to it by address (QoreSeal); see sdk/seal.js
//
// Keys stay in .env.diana on this computer. Use testnet-only accounts that never held mainnet funds.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { StargateClient } from '@cosmjs/stargate';
import { evmWindowCost, evmWindowStatus } from '@qorechain/evm';
import {
  EthNativeSigner, buildRegisterPqcKeyMsg, deriveUnifiedAccount, fetchPqcStatus, generateMnemonic, getNetwork,
  KEM_ALGORITHM_ML_KEM_1024, isRegisteredPqcKey, msg, openEvmWindowMsg, signProofOfPossession,
} from '@qorechain/sdk';
import { fetchKemKey } from '@qorechain/qoreseal/network';
import { formatEther, getAddress, isAddress, parseEther } from 'viem';
import { broadcast as nativeBroadcast, lookupTx } from '../sdk/native.js';
import { sealKeysFor } from '../sdk/seal.js';
import { generateSessionKey, linkSessionMsgs, readSmartAccount, revokeSessionMsg, sessionKey } from '../sdk/smart-account.js';

const FILE = process.env.TREATY_ACCOUNTS_FILE ? new URL('file://' + process.env.TREATY_ACCOUNTS_FILE) : new URL('../.env.diana', import.meta.url);
const ROLES = [
  ['DEPLOYER', 'deploys the Treaty contract'],
  ['OWNER', 'Olivia, the human who owns the research agent'],
  ['RESEARCHER', 'the research agent: the client, on a budget'],
  ['DATA', 'the data agent: a provider (80%)'],
  ['CLEANER', 'the cleaning agent: a provider (20%)'],
];
const testnet = getNetwork('testnet');
const NET = {
  chainId: testnet.chainId,
  rest: process.env.QORE_REST_URL?.trim() || testnet.endpoints.rest,
  rpc: process.env.QORE_RPC_URL?.trim() || testnet.endpoints.rpc,
  evm: process.env.QORE_EVM_RPC?.trim() || 'https://evm-testnet.qore.host',
};
/** A native-lane fee: hybrid transactions are large, so the gas limit is generous. */
const FEE = { amount: [{ denom: 'uqor', amount: '100000' }], gas: '800000' };
/** Diana makes a block about every 1.4 s: 2,500 blocks is about an hour. */
const WINDOW_BLOCKS = BigInt(process.env.TREATY_WINDOW_BLOCKS ?? 2500);
const WINDOW_TXS = BigInt(process.env.TREATY_WINDOW_TXS ?? 30);
/** Value plus fees the window may spend: each transaction is sized at 3M gas at a 250 gwei fee cap, plus 12 QOR of value. */
const perTx = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 250_000_000_000n });

async function loadFile() {
  if (!existsSync(FILE)) throw new Error('No .env.diana yet. Run: npm run accounts -- create');
  const values = {};
  for (const line of (await readFile(FILE, 'utf8')).split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return values;
}

async function accounts() {
  const values = await loadFile();
  return Promise.all(ROLES.map(async ([role, about]) => {
    const mnemonic = values['MNEMONIC_' + role];
    if (!mnemonic) throw new Error('.env.diana has no MNEMONIC_' + role + '.');
    return { role, about, mnemonic, account: await deriveUnifiedAccount(mnemonic, 0) };
  }));
}

async function balanceOf(qor) {
  const response = await fetch(NET.rest + '/cosmos/bank/v1beta1/balances/' + qor + '/by_denom?denom=uqor');
  if (!response.ok) return 0n;
  const body = await response.json();
  return BigInt(body.balance?.amount ?? 0) * 10n ** 12n;
}

async function accountSequence(address) {
  const response = await fetch(NET.rest + '/cosmos/auth/v1beta1/accounts/' + address);
  if (response.status === 404) throw new Error(address + ' does not exist on chain yet: fund it from the faucet first.');
  if (!response.ok) throw new Error('Account query failed: HTTP ' + response.status);
  const body = await response.json();
  const account = body.account?.base_account ?? body.account ?? {};
  return { accountNumber: BigInt(account.account_number ?? 0), sequence: BigInt(account.sequence ?? 0) };
}

/** Sign on the native lane (hybrid, or classical for the key registration) and broadcast. */
async function broadcast(account, mode, messages) {
  const { accountNumber, sequence } = await accountSequence(account.cosmos);
  const signer = new EthNativeSigner(account, { signMode: mode, rest: NET.rest });
  const transport = await StargateClient.connect(NET.rpc);
  try {
    const result = await signer.signAndBroadcast(transport, { chainId: NET.chainId, accountNumber, sequence, fee: FEE, messages });
    if (result.code) throw new Error('Refused by the chain (code ' + result.code + '): ' + (result.rawLog ?? ''));
    return result.transactionHash;
  } finally {
    transport.disconnect();
  }
}

async function openWindow(account, { allowedTargets, maxTxs, maxValue, blocks = WINDOW_BLOCKS }) {
  const message = openEvmWindowMsg({ sender: account.cosmos, blocks, maxTxs, maxValue, allowedTargets });
  return broadcast(account, 'hybrid', [message]);
}

async function setEnv(name, value) {
  const text = await readFile(FILE, 'utf8');
  const line = name + '=' + value;
  const next = new RegExp('^' + name + '=.*$', 'm').test(text) ? text.replace(new RegExp('^' + name + '=.*$', 'm'), line) : text.trimEnd() + '\n' + line + '\n';
  await writeFile(FILE, next, { mode: 0o600 });
}

const commands = {
  async create() {
    if (existsSync(FILE)) throw new Error('.env.diana already exists. Delete it yourself first if you really want new accounts.');
    const lines = ['# Treaty testnet accounts on QoreChain Diana. Testnet only; never reuse these keys on mainnet.'];
    for (const [role, about] of ROLES) lines.push('# ' + about, 'MNEMONIC_' + role + '="' + generateMnemonic() + '"');
    await writeFile(FILE, lines.join('\n') + '\n', { mode: 0o600 });
    console.log('Saved five new accounts to .env.diana (readable only by you, ignored by git).\n');
    for (const { role, about, account } of await accounts()) console.log(role.padEnd(11) + account.cosmos + '  ' + about);
    console.log('\nNext: claim test QOR for each qor1 address at https://dashboard.qorechain.io/faucet');
    console.log('(once every 24 hours per account), then run: npm run accounts -- register');
  },

  async status() {
    const values = await loadFile();
    console.log('Treaty contract: ' + (values.VITE_TREATY_ADDRESS || 'not deployed yet'));
    for (const { role, account } of await accounts()) {
      const [balance, pqc, window] = await Promise.all([
        balanceOf(account.cosmos), fetchPqcStatus({ rest: NET.rest, address: account.cosmos }).catch(() => ({ registered: false })),
        evmWindowStatus({ rest: NET.rest, address: account.cosmos }).catch(() => ({ found: false })),
      ]);
      const key = !pqc.registered ? 'no ML-DSA-87 key' : isRegisteredPqcKey(pqc, account.pqc.publicKey) === false ? 'a DIFFERENT key is registered' : 'ML-DSA-87 key registered';
      const scope = window.found && window.live
        ? 'window live: ' + window.remainingTxs + ' txs, ' + formatEther(window.remainingValue * 10n ** 12n) + ' QOR, ' + window.remainingBlocks + ' blocks' +
          (window.allowedTargets.length ? ', only ' + window.allowedTargets.join(', ') : ', any target')
        : 'no live window';
      console.log(role.padEnd(11) + account.evm + '  ' + formatEther(balance).padStart(10) + ' QOR · ' + key + ' · ' + scope);
    }
  },

  async register() {
    for (const { role, account } of await accounts()) {
      const pqc = await fetchPqcStatus({ rest: NET.rest, address: account.cosmos });
      if (pqc.registered) { console.log(role.padEnd(11) + 'already registered'); continue; }
      if (!(await balanceOf(account.cosmos))) { console.log(role.padEnd(11) + 'not funded yet: claim from the faucet first'); continue; }
      // Registration is the one message the chain accepts signed classically, with a proof of possession.
      const proofOfPossession = signProofOfPossession({ chainId: NET.chainId, account: account.cosmos, keypair: account.pqc });
      const hash = await broadcast(account, 'classical', [buildRegisterPqcKeyMsg(account.cosmos, { pqcKeypair: account.pqc, proofOfPossession })]);
      console.log(role.padEnd(11) + 'registered · ' + hash);
    }
  },

  async deploy() {
    const [deployer] = await accounts();
    const { account } = deployer;
    // Contract creation needs a window without a target list: two transactions, about ten minutes.
    console.log('Opening a short deployment window for ' + account.cosmos + '…');
    // The deployment sends 7M gas (Diana's RPC caps gas estimates at 5M, close to what it needs).
    const deployCost = evmWindowCost({ gas: 7_000_000n, maxFeePerGas: 300_000_000_000n });
    console.log('  ' + await openWindow(account, { allowedTargets: [], maxTxs: 2n, maxValue: deployCost * 2n, blocks: 400n }));
    const child = spawn(process.execPath, [new URL('./deploy.js', import.meta.url).pathname], {
      stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, DIANA_DEPLOYER_KEY: account.privateKey, QORE_EVM_RPC: NET.evm },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
    const code = await new Promise((resolve) => child.on('close', resolve));
    const address = output.match(/VITE_TREATY_ADDRESS=(0x[\da-fA-F]{40})/)?.[1];
    if (code || !address) throw new Error('The deployment did not complete.');
    await setEnv('VITE_TREATY_ADDRESS', getAddress(address));
    console.log('Saved VITE_TREATY_ADDRESS to .env.diana. Next: npm run accounts -- windows');
  },

  async windows() {
    const values = await loadFile();
    const treaty = values.VITE_TREATY_ADDRESS;
    if (!isAddress(treaty ?? '')) throw new Error('Deploy first: npm run accounts -- deploy');
    const value = (qor) => BigInt(qor) * 1_000_000n;
    for (const { role, account } of (await accounts()).slice(1)) {
      // The research agent locks a 10 QOR budget; everyone else moves no value, only fees.
      const maxValue = perTx * WINDOW_TXS + (role === 'RESEARCHER' || role === 'OWNER' ? value(12) : 0n);
      const hash = await openWindow(account, { allowedTargets: [treaty], maxTxs: WINDOW_TXS, maxValue });
      console.log(role.padEnd(11) + 'window: only ' + treaty + ', ' + WINDOW_TXS + ' txs, ' + WINDOW_BLOCKS + ' blocks · ' + hash);
    }
    console.log('Each party can now act only on Treaty, within those limits. Next: npm run demo -- --diana');
  },

  async ['seal-keys']() {
    for (const { role, mnemonic, account } of (await accounts()).slice(1)) {
      // The same keys the SDK opens sealed deliveries with: QoreSeal's derivation from the mnemonic.
      const { mlkemPublicKey } = sealKeysFor({ mnemonic });
      const current = await fetchKemKey({ rest: NET.rest, address: account.cosmos });
      if (current.registered && Buffer.from(current.publicKey).equals(Buffer.from(mlkemPublicKey))) {
        console.log(role.padEnd(11) + 'seal key already published'); continue;
      }
      // Registering needs the account's hybrid (ML-DSA-87) signature; registering again replaces the key.
      const message = msg.pqc.registerKemKey({ sender: account.cosmos, algorithmId: KEM_ALGORITHM_ML_KEM_1024, publicKey: mlkemPublicKey });
      console.log(role.padEnd(11) + 'seal key published · ' + await broadcast(account, 'hybrid', [message]));
    }
    console.log('Providers can now seal deliveries to these agents by address: deliver(id, work, { sealTo: \'chain\' }).');
  },
};

async function sessionParties() {
  const values = await loadFile();
  const contract = values.VITE_TREATY_ADDRESS;
  if (!isAddress(contract ?? '')) throw new Error('Deploy first: npm run accounts -- deploy');
  const [, owner, researcher] = await accounts();
  let secret = values.SESSION_KEY_RESEARCHER;
  if (!secret) {
    secret = generateSessionKey();
    await setEnv('SESSION_KEY_RESEARCHER', secret);
    console.log('Created the research agent’s session key (ed25519) in .env.diana. It holds no money.');
  }
  return { contract: getAddress(contract), owner: owner.account, researcher: researcher.account, session: sessionKey(secret) };
}

const qorText = (amount) => {
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error('Give amounts in QOR, like 6 or 2.5.');
  return parseEther(amount);
};

Object.assign(commands, {
  async session() {
    const [perCall = '6', perDay = '6', hours = '24'] = process.argv.slice(3);
    const { contract, owner, session } = await sessionParties();
    const messages = linkSessionMsgs({
      owner: owner.cosmos, session, contract, perCall: qorText(perCall), perDay: qorText(perDay), hours: Number(hours),
      label: 'Treaty research agent',
    });
    const sent = await nativeBroadcast(owner, messages, { memo: 'Treaty: link the research agent session' });
    const tx = await lookupTx(sent.transactionHash);
    console.log('Linked the research agent’s session key to ' + owner.cosmos + (tx.hybrid ? ' (hybrid ML-DSA-87: verified)' : ''));
    console.log('  may call  only Treaty.fund and Treaty.refund on ' + contract);
    console.log('  limits    ' + perCall + ' QOR per call, ' + perDay + ' QOR per day, for ' + hours + ' hours');
    console.log('  tx        ' + sent.transactionHash);
  },

  async 'session-status'() {
    const { contract, owner, session } = await sessionParties();
    const state = await readSmartAccount({ owner: owner.cosmos, session, contract, rest: NET.rest });
    console.log('Smart account ' + owner.cosmos + ' · balance ' + formatEther(await balanceOf(owner.cosmos)) + ' QOR');
    for (const rule of state.rules) {
      console.log('  rule "' + rule.id + '" ' + (rule.enabled ? 'on' : 'off') + ': ' + formatEther(rule.perTxLimit * 10n ** 12n) + ' QOR per call, ' +
        formatEther(rule.dailyLimit * 10n ** 12n) + ' QOR per day, only ' + (rule.allowedEvmCalls.map(state.describe).join(', ') || 'value transfers'));
    }
    if (!state.key) { console.log('  session key: not linked. Run: npm run accounts -- session'); return; }
    console.log('  session key: ' + (state.key.revoked ? 'REVOKED' : 'linked') + ', may: ' + state.key.permissions.join(',') +
      ', expires ' + new Date(Number(state.key.expiryUnix) * 1000).toISOString().slice(0, 16) + 'Z, calls made: ' + state.calls);
  },

  async 'session-revoke'() {
    const { owner, session } = await sessionParties();
    const sent = await nativeBroadcast(owner, [revokeSessionMsg({ owner: owner.cosmos, session })], { memo: 'Treaty: revoke the research agent session' });
    console.log('Session key revoked · ' + sent.transactionHash);
  },
});

const [command = 'status'] = process.argv.slice(2);
if (!commands[command]) {
  console.error('Use: npm run accounts -- create | status | register | deploy | windows | seal-keys | session | session-status | session-revoke');
  process.exit(1);
}
commands[command]().catch((error) => {
  console.error(error?.shortMessage ?? error?.message ?? error);
  process.exitCode = 1;
});
