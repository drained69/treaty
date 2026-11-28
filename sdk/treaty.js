// Treaty SDK for agents and people: make, sign and settle post-quantum agreements.
//
//   import { Treaty } from './sdk/treaty.js';
//   const me = await Treaty.connect({ contract, mnemonic });
//   const id = await me.proposeService({ title, unitPrice: '2', maxUnits: 5, ... });
//   await me.sign(id);
//
// Every post-quantum action rebuilds the exact bytes from the on-chain terms, checks
// they match what the contract will verify, signs them with ML-DSA-87, and then either
// sends the transaction from this account or returns a signed request any wallet can relay.
import { readFile } from 'node:fs/promises';
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeEventLog, defineChain,
  formatEther, getAddress, http, isAddress, parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DeliveryStatus, Kind, RELAYABLE, Status, budgetOf, deliverableHash, deliveryMessage, isService, mandateMessage, parseSignedRequest, revokeMessage,
  reviewMessage, signedRequest, splitAmounts, termsHash, termsMessage, windowProblem, withdrawalMessage,
} from '../src/protocol.js';
import { loadSigner, registeredKey } from './pqc.js';
import { openDelivery, sealDelivery, sealKeyText, sealRecipient } from './seal.js';

export const DIANA = Object.freeze({
  chainId: 9800, rpc: 'https://evm-testnet.qore.host', rest: 'https://api-testnet.qore.host',
});
const artifact = JSON.parse(await readFile(new URL('../artifacts/Treaty.json', import.meta.url)));
export const { abi } = artifact;

/** A readable reason for a failed call, including Treaty's own errors. */
export function explain(error) {
  if (error instanceof BaseError) {
    const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? revert.shortMessage;
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

const toWei = (value) => typeof value === 'bigint' ? value : parseEther(String(value));
export const qor = (wei) => formatEther(wei) + ' QOR';

export class Treaty {
  /**
   * Connect an account. Keys come from `mnemonic` (+ `accountIndex`), or `privateKey` with
   * `recoveryCode`, or else the environment (QORE_MNEMONIC, or PRIVATE_KEY and QORE_PQC_RECOVERY_CODE).
   * Pass `signer: false` for a read-only connection.
   */
  static async connect({
    contract, rpc = process.env.QORE_EVM_RPC?.trim() || DIANA.rpc, rest = process.env.QORE_REST_URL?.trim() || DIANA.rest,
    mnemonic, accountIndex, privateKey, recoveryCode, signer: withSigner = true, verifyCode = true,
  } = {}) {
    const configured = contract ?? process.env.TREATY_ADDRESS ?? process.env.VITE_TREATY_ADDRESS;
    if (!isAddress(configured ?? '')) throw new Error('Set the Treaty contract address (VITE_TREATY_ADDRESS).');
    const chain = defineChain({
      id: DIANA.chainId, name: 'QoreChain Diana', nativeCurrency: { name: 'Test QOR', symbol: 'QOR', decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });
    const client = createPublicClient({ chain, transport: http(rpc, { timeout: 30_000 }) });
    const address = getAddress(configured);
    if (verifyCode) {
      const [chainId, code] = await Promise.all([client.getChainId(), client.getCode({ address })]);
      if (chainId !== chain.id) throw new Error('The RPC at ' + rpc + ' is not Diana (chain 9800).');
      if (code?.toLowerCase() !== artifact.runtime.toLowerCase()) {
        throw new Error('The contract at ' + address + ' is not this Treaty build. Run npm run compile, or check the address.');
      }
    }
    let signer;
    if (withSigner) {
      const env = mnemonic || privateKey
        ? { QORE_MNEMONIC: mnemonic, QORE_ACCOUNT_INDEX: accountIndex, PRIVATE_KEY: privateKey, QORE_PQC_RECOVERY_CODE: recoveryCode }
        : process.env;
      signer = await loadSigner(env);
    }
    const signingChain = await client.readContract({ address, abi, functionName: 'signingChain' });
    return new Treaty({ chain, client, contract: address, rest, signer, signingChain });
  }

  constructor({ chain, client, contract, rest, signer, signingChain }) {
    this.signingChain = signingChain;
    this.chain = chain;
    this.client = client;
    this.contract = contract;
    this.rest = rest;
    this.signer = signer;
    this.address = signer?.address;
  }

  read(functionName, args = []) {
    return this.client.readContract({ address: this.contract, abi, functionName, args });
  }

  #me() {
    if (!this.signer) throw new Error('This connection has no keys.');
    return this.signer;
  }

  // ----------------------------------------------------------------- reads

  async agreement(id) {
    const agreement = await this.read('getAgreement', [BigInt(id)]);
    if (termsHash(agreement) !== agreement.termsHash) throw new Error('Agreement #' + id + ' does not match its terms hash.');
    return {
      ...agreement, id: BigInt(id), kindName: Kind[agreement.kind], state: Status[agreement.status],
      credits: splitAmounts(agreement.price, agreement.shares),
      budget: isService(agreement) ? budgetOf(agreement) : 0n,
      signed: agreement.signers.map((_, i) => Boolean((agreement.signedMask >> i) & 1)),
    };
  }

  async deliveries(id) {
    const { deliveries } = await this.read('getAgreement', [BigInt(id)]);
    const list = await Promise.all(Array.from({ length: Number(deliveries) }, (_, unit) =>
      this.read('getDelivery', [BigInt(id), BigInt(unit)])));
    return list.map((delivery, unit) => ({ ...delivery, unit: BigInt(unit), state: DeliveryStatus[delivery.status] }));
  }

  async mandate(agent = this.address) {
    const mandate = await this.read('getMandate', [agent]);
    return mandate.owner === '0x0000000000000000000000000000000000000000' ? undefined : mandate;
  }

  async statement(account = this.address) {
    const [earned, withdrawn, available, ids, clientIds] = await Promise.all([
      this.read('earned', [account]), this.read('withdrawn', [account]), this.read('claimable', [account]),
      this.read('agreementsOf', [account]), this.read('treatiesAsClient', [account]),
    ]);
    const rows = await Promise.all(ids.map(async (id) => {
      const agreement = await this.agreement(id);
      const index = agreement.recipients.findIndex((value) => value.toLowerCase() === account.toLowerCase());
      return { id, agreement, share: agreement.shares[index], credit: agreement.credits[index], total: agreement.credits[index] * agreement.sales };
    }));
    const consistent = rows.reduce((sum, row) => sum + row.total, 0n) === earned && earned - withdrawn === available;
    return { account, earned, withdrawn, available, agreements: rows, clientOf: clientIds, consistent };
  }

  // ------------------------------------------------- plain transactions

  /** Propose a revenue share. `price` in QOR (string) or wei (bigint); `shares` in basis points. */
  async propose({ title, price, recipients, shares, previous = 0n }) {
    const receipt = await this.#send('propose', [title, toWei(price), recipients, shares, BigInt(previous)]);
    return this.#event(receipt, 'Proposed').id;
  }

  /** Propose a service treaty. `deadline` is a Unix time in seconds; `reviewPeriod` in seconds. */
  async proposeService({ title, unitPrice, maxUnits, deadline, reviewPeriod, client, providers, shares }) {
    const receipt = await this.#send('proposeService', [
      title, toWei(unitPrice), Number(maxUnits), BigInt(deadline), Number(reviewPeriod), client, providers, shares,
    ]);
    return this.#event(receipt, 'Proposed').id;
  }

  async checkout(id, reference) {
    const agreement = await this.agreement(id);
    return this.#send('checkout', [BigInt(id), reference], agreement.price);
  }

  /** Lock a service treaty's whole budget. */
  async fund(id) {
    const agreement = await this.agreement(id);
    return this.#send('fund', [BigInt(id)], agreement.budget);
  }

  release(id, unit) { return this.#send('release', [BigInt(id), BigInt(unit)]); }
  refund(id) { return this.#send('refund', [BigInt(id)]); }
  cancel(id) { return this.#send('cancel', [BigInt(id)]); }

  // ------------------------------------------- post-quantum signed actions
  // Each returns the receipt, or with { relay: true } a signed request (JSON) instead.

  /** Accept agreement `id`'s terms. Inspect them first with agreement(id). */
  async sign(id, options) {
    const me = this.#me();
    const agreement = await this.agreement(id);
    if (agreement.state !== 'Pending') throw new Error('Agreement #' + id + ' is not waiting for signatures.');
    const index = agreement.signers.findIndex((value) => value.toLowerCase() === me.address.toLowerCase());
    if (index < 0) throw new Error(me.address + ' is not a signer of agreement #' + id + '.');
    if (agreement.signed[index]) throw new Error('You already signed agreement #' + id + '.');
    const message = termsMessage({ chainId: this.chain.id, contract: this.contract, signingChain: this.signingChain, id, signer: me.address, hash: agreement.termsHash });
    await this.#same(message, 'termsMessage', [BigInt(id), me.address]);
    return this.#signed('sign', { id: BigInt(id), signer: me.address }, message, options);
  }

  /**
   * Deliver one unit of work. `content` (string or bytes) is hashed; pass `{ hash }` to give the hash.
   * With `{ sealTo }` (the client's seal key, or `'chain'` for its key in QoreChain's KEM registry)
   * the work is also encrypted to the client with QoreSeal, and the result carries the `envelope`
   * to send it. Only the hash of the plaintext goes on chain either way.
   */
  async deliver(id, content, options = {}) {
    const me = this.#me();
    const agreement = await this.agreement(id);
    if (!isService(agreement)) throw new Error('Agreement #' + id + ' is not a service treaty.');
    if (options.sealTo && options.hash) throw new Error('A sealed delivery needs the work itself, not only its hash.');
    const deliverable = options.hash ?? deliverableHash(content);
    const unit = BigInt(agreement.deliveries);
    let envelope;
    if (options.sealTo) {
      const { recipient, mode } = await sealRecipient(options.sealTo, { rest: this.rest, client: agreement.client });
      const plaintext = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      envelope = sealDelivery({ plaintext, recipient, mode, signingChain: this.signingChain, contract: this.contract, id, unit });
    }
    const message = deliveryMessage({ chainId: this.chain.id, contract: this.contract, signingChain: this.signingChain, id, unit, provider: me.address, deliverable });
    await this.#same(message, 'deliveryMessage', [BigInt(id), unit, me.address, deliverable]);
    const result = await this.#signed('deliver', { id: BigInt(id), provider: me.address, deliverable }, message, options);
    if (options.relay) return envelope ? { request: result, envelope } : result;
    return { receipt: result, unit, deliverable, envelope };
  }

  /** This account's seal key, to share with providers so they can deliver privately to it. */
  sealKey() {
    return sealKeyText(this.#me().sealKeys());
  }

  /**
   * Open a sealed delivery as the client. Returns the work's bytes, after checking that they hash
   * to what the provider delivered on chain; refuses otherwise.
   */
  async openDelivery(id, unit, envelope) {
    const keys = this.#me().sealKeys();
    const delivery = await this.read('getDelivery', [BigInt(id), BigInt(unit)]);
    if (DeliveryStatus[delivery.status] === 'None') throw new Error('Treaty #' + id + ' has no delivery ' + unit + '.');
    let plaintext;
    try {
      plaintext = openDelivery({ envelope, keys, signingChain: this.signingChain, contract: this.contract, id, unit });
    } catch (error) {
      throw new Error('This envelope does not open with your seal keys for delivery ' + unit + ' of treaty #' + id + ' (' + (error.code ?? error.message) + ').');
    }
    if (deliverableHash(plaintext) !== delivery.deliverable) {
      throw new Error('The sealed work does not match the hash delivered on chain for delivery ' + unit + ' of treaty #' + id + '.');
    }
    return plaintext;
  }

  accept(id, unit, options) { return this.#review(id, unit, true, options); }
  reject(id, unit, options) { return this.#review(id, unit, false, options); }

  async #review(id, unit, accepted, options) {
    const me = this.#me();
    const [agreement, delivery] = await Promise.all([this.agreement(id), this.read('getDelivery', [BigInt(id), BigInt(unit)])]);
    if (agreement.client.toLowerCase() !== me.address.toLowerCase()) throw new Error('Only the client of treaty #' + id + ' reviews deliveries.');
    if (DeliveryStatus[delivery.status] !== 'Pending') throw new Error('Delivery ' + unit + ' of treaty #' + id + ' is not pending.');
    const message = reviewMessage({ chainId: this.chain.id, contract: this.contract, signingChain: this.signingChain, id, unit, deliverable: delivery.deliverable, accepted });
    await this.#same(message, 'reviewMessage', [BigInt(id), BigInt(unit), accepted]);
    return this.#signed(accepted ? 'accept' : 'reject', { id: BigInt(id), unit: BigInt(unit) }, message, options);
  }

  /** Withdraw `amount` (QOR string, wei bigint, or 'all') of `recipient`'s earnings to `to`. */
  async withdraw(amount, { to, recipient, ...options } = {}) {
    const me = this.#me();
    const account = recipient ?? me.address;
    const [available, signer, nonce] = await Promise.all([
      this.read('claimable', [account]), this.read('withdrawalSigner', [account]), this.read('nonces', [account]),
    ]);
    if (signer.toLowerCase() !== me.address.toLowerCase()) throw new Error('Withdrawals of ' + account + ' must be signed by ' + signer + '.');
    const wei = amount === 'all' ? available : toWei(amount);
    if (wei === 0n || wei > available) throw new Error('You can withdraw up to ' + qor(available) + '.');
    const destination = getAddress(to ?? me.address);
    const message = withdrawalMessage({ chainId: this.chain.id, contract: this.contract, signingChain: this.signingChain, recipient: account, to: destination, amount: wei, nonce });
    await this.#same(message, 'withdrawalMessage', [account, destination, wei, nonce]);
    return this.#signed('withdraw', { recipient: account, to: destination, amount: wei }, message, options);
  }

  /** As the agent: agree to `owner`'s limits. Returns the agent's signature for the owner to submit. */
  async approveOwner({ owner, maxPerTreaty, maxTotal, expiry }) {
    const me = this.#me();
    const message = await this.#mandateBytes(me.address, owner, maxPerTreaty, maxTotal, expiry);
    return me.sign(message);
  }

  /** As the owner: set `agent`'s limits with the agent's signature from approveOwner(). */
  async setMandate({ agent, maxPerTreaty, maxTotal, expiry, agentSignature }, options) {
    const me = this.#me();
    const message = await this.#mandateBytes(agent, me.address, maxPerTreaty, maxTotal, expiry);
    const fields = {
      agent, owner: me.address, maxPerTreaty: toWei(maxPerTreaty), maxTotal: toWei(maxTotal), expiry: BigInt(expiry),
      agentSignature, ownerSignature: me.sign(message),
    };
    return this.#relayOrSend('setMandate', fields, options);
  }

  /** As the owner: switch `agent` off. */
  async revoke(agent, options) {
    const me = this.#me();
    const mandate = await this.mandate(agent);
    if (!mandate || mandate.owner.toLowerCase() !== me.address.toLowerCase()) throw new Error('You are not the owner of ' + agent + '.');
    const nonce = await this.read('mandateNonces', [agent]);
    const message = revokeMessage({ chainId: this.chain.id, contract: this.contract, signingChain: this.signingChain, agent, nonce });
    await this.#same(message, 'revokeMessage', [agent]);
    return this.#relayOrSend('revokeMandate', { agent, ownerSignature: me.sign(message) }, options);
  }

  /**
   * Send a signed request someone else made (with { relay: true }), from this account. It authorises
   * nothing by itself: the contract checks the ML-DSA-87 signature inside against the signer's key.
   */
  async relay(request) {
    const { action, args } = parseSignedRequest(typeof request === 'string' ? request : JSON.stringify(request), {
      chainId: this.chain.id, contract: this.contract,
    });
    return this.#send(action, args);
  }

  /** Whether this account's ML-DSA-87 key matches the one registered on chain. */
  async keyCheck() {
    const me = this.#me();
    const onChain = await registeredKey(this.client, me.address);
    if (!onChain.registered) return { ok: false, reason: me.qorAddress + ' has no ML-DSA-87 key on chain.' };
    if (!onChain.proven) return { ok: false, reason: 'The key registered for ' + me.qorAddress + ' has no proof of possession.' };
    if (onChain.pubkey.toLowerCase() !== '0x' + Buffer.from(me.publicKey).toString('hex')) {
      return { ok: false, reason: 'Your local ML-DSA-87 key differs from the key registered on chain.' };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------- helpers

  async #mandateBytes(agent, owner, maxPerTreaty, maxTotal, expiry) {
    const nonce = await this.read('mandateNonces', [agent]);
    const message = mandateMessage({
      chainId: this.chain.id, contract: this.contract, signingChain: this.signingChain, agent, owner,
      maxPerTreaty: toWei(maxPerTreaty), maxTotal: toWei(maxTotal), expiry: BigInt(expiry), nonce,
    });
    await this.#same(message, 'mandateMessage', [agent, owner, toWei(maxPerTreaty), toWei(maxTotal), BigInt(expiry)]);
    return message;
  }

  /** Refuse to sign unless the contract will check exactly the bytes built here from the terms. */
  async #same(message, functionName, args) {
    if (message !== await this.read(functionName, args)) {
      throw new Error('The contract asks for different bytes than the ones built from these terms. Nothing was signed.');
    }
  }

  async #signed(action, fields, message, options = {}) {
    const me = this.#me();
    const key = await this.keyCheck();
    if (!key.ok) throw new Error(key.reason);
    return this.#relayOrSend(action, { ...fields, signature: me.sign(message) }, options);
  }

  async #relayOrSend(action, fields, options = {}) {
    const scope = { chainId: this.chain.id, contract: this.contract };
    if (options.relay) return signedRequest(action, fields, scope);
    return this.#send(action, RELAYABLE[action].args.map(([name]) => fields[name]));
  }

  async #send(functionName, args, value) {
    const me = this.#me();
    await this.#requireWindow(value ?? 0n);
    const account = privateKeyToAccount(me.privateKey);
    const { request } = await this.client.simulateContract({ account, address: this.contract, abi, functionName, args, value });
    const wallet = createWalletClient({ account, chain: this.chain, transport: http(this.chain.rpcUrls.default.http[0]) });
    const hash = await wallet.writeContract(request);
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error(functionName + ' reverted: ' + hash);
    return receipt;
  }

  /** Stop early, with the reason, when this account's EVM window would refuse the transaction. */
  async #requireWindow(valueWei) {
    const me = this.#me();
    let response;
    try {
      response = await fetch(this.rest + '/qorechain/pqc/v1/evm_window/' + me.qorAddress, { signal: AbortSignal.timeout(10_000) });
    } catch {
      return; // The send itself reports a refused window.
    }
    if (!response.ok && response.status !== 404) return;
    const body = response.ok ? await response.json() : { found: false };
    const problem = windowProblem(body.window ?? body.evm_window ?? body, { contract: this.contract, valueWei });
    if (problem) throw new Error(me.qorAddress + ' ' + problem + '. Open one that allows ' + this.contract + ', or relay a signed request.');
  }

  #event(receipt, name) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.contract.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi, ...log });
        if (event.eventName === name) return event.args;
      } catch { /* other events */ }
    }
    throw new Error('No ' + name + ' event in ' + receipt.transactionHash);
  }

  /**
   * The QoreChain explorer link for an EVM transaction. The explorer lists Cosmos hashes and opens
   * on mainnet (choose Testnet at its top), so this looks the Cosmos hash up on Native REST.
   */
  async explorerLink(hash) {
    const cosmosTx = await this.cosmosHash(hash);
    return cosmosTx ? 'https://explore.qore.network/tx/' + cosmosTx : undefined;
  }

  async cosmosHash(hash) {
    try {
      const query = encodeURIComponent("ethereum_tx.ethereumTxHash='" + hash.toLowerCase() + "'");
      const response = await fetch(this.rest + '/cosmos/tx/v1beta1/txs?query=' + query, { signal: AbortSignal.timeout(10_000) });
      return response.ok ? (await response.json()).tx_responses?.[0]?.txhash : undefined;
    } catch {
      return undefined;
    }
  }

  /** Decode this contract's events from a receipt. */
  events(receipt) {
    return receipt.logs.filter((log) => log.address.toLowerCase() === this.contract.toLowerCase()).map((log) => {
      try { return decodeEventLog({ abi, ...log }); } catch { return undefined; }
    }).filter(Boolean);
  }
}
