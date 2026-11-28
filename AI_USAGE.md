# How AI was used to build Treaty

Treaty was built for Build Before Q-Day by one developer working with **Claude Code** (Anthropic), an AI coding agent, in cloud development sessions on this repository. The AI wrote most of the code and documentation. The developer decided what to build, ran everything that needed keys or a real person, and merged every change. Nothing the AI claimed was taken on trust: each claim in the README is backed by a test, a check against the live Diana testnet, or a transaction on chain.

This file is meant to be checked, not just read. Every date, commit and number below can be verified in the git history, the CI runs and the records in `deployments/`.

## At a glance

| | |
| --- | --- |
| AI tool | Claude Code (Anthropic), in cloud sessions with a terminal, a headless browser and read-only access to the Diana testnet |
| Built | From 21 November 2026; building at the fest opened on 4 November |
| Commits | As of 27 November: 44, of which 23 written by the agent (author `Claude`), 4 by the developer (`drained69`, `drained`: the first version and the live-run records) and 17 merges. Changes reach `main` through pull requests that the developer merges, or that the agent merges on the developer's explicit instruction |
| Size | One 741-line Solidity contract, about 6,600 lines of JavaScript (SDK, tools, web app, tests) |
| Checks | 34 unit tests, 6 end-to-end tests (real ML-DSA-87 keys, a real browser), read-only checks against Diana, CI on every change |
| On chain | Two complete 18-transaction runs from five accounts (Treaty #1 and #7), four seal keys published, every transaction signed on the developer's own computer |

## The workflow

Each round followed the same loop.

1. **The developer set the goal**, in plain language and often bluntly. Real prompts from the sessions:
   - "I don't think it's good enough to win, improve the idea"
   - "make it about agents, not just selling"
   - "is it possible to make my project use them" (about the QoreChain kits), then "build everything worth adding then"
   - "audit and make perfect review and think of what judges will want to see"
   - "look through each where my product is not strong enough"
2. **The agent researched before writing code.** It read the official QoreChain workshop code (the `pqcVerify` vault, the window script, the bill-paying agent, the Cross-VM checkout), the SDK's type definitions, the published packages of every kit it considered, QoreChain's documentation, and the fest's rules, prizes and FAQ.
3. **The agent proposed a plan with trade-offs, and the developer chose.** Examples: turning a split-payment checkout into agreements between agents; adding owner limits; entering Post-Quantum AI Agents; which kits to adopt; the name (QoreSplit, then QorePact, then Treaty).
4. **The agent built it and checked its own work**: unit tests, the end-to-end suite, read-only calls to Diana, and screenshots of the web app at desktop and phone width. It fixed what it found before reporting back.
5. **The agent committed each verified step** with a message that says what changed and why, on a branch, and opened a pull request.
6. **The developer reviewed the result, ran what needed keys, and merged.**

## Timeline

| Date | What was built | Where to look |
| --- | --- | --- |
| 21 Nov | QoreSplit: a checkout whose payments are split between collaborators, with receipts on QoreChain Native through the Cross-VM bridge | `c3df111`, then a hardening and audit pass |
| 25 Nov | Post-quantum consent (nobody can be put on a split without signing with ML-DSA-87), amendments, post-quantum withdrawals; the end-to-end suite and live Diana checks; the pivot to agreements between people and AI agents, with service treaties and owner limits | `4e65cda`, `32395fa` |
| 26 Nov | An audit that found a real bug (below); the rename to Treaty; the deployment and the first live run on Diana (Treaty #1, 18 transactions); the website | `bc073fc`, `deployments/diana-demo.json` |
| 27 Nov | Smart-account spending rules; QoreSeal private deliveries and the official QoreX kits; CI; a judge's-eye audit; the second live run (Treaty #7) and the seal keys | `b4f029e`, `deployments/runs/treaty-7.json`, `deployments/seal-keys.json` |
| 28 Nov | A review against a hackathon judge's published method: modules renamed so scanners see the tests and kits, a 3-minute review section in the README, and this file rewritten | this pull request |

## What the AI generated

Nearly all code and documentation:

| Area | Files |
| --- | --- |
| Smart contract | `contracts/Treaty.sol`: ML-DSA-87 consent, revenue shares and amendments, service treaties (budget, deliveries, review, release, refund), owner mandates, readable QoreSign-format messages, Cross-VM receipts |
| SDK | `src/protocol.js` (byte-exact messages), `sdk/treaty.js` (the agent SDK), `sdk/pqc.js` (ML-DSA-87 signing), `sdk/seal.js` (QoreSeal deliveries), `sdk/smart-account.js`, `sdk/native.js` |
| Tools | `scripts/treaty.js` (signing tool), `scripts/accounts.js` (accounts, windows, seal keys), `scripts/deploy.js`, `scripts/check-diana.js` |
| Web app | `src/app.js`, `src/chain.js`, `src/qorex.js`, `src/story.js`, `src/style.css`, `index.html`, `server/native.js` |
| Demos | `examples/agents-demo.js` (the agents story), `examples/smart-account-demo.js` |
| Tests | `test/*.test.js` and `scripts/local-diana.js`: a local Diana stand-in whose `pqcVerify` accepts a signature only after real ML-DSA-87 verification |
| Docs and media | `README.md`, `AUDIT.md`, this file, the README images and site screenshots, and the demo video (below) |

## How the AI's work was checked

- **Unit tests** (`npm test`): the contract's rules; that the contract's message bytes equal the SDK's for every kind of signature; SDK signatures also verified with the independent `@qorechain/pqc` library; QoreSeal; QoreX signing against QoreX's official test double.
- **End-to-end tests** (`npm run e2e`): the real deploy script, signing tool, demo and web app in a real browser, against a chain where forged signatures fail as they do on Diana.
- **Read-only checks against Diana** (`npm run check:diana`): real precompiles, real key registry, real bridge.
- **The live runs**, which only the developer could do, because they need the keys.
- **CI** runs the unit tests, the build and the end-to-end suite on every pull request. Since it was added on 27 November, nothing has been merged with a failing run.
- **Screenshots** of every page at desktop and phone width, which caught layout bugs such as long addresses overflowing on phones.

## Mistakes the AI made, and how they were caught

| Mistake | How it was caught | What changed |
| --- | --- | --- |
| Anyone could lock a client's budget, but refunds went to the client, so a stranger could lose money | An audit round in which the agent re-read its own contract | Only the client or its owner can lock a budget; tests added (`AUDIT.md`) |
| Tooling that worked locally failed on Diana: the RPC caps gas estimates at 5M, state overrides switch off the precompiles, and contract creation needs a window without a target list | Read-only checks against the real testnet | The tools handle each case |
| The README and site said people sign in the browser with QoreX today; in fact today's QoreX refuses arbitrary message signing | Testing against QoreX's official test double (`@qorechain/qorex-wallet-mock`) | QoreX signing is offered only to a build that supports it; the claim was corrected everywhere |
| The demo wrote every live run to the same file, so the second run replaced the record the website and README cite | The agent's review after the developer pushed the second run | Each run now gets its own file; the cited record was restored |
| All modules used `.mjs`, so standard repository scanners counted no tests and almost none of the QoreChain kit imports | Running a hackathon judge's own scan script on the repository | Every module renamed to `.js` (`package.json` already sets ES modules); behaviour unchanged |

Kits were not added for show. The agent read each QoreChain kit before using it and **rejected** Handles (QoreChain's own docs say the registry address and key are not published) and QoreScan (it inventories a node's data directory, which Treaty does not have), and recorded why.

## The demo video

The demo video was made in code by the agent with Remotion (it lived in this repository from `9d6c349` until it was removed from `main` on 27 November), with music and sound effects generated in code and a text-to-speech narrator. The developer reviewed and published it. The transactions it shows are real.

## What the developer did

- **Product direction.** The original idea, the pivot to agents, owner limits, the choice of category and name, and which kits to adopt.
- **Every live action.** Registering for the fest; creating, funding and registering the five Diana accounts; deploying the contract; both live runs; publishing the seal keys; and recording the results in `deployments/`.
- **Review and merging.** Reading what the agent reported, pushing back when it was not good enough, and merging every pull request.
- **The project page and submission.**

## Where AI was not used

No private keys, recovery phrases or funds were ever shared with the AI. The keys live in `.env.diana` on the developer's own computer, which git ignores, and every live testnet transaction was signed there.
