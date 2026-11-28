# Treaty security audit

The release review of Treaty: every risk found while building it, how each was resolved, and what is still open. It covers the contract `contracts/Treaty.sol`, deployed on QoreChain Diana at `0xDfc61ec824205AEF7f2FC80FaD5DBC2Cc987D0a6`, the SDK, the signing tool and the web app. Latest review: 27 November 2026.

Treaty was called QoreSplit until version 2 and QorePact briefly during version 3.

## Summary

| | |
| --- | --- |
| Result | 33 risks reviewed across four versions; all resolved. No open finding can move, lock or lose funds. |
| Contract | No owner, administrator, pause, upgrade or operator withdrawal. Its rules are the only authority over the money it holds. |
| Tests | `npm test`: 34 of 34 pass (27 November 2026), with real ML-DSA-87 keys. |
| Live on Diana | 18 of 18 transactions of the agents story succeeded on 26 November 2026; the stolen-key and over-limit attempts were refused on chain. |
| Diana checks | `npm run check:diana`: 21 of 21 read-only checks pass against Diana itself (27 November 2026). |
| Dependencies | `npm audit --omit=dev`: 0 vulnerabilities. The 15 advisories in the full tree (11 low, 3 moderate, 1 high) are all in Hardhat, the test runner, which nothing shipped uses. |

## How it was reviewed

1. **Review** of the contract and every signed-message builder, checking each money path for authorisation, accounting and replay.
2. **Contract tests** on an in-process EVM (`npm test`), with stand-ins for QoreChain's precompiles and messages signed with real ML-DSA-87 keys.
3. **End-to-end tests** on a local Diana stand-in whose `pqcVerify` accepts a signature only after verifying it with real ML-DSA-87 (`npm run e2e`): the real deploy script, signing tool, SDK and web app.
4. **Read-only checks against Diana** (`npm run check:diana`): the real precompiles, key registry, bridge and smart-account module answer as Treaty expects.
5. **A live run on Diana** from four separate accounts, each limited to the Treaty contract by its own EVM window.

## Core guarantees

| Guarantee | Enforced by | Evidence |
| --- | --- | --- |
| Nobody is committed, paid or added without an ML-DSA-87 signature over the exact terms | `sign` and `_requirePqcSignature`: `pqcKeyStatus` must report a registered, proven key, then `pqcVerify` checks the signature | Tests; live run, steps 2 to 4 |
| A stolen or quantum-broken secp256k1 key can do nothing | Every action that commits a party or moves money needs the ML-DSA-87 signature; there is no classical-key path | Live: withdrawal and junk delivery refused with `BadPqcSignature` |
| A signature counts only once, for what was shown | Signed bytes name the chain, contract, treaty, unit, work hash, amount and a per-account nonce, and the contract rebuilds them from its own state | Tests: replayed and redirected withdrawals refused |
| An agent cannot exceed its owner's limits | `_checkMandate` when the agent signs as a client and again in `fund` | Live: second treaty refused with `MandateLimitExceeded` |
| A switched-off agent can sign nothing, and its money answers to the owner | `revokeMandate`; withdrawals then need the owner's signature, refunds go to the owner | Live: `AgentNotAuthorized`, refund to the owner |
| Workers are paid for work the client ignores | `release` after the review period, by anyone | Live: two ignored deliveries released and paid |
| Payments never exceed the agreed budget, and unused budget returns | Units capped at the maximum; `refund` after the deadline keeps pending deliveries reserved | Tests; live: 4 QOR refunded |
| No reentrancy on payouts | State is updated before every transfer; a failed transfer reverts the whole call | Review; tests |
| The EVM and Native records agree | The receipt is written through the Cross-VM bridge in the same transaction (`_record`); any failure undoes both | Live: Native receipts #41 to #44 match their commitments |

## Open items and known limits

| # | Item | Impact | Status |
| --- | --- | --- | --- |
| 1 | `_requirePqcSignature` does not compare the `algorithmId` that `pqcKeyStatus` returns | None today: `pqcVerify` verifies ML-DSA-87 only, so another key type fails verification anyway. An explicit check would give a clearer error | Hardening for the next contract version |
| 2 | The smart-account act two (`npm run demo:session`) has not yet run on Diana | The rules it relies on are covered by tests and confirmed on Diana by `check:diana`; the recorded run is still to come | Planned before submission |
| 3 | `accounts -- seal-keys` has not yet run on Diana | Private deliveries work with keys exchanged directly; publishing keys on chain is untested live | Tested locally |
| 4 | QoreSeal hides the payload only; its construction awaits external review before its 1.0 release | Sizes and timing of deliveries stay public | Upstream (QoreChain) |
| 5 | Today's QoreX extension refuses message signing (`signArbitrary`) | People sign with the signing tool instead; the app offers QoreX only to builds that announce message signing | Upstream (QoreChain) |
| 6 | Contract tests use stand-ins for the precompiles | Covered by the end-to-end stand-in with real ML-DSA-87, the Diana checks and the live run | Accepted |
| 7 | Testnet only | Test QOR has no value; mainnet needs `pqcVerify` and `pqcKeyStatus` enabled there by governance | Roadmap |

## Findings by version

Newest first. Each ID (for example V3-7) refers to one row.

### Version 4: smart-account spending rules

Scope: `sdk/smart-account.js` and `sdk/native.js` (sessions on QoreChain's abstractaccount module), the account commands, act two of the demo, the Native route `/api/native/smart-account/<qor1>`, and the statement card. The contract did not change and was not redeployed: it already accepts a budget locked by the client's owner.

| ID | Risk | Resolution |
| --- | --- | --- |
| V4-1 | A stolen session key drains the owner's account. | The key is linked with the `evm` permission only (no `send`, staking, voting or deploy), and the rule's `allowed_evm_calls` lists only `Treaty.fund(uint256)` and `Treaty.refund(uint256)` on this contract. Every call is capped per call and per UTC day in QOR, measured by the chain on the call's real outflow, and the link expires. `fund` succeeds only for treaties the client agent signed with ML-DSA-87 within its mandate, and locked money leaves only per accepted delivery or back to the owner. |
| V4-2 | A relayer alters or replays the agent's call. | The session key signs the v2 `MsgExecuteEVM` digest, which binds the chain, the account, the key, the target, the value, the call data, the key's own nonce and the gas limit. The chain refuses a mismatch, and a refused execution still consumes the nonce. Tests check that changing the gas, value or nonce breaks the signature. |
| V4-3 | Someone links a key to an account they do not own, or a key is linked without consent. | Linking is an owner-signed hybrid transaction (secp256k1 + ML-DSA-87); the session key signs a possession proof bound to the chain and that exact account, which the SDK verifies before sending. |
| V4-4 | A refused execution is read as a success. | From chain v3.2.8 a refused execution is a code-0 transaction with an `abstractaccount_execution_failed` event. The session reads the delivered transaction and reports `success: false` with the chain's reason. |
| V4-5 | The rule is wider than intended. | `MsgUpdateSpendingRules` replaces the account's rules wholesale; the SDK builds one rule with both caps set (the chain refuses a value permission without a bounding rule) and validates it with the SDK's own checks before sending. |
| V4-6 | An account that never linked a key breaks the statement page. | Diana answers 404 for it; the route and the SDK report it as "not a smart account" instead of an error. |

### Version 3.1: private deliveries and QoreX detection

Scope: QoreSeal sealed deliveries (`sdk/seal.js`, `deliver --seal`, `open`, `accounts -- seal-keys`), QoreX detection with `@qorechain/qorex-types`, and tests against the official QoreX mock. The contract did not change, so the deployment and the live run on Diana stand.

| ID | Risk | Resolution |
| --- | --- | --- |
| V3.1-1 | A provider seals one thing and puts the hash of another on chain. | The client's `openDelivery` hashes the plaintext and refuses unless it equals the delivery's hash on chain. |
| V3.1-2 | An envelope for one delivery is presented as another treaty's or unit's work. | The envelope's authenticated data names the contract, treaty and unit, and QoreSeal binds the chain and the purpose `treaty-delivery`; opening it as anything else fails. |
| V3.1-3 | Someone other than the client reads the work. | It is sealed to the client's ML-KEM-1024 key (plus X25519 in the hybrid mode). Tested: another party's keys, including the co-provider's, cannot open it. |
| V3.1-4 | A malformed or substituted seal key. | Keys are checked as the chain checks registered keys (length and the FIPS 203 modulus check) before anything is sealed. A provider should get the key from the client, or from the chain's KEM registry with `sealTo: 'chain'`. |
| V3.1-5 | The app offers QoreX signing that today's QoreX would refuse. | QoreX signing is offered only to a build that announces message signing; otherwise the app explains why and points to the signing tool. |

Known limits: QoreSeal hides only the payload (sizes and timing stay public), and its construction is pending external review before its 1.0 release. Seal keys from a mnemonic use QoreSeal's standard derivation; from a private key they use `SHAKE-256("treaty:qoreseal:v1|" + key)`, which only Treaty tools reproduce. `accounts -- seal-keys` follows the same broadcast path as the tested key registration but has not yet been run on Diana.

Contract re-review (no change deployed): state is updated before every transfer (refund, withdraw, payouts); every signed message names the chain, contract, treaty and unit or nonce, so none can be replayed; deliveries cannot exceed the unit cap; a switched-off agent cannot sign. One hardening note for a future version: `_requirePqcSignature` does not compare the `algorithmId` that `pqcKeyStatus` returns. It has no effect today, because `pqcVerify` verifies ML-DSA-87 only, so a key of another algorithm fails verification; checking it explicitly would give a clearer error.

### Version 3: service treaties and agent owners

Scope: service treaties (budget, deliveries, review, release, refund), agent mandates (owner limits, switching off, expiry), the SDK, the relayable request format, and the web app's new pages.

| ID | Risk | Resolution |
| --- | --- | --- |
| V3-1 | A provider starts work and the client never pays. | The whole budget is locked before any delivery counts, and a delivery the client neither accepts nor rejects can be released by anyone after the review period. |
| V3-2 | A client is charged for work it rejected, or for more units than agreed. | A rejection within the review period frees the unit without payment. Deliveries stop once paid plus pending units reach the maximum, or at the deadline. |
| V3-3 | Unused budget is stuck, or a refund takes money owed for delivered work. | After the deadline anyone can refund; pending deliveries stay reserved and can still be accepted or released. |
| V3-4 | A forged delivery, acceptance or rejection. | Each is ML-DSA-87 signed over the chain, contract, treaty, unit and work hash, by a listed provider or the client respectively. |
| V3-5 | An agent overspends, or keeps acting after its owner wants it stopped. | The owner's per-treaty and total limits are checked when the agent signs as a client and again when its budget is locked. A revoked or expired agent cannot sign anything; its withdrawals need the owner's signature and its refunds go to the owner. |
| V3-6 | Someone claims an agent, or an agent names an owner who did not agree. | Setting limits needs both the agent's and the owner's ML-DSA-87 signatures, with a per-agent nonce. Only the current owner can change them. |
| V3-7 | A third party locks a client's budget, and the unused part is refunded to the client instead of to them. | Only the client, or the client's owner, can lock a budget, so refunds always go back to whoever's money it was. Found in the 26 November audit. |
| V3-8 | A relayed request could call something unexpected. | The signed request names one of seven post-quantum-signed actions with typed arguments; anything else is refused before a wallet sees it, and the contract checks the signature regardless. |

The local Diana stand-in used by `npm run e2e` and `npm run demo` verifies every ML-DSA-87 signature in these actions with real cryptography before its `pqcVerify` stand-in accepts it.

### Version 2: post-quantum consent and withdrawals (QoreSplit)

Scope: agreement proposals, ML-DSA-87 consent, amendments, post-quantum withdrawals, the signing tool, and the relay form.

| ID | Risk | Resolution |
| --- | --- | --- |
| V2-1 | An organizer could list anyone as a recipient at any share. | A link takes payments only after every recipient signs the exact terms with the ML-DSA-87 key registered for their account. |
| V2-2 | A split change could drop or dilute a collaborator. | A new version also needs every recipient of the version it replaces. It activates only while that version is still active, so a competing amendment goes stale. |
| V2-3 | A stolen or quantum-broken secp256k1 key could withdraw earnings. | Withdrawals require an ML-DSA-87 signature over the recipient, destination, amount and nonce. There is no classical-key withdrawal path. |
| V2-4 | A signature could be replayed on another agreement, deployment, chain or withdrawal. | Signed bytes include the chain ID, the contract and the agreement number or nonce. A nonce increases with each withdrawal. |
| V2-5 | A key registered without proof of possession, or no key at all. | `pqcKeyStatus` must report a registered key with a proof of possession at signing time. |
| V2-6 | The signing tool could sign bytes that differ from the terms it shows. | The tool recomputes the terms hash and the message from the displayed terms and refuses if the contract asks for anything else. It also refuses when the local key differs from the registered one. |
| V2-7 | A pasted signed request could target another chain or deployment. | The app checks the chain ID and contract before relaying; the contract checks the signature regardless of who sends it. |
| V2-8 | Pending proposals could clutter a collaborator's statement. | Statements list only agreements that went live. |

The contract tests run on stand-ins for `pqcVerify` and `pqcKeyStatus`, because no local EVM has QoreChain's precompiles. `npm run e2e` closes most of that gap: its stand-in accepts a signature only after verifying it with real ML-DSA-87, and it drives the real deploy script, signing tool and web app.

Live read-only checks on Diana (`npm run check:diana`, first run 25 November 2026, last run 27 November 2026) confirmed:

- `pqcVerify` accepts deterministic and hedged ML-DSA-87 signatures from `@qorechain/sdk` over QoreSplit's exact terms and withdrawal bytes, and refuses a changed message. One verification costs about 315,000 to 321,000 gas including calldata.
- `pqcKeyStatus` returns a registered account's 2592-byte key with its proof-of-possession flag, in the ABI the contract decodes.
- QoreSplit deploys inside a call. Its `sign` reaches the real registry and verifier: `BadPqcSignature` for a junk signature from a registered account, `PqcKeyNotRegistered` for an account without a key.
- The bridge writes QoreSplit's note to the pinned receipt book (code 865) and returns ABI-wrapped JSON longer than 64 bytes. Native REST returns receipts with `id`, `sender`, `note` and `height`, and EVM windows with `live`, `allowed_targets` and remaining limits.

Windows on Diana can be limited to specific contracts, transaction counts and value. The app and the signing tool now name the rule that would refuse a transaction before anything is signed or sent. The mined end-to-end run this left open was done on 26 November 2026: all 18 transactions succeeded (README, *Live on Diana*).

`npm audit --omit=dev` reports zero advisories (re-checked 27 November 2026). Hardhat 2, used only to run the tests, carries advisories in its own development dependencies; it is not part of the app, the Worker, the SDK or the signing tool.

### Version 1

Scope: the contract, deployment preflight, browser wallet flow, checkout links and receipts, withdrawals, browser-to-Native connectivity, and locked dependencies. The target is QoreChain Diana, chain ID 9800.

| ID | Finding | Resolution |
| --- | --- | --- |
| V1-1 | Diana Native REST lacks browser CORS headers. A checkout could confirm on EVM while the hosted app could not read the matching Native receipt. | Added two same-origin, read-only routes with fixed Diana upstreams, bounded inputs, and timeouts. |
| V1-2 | Share links depended on the configured deployment's numeric IDs. Reconfiguring the host could point an old link at a different checkout. | URLs include the expected contract address. The client checks the Diana chain ID and matches deployed bytecode against the build artifact before reading or signing. |
| V1-3 | Transaction confirmation alone did not establish that a replacement or recovered transaction completed the intended checkout. | The app saves the expected payment ID with a pending hash and requires a matching checkout event before showing its receipt. |
| V1-4 | The bridge accepted an ABI-wrapped empty reply as evidence of a receipt. | The contract rejects responses too short to contain the pinned Native receipt format. |
| V1-5 | Browsers with QoreX and MetaMask can expose multiple providers. | Discover EIP-6963 providers and prefer MetaMask for EVM writes. QoreX can open the Diana authorization window. |
| V1-6 | The original compiler dependency pulled in npm-advised versions of the `tmp` module. | Updated the pinned compiler and patched `tmp` dependency. The resulting npm audit had zero reported advisories. |

Payout amounts are computed on chain in whole uqor. The last recipient receives the rounding remainder. Only a recipient can withdraw their credits. Credits are zeroed before the transfer, and a failed transfer restores them through the transaction revert.

The browser independently checks the committed EVM event, its payout amounts and digest, and the Native receipt's sender, note and block height. If the Native read is unavailable or does not match, the browser marks that side unverified.

Local integration tests exercise checkout and withdrawal, including an unsuccessful Native receipt write. Version 2 replaces `withdraw()` with the post-quantum withdrawal above. The live Diana check uses read-only simulation and public queries. The mined deployment followed in version 3 (block 10,807,010).
