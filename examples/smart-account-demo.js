// Treaty, act two: the owner's money under QoreChain's own spending rules.
//
//   npm run demo:session      on QoreChain Diana, with the accounts from `npm run accounts`
//                             (about 8 minutes). Every transaction is saved to
//                             deployments/diana-smart-account.json for the submission.
//
// Act one (npm run demo -- --diana) shows Treaty's own mandate: the contract caps what an agent
// may commit. Here the money stays in the OWNER's account until the moment it is locked, and the
// agent can reach it only through a session key the owner linked to her account with QoreChain's
// abstractaccount module. The chain itself checks every call the key makes:
//
//   - only Treaty.fund and Treaty.refund on this contract (allowed_evm_calls);
//   - at most 6 QOR per call and 6 QOR per day (the spending rule);
//   - for 24 hours, and the owner can switch it off in one transaction.
//
// Olivia, the owner, never sends an EVM transaction and never opens an EVM window: she agrees with
// ML-DSA-87 signatures (relayed by her agent) and one hybrid Native transaction per change.
// Before running: `npm run accounts -- windows` so the research and data agents have live windows.
import { mkdir, writeFile } from 'node:fs/promises';
import { encodeFunctionData, erc20Abi, isAddress, maxUint256, parseEther } from 'viem';
import { Treaty, abi, explain, qor } from '../sdk/treaty.js';
import { NET, broadcast, lookupTx } from '../sdk/native.js';
import { OwnerSession, generateSessionKey, linkSessionMsgs, revokeSessionMsg, sessionKey } from '../sdk/smart-account.js';

const contract = process.env.VITE_TREATY_ADDRESS;
const step = (text) => console.log('\n' + text);
const say = (text) => console.log('   ' + text);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** The fest's test fUSD token on Diana's EVM: a classic drain is an unlimited approval to the attacker. */
const FUSD = '0x97143B771D34ddb9130b807b135Ae675A5a963CA';
const PER_CALL = parseEther('6');
const PER_DAY = parseEther('6');

if (!isAddress(contract ?? '')) {
  console.error('No Treaty deployment in .env.diana. Run: npm run accounts -- deploy');
  process.exit(1);
}

const record = {
  network: 'qorechain-diana', contract, act: 'chain-enforced spending rules (QoreChain smart account)',
  startedAt: new Date().toISOString(), parties: {}, rule: {}, steps: [],
};
const pending = [];
let cosmosOf = async () => undefined;

/** An EVM transaction sent by a party's own wallet. */
function trackEvm(label, result) {
  const receipt = result?.receipt ?? result;
  const entry = { step: label, kind: 'evm', tx: receipt.transactionHash, block: String(receipt.blockNumber), outcome: 'success' };
  record.steps.push(entry);
  pending.push(cosmosOf(receipt.transactionHash).then((hash) => { if (hash) entry.cosmosTx = hash; }));
  say('  ↳ ' + receipt.transactionHash);
  return result;
}

/** A Native-lane transaction (hybrid-signed), or a smart-account execution relayed in one. */
function trackNative(label, outcome) {
  const entry = { step: label, kind: 'native', cosmosTx: outcome.cosmosTx, height: String(outcome.height), outcome: outcome.success === false ? 'refused' : 'success' };
  if (outcome.reason) entry.reason = outcome.reason;
  if (outcome.tx) entry.tx = outcome.tx;
  record.steps.push(entry);
  say('  ↳ ' + outcome.cosmosTx + (outcome.hybrid ? ' · hybrid ML-DSA-87 verified' : ''));
  return outcome;
}

async function party(name, role) {
  const mnemonic = process.env['MNEMONIC_' + role];
  if (!mnemonic) throw new Error('.env.diana has no MNEMONIC_' + role + '. Run: npm run accounts -- create');
  const treaty = await Treaty.connect({ contract, mnemonic });
  const key = await treaty.keyCheck();
  if (!key.ok) throw new Error(name + ': ' + key.reason + ' Run: npm run accounts -- register');
  record.parties[name] = treaty.address;
  return { name, treaty, address: treaty.address, account: treaty.signer.unified };
}

try {
  const olivia = await party('Olivia, a human', 'OWNER');
  const researcher = await party('Research agent', 'RESEARCHER');
  const databot = await party('Data agent', 'DATA');
  const { client } = researcher.treaty;
  cosmosOf = (hash) => researcher.treaty.cosmosHash(hash);
  const now = async () => (await client.getBlock()).timestamp;
  const balance = (address) => client.getBalance({ address });
  const session = sessionKey(process.env.SESSION_KEY_RESEARCHER || generateSessionKey());
  const owner = new OwnerSession({ contract, owner: olivia.address, session, relayer: researcher.account, client, net: NET });
  /** A session call the chain may refuse: a refusal is a result, not an error. */
  const attempt = async (call) => {
    try {
      return await call();
    } catch (error) {
      const reason = String(error?.message ?? error).match(/(?:failed to execute message|rpc error)[^:]*: (.+?)(?: \[|$)/)?.[1] ?? explain(error);
      return { success: false, reason, cosmosTx: '(refused before inclusion)', height: '-' };
    }
  };

  console.log('Treaty, act two, on QoreChain Diana: the owner’s money under the chain’s own rules.');
  console.log('Treaty contract: ' + contract);
  say(olivia.name + ' keeps her money in her own account, ' + olivia.account.cosmos + '.');
  say('Her research agent holds a session key (ed25519) that holds no money: ' + session.publicHex.slice(0, 16) + '…');

  step('1. Olivia renews her agent’s mandate (Treaty’s own limit, checked by the contract)');
  const already = await researcher.treaty.mandate();
  const committed = already?.owner?.toLowerCase() === olivia.address.toLowerCase() ? already.committed : 0n;
  const limits = { owner: olivia.address, maxPerTreaty: parseEther('6'), maxTotal: committed + parseEther('6'), expiry: BigInt(Math.floor(Date.now() / 1000) + 2 * 86400) };
  const agentSignature = await researcher.treaty.approveOwner(limits);
  const request = await olivia.treaty.setMandate({ agent: researcher.address, ...limits, agentSignature }, { relay: true });
  trackEvm('owner renews the agent’s mandate (relayed by the agent)', await researcher.treaty.relay(request));
  say('Both signed with ML-DSA-87; the agent relayed it. Olivia sent no EVM transaction: at most 6 QOR, for 2 days.');

  step('2. Olivia links the agent’s session key to her account (QoreChain’s limit, checked by the chain)');
  const link = await broadcast(olivia.account, linkSessionMsgs({
    owner: olivia.account.cosmos, session, contract, perCall: PER_CALL, perDay: PER_DAY, hours: 24, label: 'Treaty research agent',
  }), { memo: 'Treaty: link the research agent session' });
  const linked = await lookupTx(link.transactionHash);
  trackNative('owner links the session key with a spending rule', { cosmosTx: link.transactionHash, height: linked.height, hybrid: linked.hybrid });
  const state = await owner.status();
  const rule = state.rules[0];
  record.rule = {
    account: state.account, sessionKey: session.publicHex, permissions: state.key?.permissions, perCallUqor: String(rule.perTxLimit),
    perDayUqor: String(rule.dailyLimit), allowedEvmCalls: rule.allowedEvmCalls, expiry: String(state.key?.expiryUnix),
  };
  say('One hybrid transaction: MsgUpdateSpendingRules + MsgRegisterAuthenticator. Read back from Diana:');
  say('  may call ' + rule.allowedEvmCalls.map(state.describe).join(' and ') + ' · permission "' + state.key?.permissions.join(',') + '"');
  say('  at most ' + qor(rule.perTxLimit * 10n ** 12n) + ' per call and ' + qor(rule.dailyLimit * 10n ** 12n) + ' per day · expires in 24 hours');

  step('3. The research agent agrees a deal with the data agent');
  const deadline = (await now()) + 7n * 60n;
  const id = await researcher.treaty.proposeService({
    title: 'Label four image batches', unitPrice: '1.5', maxUnits: 4, deadline, reviewPeriod: 60,
    client: researcher.address, providers: [databot.address], shares: [10000],
  });
  record.treaty = String(id);
  trackEvm('the data agent signs the terms', await databot.treaty.sign(id));
  trackEvm('the research agent signs: the treaty goes live', await researcher.treaty.sign(id));
  say('Treaty #' + id + ': 1.5 QOR per batch, up to 4, so a 6 QOR budget. Both signed with ML-DSA-87.');

  step('4. The agent locks the budget from Olivia’s account, through the session key');
  const [oliviaBefore, agentBefore] = await Promise.all([balance(olivia.address), balance(researcher.address)]);
  const funded = trackNative('the agent locks 6 QOR from the owner’s account (session key, chain-checked)', await attempt(() => owner.fund(id)));
  if (!funded.success) throw new Error('The chain refused the session call: ' + funded.reason);
  const [log] = await client.getContractEvents({ address: contract, abi, eventName: 'Funded', args: { id }, fromBlock: BigInt(funded.height) - 2n });
  if (log) record.steps.at(-1).tx = log.transactionHash;
  const [oliviaAfter, agentAfter] = await Promise.all([balance(olivia.address), balance(researcher.address)]);
  say('Treaty recorded the budget as locked by ' + (log?.args.from ?? olivia.address) + ' (Olivia), not by the agent.');
  say('Olivia’s balance: ' + qor(oliviaAfter - oliviaBefore) + '. The agent’s: ' + qor(agentAfter - agentBefore) + ' (only the fee it paid to relay).');

  step('5. The same key tries to do more. The chain refuses');
  const drain = trackNative('session key tries an unlimited fUSD approval to the agent (refused by the chain)', await attempt(() => owner.call({
    to: FUSD, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [researcher.address, maxUint256] }), memo: 'attack: approve',
  })));
  say(drain.success ? 'Unexpected: the approval went through.' : 'An unlimited token approval to the agent: REFUSED (' + drain.reason + ').');
  const skim = trackNative('session key tries to send 1 QOR from the owner to the agent (refused by the chain)', await attempt(() => owner.call({
    to: researcher.address, data: '0x', value: parseEther('1'), memo: 'attack: transfer',
  })));
  say(skim.success ? 'Unexpected: 1 QOR moved to the agent.' : 'Moving 1 QOR of Olivia’s money to itself: REFUSED (' + skim.reason + ').');

  step('6. Work is delivered, checked and paid from the locked budget');
  const { unit } = trackEvm('the data agent delivers batch 1', await databot.treaty.deliver(id, JSON.stringify({ batch: 1, images: 500, labelled: 500 })));
  trackEvm('the research agent accepts it: 1.5 QOR paid', await researcher.treaty.accept(id, unit));
  say('Batch 1 accepted with the agent’s ML-DSA-87 key: 1.5 QOR to the data agent, with a receipt on QoreChain Native.');

  step('7. Olivia switches the session key off');
  const revoke = await broadcast(olivia.account, [revokeSessionMsg({ owner: olivia.account.cosmos, session })], { memo: 'Treaty: revoke the session' });
  const revoked = await lookupTx(revoke.transactionHash);
  trackNative('owner revokes the session key', { cosmosTx: revoke.transactionHash, height: revoked.height, hybrid: revoked.hybrid });
  const after = trackNative('the revoked key tries to call Treaty.refund (refused by the chain)', await attempt(() => owner.refund(id)));
  say(after.success ? 'Unexpected: the revoked key still acted.' : 'The revoked key tries again: REFUSED (' + after.reason + ').');

  step('8. The deadline passes and the unused budget goes home');
  while ((await now()) <= deadline) { say('Waiting for the deadline on Diana…'); await sleep(20_000); }
  const before = await balance(olivia.address);
  trackEvm('the unused budget goes back to the owner', await databot.treaty.refund(id));
  say('Anyone may return it, and it goes to Olivia, who locked it: ' + qor((await balance(olivia.address)) - before) + '.');

  step('Done');
  say('Treaty #' + id + ': Olivia paid exactly one accepted batch. Two layers held the agent: the contract’s mandate');
  say('and QoreChain’s own spending rule on her account. Her consent was ML-DSA-87 throughout.');
  await Promise.all(pending);
  record.finishedAt = new Date().toISOString();
  record.explorer = 'https://explore.qore.network/tx/<cosmosTx> (choose Testnet at the top of the explorer first)';
  await mkdir(new URL('../deployments/', import.meta.url), { recursive: true });
  await writeFile(new URL('../deployments/diana-smart-account.json', import.meta.url), JSON.stringify(record, null, 2) + '\n');
  say('Saved every transaction to deployments/diana-smart-account.json.');
} catch (error) {
  console.error('\nThe demo stopped: ' + explain(error));
  process.exitCode = 1;
}
