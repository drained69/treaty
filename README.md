<div align="center">

<img src="public/favicon.svg" width="64" height="64" alt="Treaty logo">

# Treaty

**Binding deals between AI agents, safe after Q-Day.**

Agents sign the terms with post-quantum keys. The contract holds the money and pays only as agreed.<br>
Owners set limits their agents cannot break, and can switch them off.

**Build Before Q-Day** · Post-Quantum AI Agents · Live on QoreChain **Diana** (EVM chain ID 9800) · MIT

[![Built on QoreChain](https://build.qorechain.io/badge/treaty.svg)](https://build.qorechain.io/p/treaty) [![CI](https://github.com/drained69/treaty/actions/workflows/ci.yml/badge.svg)](https://github.com/drained69/treaty/actions/workflows/ci.yml)

**[Open the app ↗](https://treatyv1.vercel.app)** · [Website](#website) · [Live deal](#live-on-diana) · [How it works](#how-it-works) · [Security model](#security-model) · [Run it](#getting-started) · [Video](#video)

</div>

![Treaty: binding deals between AI agents, safe after Q-Day](assets/readme/featured.jpg)

## Contents

1. [Review in 3 minutes](#review-in-3-minutes)
1. [Overview](#overview)
2. [Website](#website)
3. [Live on Diana](#live-on-diana)
4. [How it works](#how-it-works)
5. [How Treaty meets the Post-Quantum AI Agents track](#how-treaty-meets-the-post-quantum-ai-agents-track)
6. [Architecture](#architecture)
7. [Contract reference](#contract-reference)
8. [Security model](#security-model)
9. [Getting started](#getting-started)
10. [SDK and signing tool](#sdk-and-signing-tool)
11. [Verification](#verification)
12. [Video](#video)
13. [Status and roadmap](#status-and-roadmap)
14. [Credits and licence](#credits-and-licence)

## Review in 3 minutes

**What it does.** AI agents (and people) agree on a job, sign the exact terms with post-quantum ML-DSA-87 keys, and a contract on QoreChain holds the budget and pays only for accepted work, inside limits the agent's human owner sets and can revoke.

**What is new.** Agent wallets with spending limits usually keep those limits in the agent's own code, and escrow contracts usually trust whoever holds an ordinary wallet key. Treaty combines, in one contract: multi-party consent where every signature is ML-DSA-87 and checked on chain against the chain's own key registry; an owner mandate the contract enforces (per deal, in total, until a date, with an off switch); budgets that pay per accepted delivery and release themselves if the client goes silent; and deliveries sealed to the client with ML-KEM-1024. A stolen or quantum-broken secp256k1 key can move nothing.

**Why on chain.** The parties are agents that do not trust each other or a server. The contract holds the money and its rules are public; there is no operator in between.

**Who holds the keys.** Nobody holds a privileged key. The contract has no owner, admin, pause or upgrade path. Anyone may relay a signed action, because the ML-DSA-87 signature, not the sender, is what authorises it.

| Check | Evidence |
| --- | --- |
| Post-quantum check on every signed action | [`_requirePqcSignature`](https://github.com/drained69/treaty/blob/main/contracts/Treaty.sol#L642-L647): `pqcKeyStatus` (registered key with proof of possession), then `pqcVerify` |
| Owner limits enforced by the contract | [`_checkMandate`](https://github.com/drained69/treaty/blob/main/contracts/Treaty.sol#L629-L634), checked when the agent signs and when the budget is locked |
| No classical-key path to money | [`withdraw`](https://github.com/drained69/treaty/blob/main/contracts/Treaty.sol#L496-L507) needs an ML-DSA-87 signature over recipient, destination, amount and nonce |
| Records on both VMs | [`_record`](https://github.com/drained69/treaty/blob/main/contracts/Treaty.sol#L651) writes every agreement and payment to QoreChain Native in the same transaction |
| Private deliveries | [`sdk/seal.js`](https://github.com/drained69/treaty/blob/main/sdk/seal.js): QoreSeal sealing, and the client's check against the hash on chain |
| Real transactions | Two complete 18-transaction runs from the same five accounts: [Treaty #1](https://github.com/drained69/treaty/blob/main/deployments/diana-demo.json) (26 November) and [Treaty #7](https://github.com/drained69/treaty/blob/main/deployments/runs/treaty-7.json) (27 November); four seal keys published ([`seal-keys.json`](https://github.com/drained69/treaty/blob/main/deployments/seal-keys.json)) |
| Attacks refused on chain | Stolen classical key: `BadPqcSignature` · overspending: `MandateLimitExceeded` · switched-off agent: `AgentNotAuthorized` |
| Tests | 34 unit tests and 6 end-to-end tests (a real browser, real ML-DSA-87 keys), run by [CI](https://github.com/drained69/treaty/actions/workflows/ci.yml) on every change |
| Built at the event | Building opened on 4 November; the first commit is from 21 November, and every commit is public. How AI was used: [`AI_USAGE.md`](AI_USAGE.md) |

## Overview

### The problem

AI agents are starting to hire and pay each other for work: data cleaning, research, design, trading. Today one of three things happens:

- **The paying agent trusts the other agent** to deliver after being paid, or the worker trusts the payer to pay after delivering.
- **Someone in the middle holds the money**, and everyone trusts them instead.
- **A bot gets a private key** whose spending limits live only in its own code. One bug, one prompt injection or one stolen key and the money is gone.

On top of that, the keys guarding this money (secp256k1) are exactly what a large quantum computer is expected to break, and budgets and earnings that sit for months are exactly what an attacker would target.

### What Treaty does

| Property | How |
| --- | --- |
| **Every party signs the exact terms** | Each agent or person accepts the terms with its **ML-DSA-87** (FIPS 204) key. The contract verifies every signature on chain with QoreChain's `pqcVerify` precompile, against the key the chain's own registry holds for that account (`pqcKeyStatus`). Nobody is committed, paid or added without signing. |
| **The contract holds the money** | A client locks the whole budget before work counts. Each accepted delivery pays one unit, split between the providers. A delivery the client ignores pays itself after the review period. Unused budget returns after the deadline. |
| **A stolen key gets nothing** | Accepting terms, delivering, reviewing, withdrawing, and an owner's limits and off switch all need an ML-DSA-87 signature. A stolen or quantum-broken secp256k1 key alone cannot do any of it. |
| **Owners keep agents on a leash** | An owner's mandate caps each treaty, the total committed, and how long the agent may act. One signature switches the agent off; from then on only the owner can move its money, and refunds go to the owner. |
| **The chain enforces the spending rules too** | The owner's money can stay in the owner's own account. The agent reaches it only through a session key linked with QoreChain's **smart-account** module: the chain lets it call only `Treaty.fund` and `Treaty.refund`, caps every call and every day in QOR, expires it, and the owner revokes it in one transaction. |
| **Private deliveries** | A provider can seal its work to the client with **QoreSeal** (ML-KEM-1024 + X25519, FIPS 203), so only the client can read it. The chain still records only the hash of the work, and the client's SDK refuses an envelope whose contents do not match that hash. |
| **Readable signatures** | Every signature is a QoreSign message with plain text, such as `Treaty: accept delivery 0 of treaty #1`, so whoever signs sees exactly what they approve. Agents sign with the SDK, people with the signing tool, and in the browser with the **QoreX** wallet once its build supports message signing. All of them sign the same bytes. |
| **Records on both VMs** | Every agreement and payment writes a receipt on **QoreChain Native** in the same transaction, through the governance-pinned Cross-VM bridge. If either side fails, both are undone. |

### Two kinds of treaty

| | Service treaty | Revenue share |
| --- | --- | --- |
| For | Hiring an agent, or a team of agents, for units of work | Selling something together |
| Who signs | The client and every provider | Every party |
| Money in | The client (or its owner) locks price per unit × units | Anyone pays a fixed price |
| Money out | Each accepted unit is paid, split between the providers by share | Each payment is split by share |
| If the client goes quiet | A delivery neither accepted nor rejected pays itself after the review period | — |
| At the end | After the deadline, unused budget returns to the client, or its owner | — |
| Changes | Agree a new treaty | A new version that every old and new party signs |

## Website

The Treaty website explains the product, replays the live deal step by step, shows every transaction read directly from Diana, and runs the full app: proposing treaties, submitting signatures, locking budgets, delivering, reviewing, withdrawing and verifying receipts.

- **Live website:** **[treatyv1.vercel.app](https://treatyv1.vercel.app)** (no wallet needed to browse; connect one to make treaties)
- **Wallets:** *Connect wallet* lists every EVM wallet installed in the browser (EIP-6963: MetaMask, Rabby and others), remembers the choice, shows the account, its Diana balance and qor1 address, and offers a one-click switch to Diana (chain ID 9800). QoreX is detected separately for post-quantum signing.
- **The live deal on the site:** [treatyv1.vercel.app/#live](https://treatyv1.vercel.app/#live)
<table>
<tr><td width="50%"><img src="assets/readme/site-home.jpg" alt="Treaty home page"></td><td width="50%"><img src="assets/readme/site-live.jpg" alt="The live deal on Diana"></td></tr>
<tr><td><b>Home.</b> What Treaty is, how it works, the security model and the track requirements.</td><td><b>Live deal.</b> The 18-step run on Diana, each step linked to its transaction.</td></tr>
<tr><td width="50%"><img src="assets/readme/site-treaty.jpg" alt="Treaty #1 read live from Diana"></td><td width="50%"><img src="assets/readme/site-transaction.jpg" alt="A transaction explained and verified"></td></tr>
<tr><td><b>A treaty.</b> Terms, budget, deliveries, signatures and the Native receipt, read live from Diana.</td><td><b>A transaction.</b> Explained in plain words, with its Native receipt verified and both hashes.</td></tr>
<tr><td width="50%"><img src="assets/readme/site-make.jpg" alt="Make a treaty form"></td><td width="50%"><img src="assets/readme/site-earnings.jpg" alt="An agent statement with earnings and limits"></td></tr>
<tr><td><b>Make a treaty.</b> Propose a service treaty or a revenue share; every party then signs it.</td><td><b>Earnings.</b> What any person or agent earned, withdrew and can withdraw, and the limits its owner set.</td></tr>
</table>

Every page reads Diana directly, with no database or indexer. The only server code is a read-only proxy for QoreChain Native REST ([`api/native.js`](api/native.js)).

- Pages: `#home` (overview), `#live` (the live deal), `#service` and `#create` (make a treaty), `#agreement/<contract>/<id>` (a treaty), `#statement/<contract>/<address>` (earnings and owner limits), `#tx/<contract>/<hash>` (any transaction, explained and verified).

## Live on Diana

| Deployment | |
| --- | --- |
| Treaty contract | `0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6` |
| Deployed | Block 10,807,010, 4,688,260 gas, runtime code verified to match this repository's build ([explorer](https://explore.qore.network/tx/EB56CA60240D08C6FAAAAF6BE9E5C51DAB0262204443E0AF6348D5FFE60C37DB)) |
| Website | [treatyv1.vercel.app](https://treatyv1.vercel.app) · [treaty #1](https://treatyv1.vercel.app/#agreement/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/1) |
| Signing chain | `qorechain-diana` |
| Records | [`deployments/diana.json`](deployments/diana.json) (contract, accounts, windows) and [`deployments/diana-demo.json`](deployments/diana-demo.json) (every transaction of the run); later full runs in [`deployments/runs/`](deployments/runs), such as [Treaty #7](deployments/runs/treaty-7.json) on 27 November |

On 26 November 2026 the whole agents story ran on Diana from four separate accounts, each acting through its own scoped EVM window that allows only the Treaty contract. **All 18 transactions succeeded.** The agreement and all three payments are matched by Native receipts #41 to #44, and the final state is: 3 datasets paid, 1 rejected, 4 QOR refunded to the owner, the research agent switched off, the providers paid 4.8 and 1.2 QOR.

| # | What happened | Block | Gas used | Links |
| --- | --- | --- | --- | --- |
| 1 | The owner and the research agent both sign the agent's limits (10 QOR per treaty, 15 QOR in total, 7 days) | 10,807,125 | 483,311 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x778c28c2d0383b6cfbb0c00a7102ecab9f45078d4164efe54e8e4c6fa922cf58) · [explorer](https://explore.qore.network/tx/04BC14E7184A099BBD48DD237C8B412620CB45DA6BD5101508BE481E12D2B56B) |
| 2 | The data agent signs the terms | 10,807,130 | 258,184 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x94455203160fd0401422a8183ff0babfc8e39627092a02fd12ed7e7d14cf365c) · [explorer](https://explore.qore.network/tx/C147F4CA118BE3CBD75AA2E5061AAB8051A2F54181F0A656C6D9F3C14186B58E) |
| 3 | The cleaning agent signs the terms | 10,807,134 | 260,703 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x7ccddb392418ed3882fa9f33f3e021420332934fac849ce481faa6cc118317bd) · [explorer](https://explore.qore.network/tx/FFC1D18552846ECAEBF6956536CC0879FD6B83632B55DB13AF42262FB9C8880F) |
| 4 | The research agent signs last: the treaty goes live, terms recorded on Native (receipt #41) | 10,807,141 | 1,025,696 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0xc144fdb9198b8086e3f2b53b0c09d15bbe30295803d7665ab3b32596a1586921) · [explorer](https://explore.qore.network/tx/337B385B7AF9952EA1EC8F95EC5F8493174FB178F2E5EE3FC622BDBF32229D3D) |
| 5 | The research agent locks the 10 QOR budget | 10,807,144 | 63,819 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x26b2fd06c5a1394133a00cee2dc5350a431d930217b1039cbd02466aad88426b) · [explorer](https://explore.qore.network/tx/65EB5DCE1314F01F091950B2348245E731A295FA9CF1D6E5A71FAAA5B25BC108) |
| 6 | The data agent signs a second treaty; the research agent's signature on it is refused (`MandateLimitExceeded`) | 10,807,149 | 258,040 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x3ff24cff10bdf52561aa5c29829932612cbfbc181f0697cb05bd48cc1d2eb262) · [explorer](https://explore.qore.network/tx/481EF5567B14261AF3C4BCADFC01DF792EF5032A8BD768D5F57D934F29FBB1ED) |
| 7 | Dataset 1 delivered (only its hash on chain) | 10,807,160 | 306,494 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x4833e410dd7b28193c415d2fa849c2d28503269fd3f0e4f6f752a3d0d793bdc3) · [explorer](https://explore.qore.network/tx/F7FB774EE3ED0DB62A80EF7885A587A041E6F26C17991CD7B6BE7692C2BB255D) |
| 8 | Accepted and paid 1.6 + 0.4 QOR, Native receipt #42 | 10,807,163 | 723,094 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x83e254cb2323ab8e604b90da66e2c97692fad1d6cd62b0cf995b2580f4dbe5ce) · [explorer](https://explore.qore.network/tx/B094B09897EB85995879AAF787CB09CBA8B74423756D1C04561F899532752B96) |
| 9 | Dataset 2 delivered | 10,807,166 | 306,943 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0xfe2e2cfbbebb3b17a9f60981134dd39b45a86aa31a19c3a8118492dbf9775bc8) · [explorer](https://explore.qore.network/tx/54ECD73B0E18A46704112D3D8077668B935681807CB82FA0945E565A30794F28) |
| 10 | Rejected within the review period; nothing paid | 10,807,169 | 248,839 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0xf5fc792b78feaad39941bdbcd6e2512babef78101997bec4e451d696f643dc4f) · [explorer](https://explore.qore.network/tx/D74D6D35B71207D625EECC2339845A7DB2E95C4ADF752559DBE334964C6F61CB) |
| 11 | A fixed dataset delivered; the client does not answer | 10,807,172 | 306,979 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0xc10d5a5d0af294f7b5d98c1c24c265d9d7a96c410721f5be9ab4be26987451ce) · [explorer](https://explore.qore.network/tx/F3F532CD8B151736048B2D1CD49925DEE030DD7E655795EB6802ED9BDCC18648) |
| 12 | Released by the cleaning agent after the review period, Native receipt #43 | 10,807,224 | 480,884 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x8822c27c80eec3705a2ce43157c407366eb8a49f90abc42a3fd4751674f8f189) · [explorer](https://explore.qore.network/tx/3AE90C23AE7251C4291F432891FBCF0395AB31ABB8310BA5A263C9FBCF734E8A) |
| 13 | The owner switches the research agent off | 10,807,234 | 237,446 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0xc6be277316e7014cf75065fa09377ef2f742a46d8ba38d49f6bfe229669a51b0) · [explorer](https://explore.qore.network/tx/B6268411888C9D15E509868496F118C273C66C38A8AAF8BBDAB07B730FB3AB76) |
| 14 | Another dataset delivered; the switched-off agent's acceptance is refused (`AgentNotAuthorized`) | 10,807,240 | 306,931 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x94e9e9cc517206c0339eb08bcbe7a94a69e8f8142808ce09366e8fee86075d9f) · [explorer](https://explore.qore.network/tx/C9DF9C2F535050BFB288A947857161A733197F261D73DF5ACBC40917BC3CB186) |
| 15 | Released after the review period, Native receipt #44 | 10,807,514 | 480,884 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x518cfeed74aaa3e5ce025c8c0063e63d45ff8cb45ee3f76d1eef2f5114e44164) · [explorer](https://explore.qore.network/tx/C42A38E6812761D60427F254B680840534031467372193C7137181D8BF4792D6) |
| 16 | After the deadline the unused 4 QOR goes back to the owner | 10,807,517 | 72,972 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x2289469639e8082fc37ad87ecc8a9a799ce0de001f5022a31cc910d3da7979b2) · [explorer](https://explore.qore.network/tx/C25130E22A1602019EB6BD85553A7532356F546622AF3BC93A13ACBE5FB401B6) |
| 17 | The data agent withdraws 4.8 QOR with its ML-DSA-87 key | 10,807,522 | 309,851 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x50f240f23a0e0f796674070973c8c0694c93be6a7ce03184b88ea7aceeecd86e) · [explorer](https://explore.qore.network/tx/D990C651F80C03ABEC04E2799690D2D6E9BAE79AFACEB8CDC598A2AA1E31962E) |
| 18 | The cleaning agent withdraws 1.2 QOR | 10,807,527 | 309,899 | [site](https://treatyv1.vercel.app/#tx/0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6/0x72a4a36bac90734d2c4e818fb6f38bbb6f501c76e3b8bdccf112fd3ef2007905) · [explorer](https://explore.qore.network/tx/2F28154052954AFBDB7A0A43774DAB39CF6675AF1976341CAB4CFC2CE46DFC59) |

The attacks were also run against Diana, as simulated calls that spend nothing: with only the data agent's classical key, a withdrawal of its 3.2 QOR and a junk delivery were both refused with `BadPqcSignature`.

> **Opening the links.** The QoreChain explorer lists Cosmos transaction hashes and opens on mainnet: choose **Testnet** at the top of the explorer first, then open a link. The **site** links open Treaty's own transaction page instead: read straight from Diana, explained in plain words, with its Native receipt verified, and no setup.

## How it works

<p align="center"><img src="assets/readme/how-it-works.png" alt="Sequence of one service treaty: the owner sets limits, the agents sign the terms with ML-DSA-87, the client locks the budget, the provider delivers, the client accepts and the contract pays and writes a Native receipt" width="100%"></p>

A service treaty moves through these states:

<p align="center"><img src="assets/readme/lifecycle.png" alt="States of a service treaty: Pending, Active, Funded, Settled or Cancelled" width="100%"></p>

Each delivery waits for review. The client can accept it, and it is paid; reject it within the review period, and it is not paid (the unit can be delivered again); or say nothing, and after the review period anyone can release it, and it is paid.

### Two layers of spending rules

An agent that spends someone else's money is held by two independent layers. Treaty's own layer is in the contract; QoreChain's is in the chain itself, before the contract ever runs.

| | QoreChain smart account (chain) | Treaty mandate (contract) |
| --- | --- | --- |
| Where the money waits | In the **owner's own account** until a budget is locked | In the contract once locked |
| What the agent holds | A session key (ed25519) linked to the owner's account. It holds no money. | Its own ML-DSA-87 key |
| What it may do | Only `Treaty.fund(uint256)` and `Treaty.refund(uint256)` on this contract (`allowed_evm_calls`), with the `evm` permission only: no transfers, staking, voting or deploys | Agree to treaties within the limits |
| Caps | QOR per call and per UTC day, measured by the chain on the call's real outflow | Per treaty and in total |
| Time | An expiry on the link | An expiry on the mandate |
| Off switch | `MsgRevokeAuthenticator`, effective in the same block | `revokeMandate`: the agent can no longer sign |
| Who can change it | The owner, with a hybrid (secp256k1 + ML-DSA-87) Native transaction | The owner, with an ML-DSA-87 signature |

How a budget is locked from the owner's account:

1. The owner sends **one** hybrid transaction with `MsgUpdateSpendingRules` and `MsgRegisterAuthenticator` (`npm run accounts -- session`). The session key signs a proof that it agrees to be linked to exactly that account on that chain.
2. The agent signs a `MsgExecuteEVM` with the session key over QoreChain's v2 digest, which binds the target, value, call data, the key's own nonce and the gas limit. Its own account relays the message and pays the fee, so a relayer can neither alter nor replay it.
3. QoreChain checks the permission, the allowed calls and the caps, then runs `Treaty.fund` **from the owner's 0x address**. Treaty accepts a budget locked by the client's owner and checks the mandate, so unused budget is refunded to the owner.

A stolen session key can at most lock budget into treaties the agent already signed with its ML-DSA-87 key, within the caps; that money can only leave per accepted delivery or back to the owner. Act two runs this on Diana: `npm run demo:session` ([examples/smart-account-demo.js](examples/smart-account-demo.js)) records every transaction in `deployments/diana-smart-account.json`, and the [live page](https://treatyv1.vercel.app/#live) shows it once that record is present.

## How Treaty meets the Post-Quantum AI Agents track

| Requirement | How Treaty meets it | Where |
| --- | --- | --- |
| The agent's own **scoped EVM window**: transaction, value, duration and target limits | Each agent opens its own window, signed hybrid with its ML-DSA-87 key: the only allowed target is the Treaty contract, with 30 transactions, a capped value (budget plus fees) and 2,500 blocks (about an hour). | `npm run accounts -- windows` ([scripts/accounts.js](scripts/accounts.js)); live window transactions in [`deployments/diana.json`](deployments/diana.json) |
| **Smart-account spending rules** | QoreChain's abstractaccount module: the owner links the agent's session key to her own account with a spending rule (only `Treaty.fund` and `Treaty.refund`, QOR per call and per day, `evm` permission only, an expiry) and revokes it in one transaction; the chain checks every `MsgExecuteEVM` before it runs. On top, Treaty's mandate caps each treaty and the total, and is checked again by the contract. | [sdk/smart-account.js](sdk/smart-account.js), `npm run accounts -- session`, [examples/smart-account-demo.js](examples/smart-account-demo.js); `setMandate`, `_checkMandate`, `fund` in [contracts/Treaty.sol](contracts/Treaty.sol) |
| **Authenticated messaging** | Every message an agent sends (accepting terms, delivering work with its hash, accepting or rejecting it, withdrawing) is an ML-DSA-87-signed QoreSign message that the contract verifies with `pqcVerify` against the sender's registered key. Agents can also pass these as signed requests that any wallet relays. | [sdk/treaty.js](sdk/treaty.js), [src/protocol.js](src/protocol.js) |
| Post-quantum protection of sensitive actions | `pqcKeyStatus` and `pqcVerify` on every signed action; the stolen-key attack is shown live. | [contracts/Treaty.sol](contracts/Treaty.sol), [examples/agents-demo.js](examples/agents-demo.js) |

Treaty also uses the **Cross-VM** bridge (atomic EVM-to-Native receipts), **QoreSeal** for private deliveries, **QoreX message signing** (QoreSign message-signing-v1) and **hybrid Native transactions** (secp256k1 + ML-DSA-87) for every key registration, window and smart-account change.

## Architecture

<p align="center"><img src="assets/readme/architecture.png" alt="Architecture: agents, people and the signing tool call Treaty.sol on Diana, which uses pqcKeyStatus, pqcVerify and the Cross-VM bridge to the Native receipt book" width="100%"></p>

| Path | What it is |
| --- | --- |
| [`contracts/Treaty.sol`](contracts/Treaty.sol) | The contract: treaties, signatures, budgets, deliveries, mandates, withdrawals, Native receipts. No owner, pause or upgrade. |
| [`src/protocol.js`](src/protocol.js) | Byte-exact builders for every signed message, hash and commitment, shared by the app, SDK, tools and tests. |
| [`sdk/treaty.js`](sdk/treaty.js), [`sdk/pqc.js`](sdk/pqc.js) | The SDK for agents, and ML-DSA-87 key loading and signing with `@qorechain/sdk`. |
| [`sdk/seal.js`](sdk/seal.js) | Private deliveries: QoreSeal (ML-KEM-1024 + X25519) keys, sealing work to the client and opening it against the hash on chain. |
| [`sdk/smart-account.js`](sdk/smart-account.js), [`sdk/native.js`](sdk/native.js) | Smart-account sessions on QoreChain's abstractaccount module (link with a spending rule, `MsgExecuteEVM` from the owner's account, revoke, read back), and hybrid Native-lane broadcasting. |
| [`scripts/treaty.js`](scripts/treaty.js) | The signing tool for people (`npm run pq`). |
| [`scripts/accounts.js`](scripts/accounts.js) | Diana accounts: create, register ML-DSA-87 keys, deploy, open scoped windows, publish seal keys, link and revoke smart-account sessions (`npm run accounts`). |
| [`examples/agents-demo.js`](examples/agents-demo.js) | The agents demo, locally or on Diana (`npm run demo`). |
| [`examples/smart-account-demo.js`](examples/smart-account-demo.js) | Act two on Diana: the owner's money under QoreChain's own spending rules (`npm run demo:session`). |
| [`src/`](src) | The website and app: `app.js` (pages), `chain.js` (reads, writes, verification), `qorex.js` (QoreX signing), `story.js` (home and live pages). |
| [`api/native.js`](api/native.js), [`server/native.js`](server/native.js) | Read-only Native REST routes the browser cannot call directly (receipts, EVM windows, smart accounts, EVM-to-Cosmos hash). |
| [`scripts/local-diana.js`](scripts/local-diana.js) | A local Diana stand-in whose `pqcVerify` accepts a signature only after real ML-DSA-87 verification. |
| [`test/`](test) | Contract tests, smart-account, QoreSeal and QoreX tests, Native route tests, and end-to-end tests. |
| [`deployments/`](deployments) | Records of the Diana deployment and the live run. |

## Contract reference

### Functions

| Function | Who | Signed with ML-DSA-87 | What it does |
| --- | --- | --- | --- |
| `proposeService(title, unitPrice, maxUnits, deadline, reviewPeriod, client, providers, shares)` | anyone | — | Proposes a service treaty. Signers: the providers and the client. |
| `propose(title, price, recipients, shares, previous)` | anyone | — | Proposes a revenue share, or a new version of one (`previous`). |
| `sign(id, signer, signature)` | anyone relays | the signer | Records a signer's acceptance; the last one activates the treaty and writes its Native receipt. |
| `cancel(id)` | proposer or a signer | — | Withdraws a proposal that is not yet active. |
| `fund(id)` | client or its owner | — | Locks the whole budget, within the owner's limits. |
| `deliver(id, provider, deliverable, signature)` | anyone relays | the provider | Records one unit of work by its hash. |
| `accept(id, unit, signature)` / `reject(…)` | anyone relays | the client | Pays a delivery / refuses it within the review period. |
| `release(id, unit)` | anyone | — | Pays a delivery the client ignored past its review period. |
| `refund(id)` | anyone | — | After the deadline, returns unused budget to the client or its owner. |
| `checkout(id, reference)` | anyone | — | Pays a revenue share; every share is credited. |
| `setMandate(agent, owner, maxPerTreaty, maxTotal, expiry, agentSig, ownerSig)` | anyone relays | agent and owner | Puts an agent under an owner's limits. |
| `revokeMandate(agent, ownerSig)` | anyone relays | the owner | Switches the agent off. |
| `withdraw(recipient, to, amount, signature)` | anyone relays | the recipient, or its owner once switched off | Pays out earnings to `to`. |

Views include `getAgreement`, `getDelivery`, `getMandate`, `claimable`, `refundable`, `agreementsOf`, `treatiesAsClient`, and the message builders `termsMessage`, `deliveryMessage`, `reviewMessage`, `mandateMessage`, `revokeMessage`, `withdrawalMessage`. The contract exposes 50 functions, 14 events and 33 custom errors.

### Signed messages

Every signature uses QoreSign message signing: the ML-DSA-87 key signs `qorechain-msg-v1|<chain>|` followed by readable text that names what is authorised, the contract and the chain. For example:

```text
qorechain-msg-v1|qorechain-diana|Treaty: accept delivery 0 of treaty #1
work 0x…
contract 0xdfc61ec824205aef7f2fc80fad5dbc2cc987d0a6
chain 9800
```

The contract rebuilds the same bytes from its own state before verifying, so a signature only counts for what the signer saw.

### Limits and parameters

| Parameter | Value |
| --- | --- |
| Parties per treaty | 1 to 5 providers (service), 2 to 5 parties (revenue share) |
| Units per service treaty | 1 to 1,000 |
| Review period | 60 seconds to 30 days |
| Amounts | Whole uqor (10⁻⁶ QOR); shares in basis points, the last share takes the rounding remainder |
| Gas (Diana) | Deployment 4.69M; signing terms about 260k; the activating signature about 1.03M; delivery about 307k; acceptance with payment about 723k; withdrawal about 310k; one `pqcVerify` about 315k |

## Security model

| Threat | Defence | Evidence |
| --- | --- | --- |
| An agent's wallet key is stolen or quantum-broken | Every action that commits a party or moves money needs an ML-DSA-87 signature verified on chain against the registered key. | Live: withdrawal and junk delivery refused with `BadPqcSignature` |
| An agent overspends or is manipulated | The owner's mandate caps each treaty and the total, and expires; checked on signing and on funding. The agent's EVM window allows only Treaty, a few transactions and a capped value. | Live: a second 10 QOR treaty refused with `MandateLimitExceeded` |
| An owner needs to stop an agent | `revokeMandate`: the agent can no longer sign; withdrawals of its earnings need the owner; refunds go to the owner. `MsgRevokeAuthenticator` switches its session key off on the chain in the same block. | Live: acceptance refused with `AgentNotAuthorized`, refund to the owner. Session-key revocation: tests, and act two (`npm run demo:session`) |
| An agent's session key is stolen | The chain lets it call only `Treaty.fund` and `Treaty.refund`, within per-call and daily caps, until it expires. Funding only works for treaties the agent signed with ML-DSA-87, and locked money leaves only per accepted delivery or back to the owner. | Tests: the call policy allows only `fund` and `refund`; act two (`npm run demo:session`) tries an unlimited token approval and a transfer to the agent |
| The client never pays | The whole budget is locked before work counts; anyone can release an unreviewed delivery. | Live: ignored delivery released and paid |
| A provider is paid for unwanted work | Rejection within the review period; payments never exceed price × units. | Live: bad dataset rejected |
| A signature is replayed or the deal changed | Messages name the chain, contract, terms hash, work hash and unit, amount and a per-account counter. Terms never change. | Tests: replayed and redirected withdrawals refused |
| A third party locks a client's budget | Only the client or its owner can fund, so refunds return to whoever paid. | Found and fixed in the 26 November audit |
| The two VMs disagree | Receipts are written in the same transaction; any failure undoes both. | Live: receipts #41 to #44 match their commitments |

Further guarantees: signer keys must carry a proof of possession; state is updated before every payout; pending deliveries stay reserved after the deadline; there is no contract owner, operator withdrawal, pause or upgrade. See [AUDIT.md](AUDIT.md) for every finding and its resolution.

## Getting started

Requires **Node.js 22.9 or later**.

```sh
git clone https://github.com/drained69/treaty.git
cd treaty
npm ci
npm run demo            # the agents story locally, in about 30 seconds
npm run demo -- --serve # then open the web app on that local chain
npm run dev             # the website against the Diana deployment (.env.production)
```

### Run it on Diana

```sh
npm run accounts -- create      # five fresh testnet accounts in .env.diana (git-ignored)
# claim test QOR for each printed qor1 address: https://dashboard.qorechain.io/faucet
npm run accounts -- register    # register each account's ML-DSA-87 key
npm run accounts -- deploy      # deploy Treaty (saves its address to .env.diana)
npm run accounts -- windows     # open each party's scoped EVM window
npm run accounts -- seal-keys   # optional: publish each agent's ML-KEM-1024 key in the KEM registry
npm run demo -- --diana         # the agents demo on Diana; writes deployments/runs/treaty-<id>.json
npm run accounts -- status      # balances, keys and windows at any time
npm run accounts -- session     # owner links the research agent's session key (QoreChain smart account)
npm run accounts -- session-status   # what the chain enforces for it
npm run demo:session            # act two on Diana; writes deployments/diana-smart-account.json
```

Act two needs live windows for the research and data agents (`npm run accounts -- windows`) and about 7 QOR in the owner's account; the owner herself needs no EVM window.

Keys stay in `.env.diana` on your computer. Use testnet-only accounts.

### Deploy the website

The repository is ready for **Vercel**: import it, keep the detected settings, and deploy. [`vercel.json`](vercel.json) sets the build, and [`api/native.js`](api/native.js) serves the read-only Native routes. The public contract address is in [`.env.production`](.env.production). `npm run build` also produces a single Cloudflare-style Worker at `dist/server/index.js` for other hosts.

## SDK and signing tool

### For agents

```js
import { Treaty } from './sdk/treaty.js';

const agent = await Treaty.connect({ contract, mnemonic });        // or privateKey + recoveryCode
const id = await agent.proposeService({
  title: 'Clean five survey datasets', unitPrice: '2', maxUnits: 5,
  deadline, reviewPeriod: 600, client: agent.address,
  providers: [dataAgent, cleaningAgent], shares: [8000, 2000],
});
await agent.sign(id);                     // checks the terms, signs them with ML-DSA-87
await agent.fund(id);                     // locks the budget
// a provider: await provider.deliver(id, workBytes)
// or privately: const { envelope } = await provider.deliver(id, workBytes, { sealTo: agent.sealKey() })
//               const work = await agent.openDelivery(id, 0, envelope)   // checks it against the hash on chain
await agent.accept(id, 0);                // or reject(id, unit); anyone can release(id, unit) later
await provider.withdraw('all');
```

Every signed action rebuilds the exact bytes from the on-chain terms and refuses to sign if the contract would check anything else; it checks the local key against the chain's registry and the account's EVM window before sending. `{ relay: true }` returns a signed request any wallet can submit, and `treaty.relay(request)` submits one. Owners: `agent.approveOwner(limits)` returns the agent's consent, `owner.setMandate({ agent, ...limits, agentSignature })` sets the limits, `owner.revoke(agent)` switches it off. `treaty.explorerLink(hash)` returns the explorer link for a transaction.

Spending the owner's money through a smart-account session ([sdk/smart-account.js](sdk/smart-account.js)):

```js
import { broadcast } from './sdk/native.js';
import { OwnerSession, linkSessionMsgs, revokeSessionMsg, sessionKey } from './sdk/smart-account.js';

// The owner, once: link the agent's session key under a rule the chain enforces.
const session = sessionKey(agentSessionSecret);           // ed25519; holds no money
await broadcast(ownerAccount, linkSessionMsgs({
  owner: ownerAccount.cosmos, session, contract,
  perCall: parseEther('6'), perDay: parseEther('6'), hours: 24,
}));

// The agent: lock a treaty's budget from the owner's account. Its own account relays and pays the fee.
const owner = new OwnerSession({ contract, owner: ownerAddress, session, relayer: agent.signer.unified, client: agent.client });
const result = await owner.fund(id);      // { success, cosmosTx } or { success: false, reason } if the chain refuses
await owner.status();                     // the rules, the key, its expiry and calls made, read from Diana

// The owner, at any time: switch the key off.
await broadcast(ownerAccount, [revokeSessionMsg({ owner: ownerAccount.cosmos, session })]);
```

### For people

In the web app, people can sign with the **QoreX** wallet: accept terms, deliver a file (only its hash goes on chain), accept or reject a delivery, withdraw, or switch an agent off. Any connected EVM wallet then sends the transaction. The app finds QoreX with the official `@qorechain/qorex-types` helpers and offers QoreX signing only to a build that announces message signing: today's QoreX refuses `signArbitrary`, so the app says so and points to the signing tool, whose signed requests any wallet can submit in the app. `test/qorex.test.js` runs this against the official QoreX mock (`@qorechain/qorex-wallet-mock`): today's behaviour, and the planned message signing, whose signatures verify with `@qorechain/pqc` over exactly the bytes the contract checks.

The signing tool has every action, with keys in `.env` (`QORE_MNEMONIC`, or `PRIVATE_KEY` with `QORE_PQC_RECOVERY_CODE`):

| Command | What it does |
| --- | --- |
| `npm run pq -- whoami` | Your addresses, and whether your local ML-DSA-87 key matches the chain |
| `npm run pq -- show <id>` | A treaty's terms, signatures and deliveries |
| `npm run pq -- sign <id>` | Accept a treaty's terms |
| `npm run pq -- fund <id>` | Lock a service treaty's budget |
| `npm run pq -- deliver <id> --file f` | Deliver one unit; only its hash goes on chain |
| `npm run pq -- deliver <id> --file f --seal <key file\|chain>` | Also encrypt the work to the client with QoreSeal, and save the envelope to send them |
| `npm run pq -- seal-key` | Your seal key (public), to give to providers |
| `npm run pq -- open <id> <unit> --file envelope` | As the client, decrypt a sealed delivery and check it against the hash on chain |
| `npm run pq -- accept <id> <unit>` / `reject` | Review a delivery as the client |
| `npm run pq -- release <id> <unit>` / `refund <id>` | Pay an ignored delivery; return unused budget after the deadline |
| `npm run pq -- withdraw <QOR\|all> [--to 0x…] [--for 0x…]` | Pay out earnings (`--for`: an agent you own and switched off) |
| `npm run pq -- statement [0x…]` | Earnings, withdrawals, treaties and owner limits |
| `npm run pq -- approve-owner …` / `set-limits …` / `revoke <agent>` | Put an agent under an owner's limits, or switch it off |
| `npm run pq -- attack [QOR]` | Demo: the classical key alone tries to withdraw. Simulated; nothing is sent |

`--out file.json` saves a signed request instead of sending it; paste it into *Submit a signature* in the app. `--yes` skips the confirmation.

## Verification

| Command | What it proves | Needs |
| --- | --- | --- |
| `npm test` | The contract's rules on an in-process EVM with stand-ins for the bridge and the post-quantum precompiles: consent, signature binding, keys, amendments, cancellation, the stolen-key attack, relayed withdrawals and replay, rounding, receipts, Native rollback, invalid terms; service budgets, deliveries, reviews, release, unit caps, deadlines and refunds; owner limits, changes, switching off and expiry. The contract's exact message bytes are checked against the SDK's, and signed with real ML-DSA-87 keys that also verify with `@qorechain/pqc`. Smart-account sessions: the call policy names exactly `fund` and `refund`, the rule's caps, the link transaction and its possession proof, and the `MsgExecuteEVM` signature over the v2 digest (and that changing the gas, value or nonce breaks it). QoreX signing against the official QoreX mock. Sealed deliveries: only the client opens them, only for their treaty and unit. | Nothing |
| `npm run e2e` | The whole product on a local Diana stand-in (chain ID 9800) whose `pqcVerify` accepts a signature only after real ML-DSA-87 verification: the real deploy script and signing tool as separate processes with fresh keys; revenue shares, service treaties and agent limits end to end; a sealed delivery through the signing tool; the web app in a real browser, including QoreX signing with real QoreSign signatures; and the agents demo, whose datasets are sealed to the research agent. | Playwright for the browser part (`npm i -D playwright && npx playwright install chromium`); without it that part is skipped |
| `npm run check:diana` | Diana itself, read-only: `pqcVerify` accepts real ML-DSA-87 signatures, including QoreX-style ones, over Treaty's exact messages and refuses tampered ones; Treaty's deployment fits Diana's limits and its code runs on Diana's EVM; the key registry, verifier and bridge answer from a contract as Treaty expects; Native REST returns receipts and windows as the app reads them. | Network access to Diana |

On a network that needs an HTTPS proxy, run the Node scripts with `NODE_USE_ENV_PROXY=1`.

## Video

The three-minute demo: **[watch it on YouTube ↗](https://youtu.be/3yRMDFFxSx0)**.

## Status and roadmap

**Status.** Deployed and exercised on the Diana testnet; test QOR has no monetary value. Today's QoreX extension refuses message signing (`signArbitrary`), so the app offers QoreX signing only to a build that announces it and otherwise points to the signing tool. That flow is tested against the official QoreX mock and QoreSign library.

**Next.**
- Session keys that also sign Treaty's reviews through the smart account, so an agent needs no account of its own.
- Milestone-based treaties with different prices per unit, and disputes with an agreed arbiter.
- Mainnet, once `pqcVerify` and `pqcKeyStatus` are enabled there by governance.

## Credits and licence

Built during Build Before Q-Day (November 2026). It uses the QoreChain kits and examples, with thanks:

- [`@qorechain/sdk`](https://www.npmjs.com/package/@qorechain/sdk), [`@qorechain/evm`](https://www.npmjs.com/package/@qorechain/evm) and [`@qorechain/qoresign`](https://www.npmjs.com/package/@qorechain/qoresign): ML-DSA-87 keys and signing, PQC and KEM key registration, EVM windows, QoreSign message signing.
- [`@qorechain/qoreseal`](https://www.npmjs.com/package/@qorechain/qoreseal): ML-KEM-1024 encryption of deliveries to the client ([sdk/seal.js](sdk/seal.js)).
- [`@qorechain/qorex-types`](https://www.npmjs.com/package/@qorechain/qorex-types) and [`@qorechain/qorex-wallet-mock`](https://www.npmjs.com/package/@qorechain/qorex-wallet-mock): finding QoreX in the browser, and testing against its official test double.
- [`@qorechain/pqc`](https://www.npmjs.com/package/@qorechain/pqc): SHAKE-256 for seal keys, and an independent ML-DSA-87 check of the SDK's and QoreX's signatures.
- The [Build Before Q-Day workshops](https://github.com/qorechain/build-before-qday): the Cross-VM bridge interface and the governance-approved Native receipt book (workshop 3), the `pqcVerify` vault pattern and the window script (workshop 2), the spend-capped agent idea (workshop 2).
- [viem](https://viem.sh), [solc-js](https://github.com/ethereum/solc-js), [Vite](https://vitejs.dev), [@scure/base](https://github.com/paulmillr/scure-base), the Schibsted Grotesk, Instrument Sans and Martian Mono typefaces; [Hardhat](https://hardhat.org) and [Playwright](https://playwright.dev) for testing.

How AI was used to build Treaty: [AI_USAGE.md](AI_USAGE.md). Release review: [AUDIT.md](AUDIT.md).

Licence: [MIT](LICENSE).
