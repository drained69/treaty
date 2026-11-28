// Treaty signing tool for people (agents use sdk/treaty.js directly).
// Run with: npm run pq -- <command>. Keys come from .env (see .env.example).
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { generatePqcKeypair, pqcSign } from '@qorechain/sdk';
import { getAddress, hexToBytes, isAddress, parseEther, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deliverableHash } from '../src/protocol.js';
import { Treaty, abi, explain, qor } from '../sdk/treaty.js';

const HELP = `Usage: npm run pq -- <command> [options]

Look
  whoami                              your addresses, and whether your ML-DSA-87 key matches the chain
  show <id>                           a treaty's terms, signatures and (for services) deliveries
  statement [0x…]                     earnings, withdrawals and treaties of an address

Agree
  sign <id>                           accept treaty <id> with your ML-DSA-87 key

Service treaties
  fund <id>                           lock the treaty's budget (sends QOR)
  deliver <id> (--file f | --text t) [--seal KEY|chain]
                                      deliver one unit; only its hash goes on chain. --seal also encrypts
                                      the work to the client with QoreSeal (ML-KEM-1024): give its seal key
                                      (text or a file), or "chain" for its key in the KEM registry
  seal-key                            your seal key: share it so providers can deliver privately to you
  open <id> <unit> --file envelope [--save f]   as the client, decrypt a sealed delivery and check its hash
  accept <id> <unit>                  as the client, accept a delivery (pays one unit)
  reject <id> <unit>                  as the client, reject a delivery within the review period
  release <id> <unit>                 pay a delivery the client ignored past its review period
  refund <id>                         after the deadline, return the unused budget

Money
  withdraw <QOR|all> [--to 0x…] [--for 0x…]   pay out earnings (--for: an agent you own that you switched off)
  attack [QOR]                        demo: your classical key alone tries to withdraw (simulated)

Agents
  approve-owner --owner 0x… --max-per-treaty QOR --max-total QOR --days N   as the agent: agree to an owner's limits
  set-limits --agent 0x… --max-per-treaty QOR --max-total QOR --expiry T --agent-signature file   as the owner
  revoke <agent>                      as the owner: switch the agent off

Options: --out <file> saves a signed request any wallet can submit in the app instead of sending it.
--yes skips the confirmation.`;

const flags = { yes: false };
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; ++i) {
  if (argv[i] === '--yes' || argv[i] === '-y') flags.yes = true;
  else if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  else positional.push(argv[i]);
}
const [command = 'help', ...args] = positional;

async function confirm(question) {
  if (flags.yes) return;
  if (!process.stdin.isTTY) throw new Error('Pass --yes to confirm when not running interactively.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(question + ' [y/N] ');
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error('Cancelled. Nothing was signed.');
}

const connect = (signer = true) => Treaty.connect({ signer });
const id = (value) => {
  if (!/^[1-9]\d{0,30}$/.test(value ?? '')) throw new Error('Give the treaty number, for example: npm run pq -- sign 3');
  return BigInt(value);
};
const unitOf = (value) => {
  if (!/^\d{1,9}$/.test(value ?? '')) throw new Error('Give the delivery number, for example: npm run pq -- accept 3 0');
  return BigInt(value);
};
const addressFlag = (name) => {
  if (!isAddress(flags[name] ?? '')) throw new Error('--' + name + ' must be a 0x address.');
  return getAddress(flags[name]);
};
const amountFlag = (name) => {
  if (!/^\d+(\.\d{1,6})?$/.test(flags[name] ?? '')) throw new Error('--' + name + ' must be an amount in QOR.');
  return parseEther(flags[name]);
};

/** Send, or save a signed request with --out. */
async function finish(treaty, label, run) {
  if (flags.out) {
    const result = await run({ relay: true });
    const request = result?.envelope ? result.request : result;
    await writeFile(flags.out, request + '\n', { mode: 0o600 });
    console.log('Saved the signed request to ' + flags.out + '. Paste it into "Submit a signature" in the app; any wallet can send it.');
    return result?.envelope ? { envelope: result.envelope } : undefined;
  }
  const result = await run({});
  const receipt = result?.receipt ?? result;
  console.log(label + ' · block ' + receipt.blockNumber + ' · ' + receipt.transactionHash);
  const link = await treaty.explorerLink(receipt.transactionHash);
  if (link) console.log('  explorer (choose Testnet at its top): ' + link);
  return result;
}

function printTreaty(treaty) {
  const service = treaty.kindName === 'Service';
  console.log((service ? 'Service treaty #' : 'Revenue share #') + treaty.id + ' · ' + treaty.state + ' · ' + JSON.stringify(treaty.title));
  if (service) {
    console.log('  client   ' + treaty.client);
    console.log('  pays     ' + qor(treaty.price) + ' per unit, up to ' + treaty.maxUnits + ' units (budget ' + qor(treaty.budget) + ')');
    console.log('  until    ' + new Date(Number(treaty.deadline) * 1000).toISOString() + ' · review period ' + treaty.reviewPeriod + ' s');
    console.log('  budget   ' + (treaty.funded ? 'locked' : 'not funded yet') + ' · ' + treaty.sales + ' paid, ' + treaty.pendingUnits + ' pending');
  } else {
    console.log('  price    ' + qor(treaty.price) + ' per payment · ' + treaty.sales + ' payments');
  }
  treaty.recipients.forEach((recipient, i) => {
    console.log('  ' + (service ? 'provider ' : 'share    ') + recipient + '  ' + (Number(treaty.shares[i]) / 100) + '%  ' + qor(treaty.credits[i]));
  });
  if (treaty.previous) console.log('  replaces #' + treaty.previous + ' (its collaborators must sign too)');
  if (treaty.successor) console.log('  replaced by #' + treaty.successor);
  console.log('  signatures');
  treaty.signers.forEach((signer, i) => console.log('    ' + (treaty.signed[i] ? '✓ ' : '· ') + signer));
}

const commands = {
  async help() { console.log(HELP); },

  async whoami() {
    const treaty = await Treaty.connect({ verifyCode: false });
    console.log('EVM address   ' + treaty.address);
    console.log('QoreChain     ' + treaty.signer.qorAddress);
    const key = await treaty.keyCheck();
    console.log('ML-DSA-87     ' + (key.ok ? 'registered, proven, and matches your local key' : key.reason));
    if (!key.ok) process.exitCode = 1;
  },

  async show(value) {
    const treaty = await connect(false);
    const agreement = await treaty.agreement(id(value));
    printTreaty(agreement);
    if (agreement.kindName === 'Service') {
      for (const delivery of await treaty.deliveries(agreement.id)) {
        console.log('  delivery ' + delivery.unit + ' · ' + delivery.state + ' · ' + delivery.provider + ' · ' + delivery.deliverable);
      }
    }
  },

  async statement(who) {
    const treaty = await connect(!who);
    const account = who ? (isAddress(who) ? getAddress(who) : (() => { throw new Error('Give a 0x address.'); })()) : treaty.address;
    const statement = await treaty.statement(account);
    console.log('Statement for ' + account);
    for (const row of statement.agreements) {
      const sales = row.agreement.sales;
      console.log('  #' + row.id + ' ' + JSON.stringify(row.agreement.title) + ' · ' + row.agreement.state + ' · ' +
        (Number(row.share) / 100) + '% · ' + sales + (row.agreement.kindName === 'Service' ? (sales === 1n ? ' unit · ' : ' units · ') : (sales === 1n ? ' sale · ' : ' sales · ')) +
        qor(row.total));
    }
    if (statement.clientOf.length) console.log('  client of treaties ' + statement.clientOf.map((value) => '#' + value).join(', '));
    const mandate = await treaty.mandate(account);
    if (mandate) {
      console.log('  owner      ' + mandate.owner + (mandate.revoked ? ' · switched off' : ''));
      console.log('  limits     ' + qor(mandate.maxPerTreaty) + ' per treaty, ' + qor(mandate.committed) + ' of ' + qor(mandate.maxTotal) + ' committed');
    }
    console.log('  earned     ' + qor(statement.earned));
    console.log('  withdrawn  ' + qor(statement.withdrawn));
    console.log('  available  ' + qor(statement.available));
  },

  async sign(value) {
    const treaty = await connect();
    const agreement = await treaty.agreement(id(value));
    printTreaty(agreement);
    await confirm('Sign these terms with your ML-DSA-87 key?');
    const receipt = await finish(treaty, 'Signed', (options) => treaty.sign(agreement.id, options));
    if (receipt) {
      const after = await treaty.agreement(agreement.id);
      console.log(after.state === 'Active'
        ? 'Every party has signed. Treaty #' + agreement.id + ' is live and its Native receipt is written.'
        : 'Waiting for the other signatures.');
    }
  },

  async fund(value) {
    const treaty = await connect();
    const agreement = await treaty.agreement(id(value));
    printTreaty(agreement);
    await confirm('Lock ' + qor(agreement.budget) + ' in treaty #' + agreement.id + '?');
    await finish(treaty, 'Funded', () => treaty.fund(agreement.id));
  },

  async deliver(value) {
    const treaty = await connect();
    const agreement = await treaty.agreement(id(value));
    let content;
    if (flags.file) content = new Uint8Array(await readFile(flags.file));
    else if (flags.text !== undefined) content = flags.text;
    else throw new Error('Give the work with --file <path> or --text "…". Only its hash goes on chain.');
    let sealTo;
    if (flags.seal) {
      sealTo = flags.seal === 'chain' || flags.seal.startsWith('treaty-seal-key:') ? flags.seal : (await readFile(flags.seal, 'utf8')).trim();
    }
    console.log('Deliver to treaty #' + agreement.id + ' (' + JSON.stringify(agreement.title) + '): ' + deliverableHash(content));
    if (sealTo) console.log('The work is sealed to the client ' + agreement.client + ' with QoreSeal; only its hash goes on chain.');
    await confirm('Sign this delivery with your ML-DSA-87 key?');
    const unit = agreement.deliveries;
    const result = await finish(treaty, 'Delivered', (options) => treaty.deliver(agreement.id, content, { ...options, sealTo }));
    if (result?.envelope) {
      const file = flags.envelope ?? 'delivery-' + agreement.id + '-' + unit + '.qoreseal';
      await writeFile(file, result.envelope + '\n');
      console.log('Sealed envelope saved to ' + file + '. Send it to the client; only they can open it: npm run pq -- open ' + agreement.id + ' ' + unit + ' --file ' + file);
    }
    if (result?.unit !== undefined) console.log('This is delivery ' + result.unit + '. The client has ' + agreement.reviewPeriod + ' s to review it.');
  },

  async ['seal-key']() {
    const treaty = await connect();
    console.log(treaty.sealKey());
    console.error('Share this line with your providers (it is public). Save it to a file and they can pass it as --seal <file>.');
  },

  async open(value, unit) {
    const treaty = await connect();
    if (!flags.file) throw new Error('Give the sealed envelope with --file <path>.');
    const work = await treaty.openDelivery(id(value), unitOf(unit), (await readFile(flags.file, 'utf8')).trim());
    console.error('Opened and checked: it matches the hash delivered on chain for delivery ' + unit + ' of treaty #' + value + '.');
    if (flags.save) {
      await writeFile(flags.save, work, { mode: 0o600 });
      console.error('Saved to ' + flags.save + ' (' + work.length + ' bytes).');
    } else {
      process.stdout.write(new TextDecoder().decode(work) + '\n');
    }
  },

  async accept(value, unit) { await review(value, unit, true); },
  async reject(value, unit) { await review(value, unit, false); },

  async release(value, unit) {
    const treaty = await connect();
    await finish(treaty, 'Released', () => treaty.release(id(value), unitOf(unit)));
  },

  async refund(value) {
    const treaty = await connect();
    const amount = await treaty.read('refundable', [id(value)]);
    console.log('Unused budget: ' + qor(amount));
    await finish(treaty, 'Refunded', () => treaty.refund(id(value)));
  },

  async withdraw(amountText) {
    const treaty = await connect();
    const recipient = flags.for ? addressFlag('for') : treaty.address;
    const available = await treaty.read('claimable', [recipient]);
    if (amountText !== 'all' && !/^\d+(\.\d{1,18})?$/.test(amountText ?? '')) {
      throw new Error('Give an amount in QOR or "all", for example: npm run pq -- withdraw all');
    }
    const to = flags.to ? addressFlag('to') : treaty.address;
    console.log('Withdraw ' + (amountText === 'all' ? qor(available) : amountText + ' QOR') + ' of ' + qor(available) +
      ' earned by ' + recipient + ' to ' + to);
    await confirm('Sign this withdrawal with your ML-DSA-87 key?');
    await finish(treaty, 'Withdrawn', (options) => treaty.withdraw(amountText, { to, recipient, ...options }));
  },

  async attack(amountText) {
    const treaty = await connect();
    const available = await treaty.read('claimable', [treaty.address]);
    if (!amountText && available === 0n) {
      console.log('You have no earnings yet, so the contract would refuse for that reason first. Run this after a payment.');
      return;
    }
    const amount = amountText ? parseEther(amountText) : available;
    if (amount > available) throw new Error('Use an amount up to your balance of ' + qor(available) + ', so the signature check is what refuses it.');
    const thief = '0x000000000000000000000000000000000000dEaD';
    const nonce = await treaty.read('nonces', [treaty.address]);
    const message = await treaty.read('withdrawalMessage', [treaty.address, thief, amount, nonce]);
    const forged = toHex(pqcSign(generatePqcKeypair().secretKey, hexToBytes(message)));
    console.log('An attacker who holds your classical key, but not your ML-DSA-87 key, tries to send');
    console.log(qor(amount) + ' of your earnings to ' + thief + ' with a forged post-quantum signature.');
    try {
      await treaty.client.simulateContract({
        account: privateKeyToAccount(treaty.signer.privateKey), address: treaty.contract, abi,
        functionName: 'withdraw', args: [treaty.address, thief, amount, forged],
      });
      console.log('Unexpected: the simulation passed.');
      process.exitCode = 1;
    } catch (error) {
      console.log('BLOCKED by Treaty: ' + explain(error) + '. Nothing was sent.');
    }
  },

  async 'approve-owner'() {
    const treaty = await connect();
    const owner = addressFlag('owner');
    const days = Number(flags.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('--days must be a whole number of days.');
    const expiry = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
    const limits = { owner, maxPerTreaty: amountFlag('max-per-treaty'), maxTotal: amountFlag('max-total'), expiry };
    console.log('Agent ' + treaty.address + ' agrees that ' + owner + ' may switch it off, and that it commits at most ' +
      qor(limits.maxPerTreaty) + ' per treaty and ' + qor(limits.maxTotal) + ' in total until ' + new Date(Number(expiry) * 1000).toISOString() + '.');
    await confirm('Sign with the agent’s ML-DSA-87 key?');
    const signature = await treaty.approveOwner(limits);
    const file = flags.out ?? 'agent-approval.json';
    await writeFile(file, JSON.stringify({ agent: treaty.address, ...limits, maxPerTreaty: String(limits.maxPerTreaty), maxTotal: String(limits.maxTotal), expiry: String(expiry), agentSignature: signature }, null, 2) + '\n', { mode: 0o600 });
    console.log('Saved the agent’s approval to ' + file + '. The owner runs: npm run pq -- set-limits --approval ' + file);
  },

  async 'set-limits'() {
    const treaty = await connect();
    if (!flags.approval) throw new Error('Give the agent’s approval file: --approval agent-approval.json');
    const approval = JSON.parse(await readFile(flags.approval, 'utf8'));
    if (getAddress(approval.owner) !== treaty.address) throw new Error('This approval names ' + approval.owner + ' as owner, not you.');
    console.log('Set limits for agent ' + approval.agent + ': ' + qor(BigInt(approval.maxPerTreaty)) + ' per treaty, ' +
      qor(BigInt(approval.maxTotal)) + ' in total, until ' + new Date(Number(approval.expiry) * 1000).toISOString() + '.');
    await confirm('Sign as the owner with your ML-DSA-87 key?');
    await finish(treaty, 'Limits set', (options) => treaty.setMandate({
      agent: getAddress(approval.agent), maxPerTreaty: BigInt(approval.maxPerTreaty), maxTotal: BigInt(approval.maxTotal),
      expiry: BigInt(approval.expiry), agentSignature: approval.agentSignature,
    }, options));
  },

  async revoke(agent) {
    const treaty = await connect();
    if (!isAddress(agent ?? '')) throw new Error('Give the agent’s 0x address.');
    console.log('Switch off agent ' + getAddress(agent) + '. It will not be able to sign anything in Treaty, and only you can move its earnings.');
    await confirm('Sign as the owner with your ML-DSA-87 key?');
    await finish(treaty, 'Agent switched off', (options) => treaty.revoke(getAddress(agent), options));
  },
};

async function review(value, unit, accepted) {
  const treaty = await connect();
  const treatyId = id(value);
  const unitId = unitOf(unit);
  const delivery = await treaty.read('getDelivery', [treatyId, unitId]);
  console.log((accepted ? 'Accept' : 'Reject') + ' delivery ' + unitId + ' of treaty #' + treatyId + ' from ' + delivery.provider + ': ' + delivery.deliverable);
  await confirm('Sign with your ML-DSA-87 key?');
  await finish(treaty, accepted ? 'Accepted and paid' : 'Rejected', (options) => (accepted ? treaty.accept : treaty.reject).call(treaty, treatyId, unitId, options));
}

const run = commands[command];
if (!run) {
  console.error('Unknown command "' + command + '". Run: npm run pq -- help');
  process.exit(1);
}
run(...args).catch((error) => {
  console.error(explain(error));
  process.exitCode = 1;
});
