import { mkdir, readFile, writeFile } from 'node:fs/promises';
import solc from 'solc';

const source = 'Treaty.sol';
const input = {
  language: 'Solidity',
  sources: { [source]: { content: await readFile(new URL('../contracts/' + source, import.meta.url), 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
for (const diagnostic of output.errors ?? []) console.error(diagnostic.formattedMessage);
if (output.errors?.some(({ severity }) => severity === 'error')) process.exit(1);
const { abi, evm } = output.contracts[source].Treaty;
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/Treaty.json', import.meta.url), JSON.stringify({
  abi, bytecode: '0x' + evm.bytecode.object, runtime: '0x' + evm.deployedBytecode.object,
}, null, 2));
