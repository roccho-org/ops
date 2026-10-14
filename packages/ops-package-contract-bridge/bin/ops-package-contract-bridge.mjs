#!/usr/bin/env node
import process from 'node:process';
import {
  buildPhase2Bundle,
  verifyPhase2Bundle,
} from '../src/phase2.mjs';
import {
  buildPhase2V4Bundle,
  verifyPhase2V4Bundle,
} from '../src/phase2-v4.mjs';
import {
  stableJson,
  verifyPhase1Bundle,
} from '../src/verify.mjs';

function usage() {
  process.stderr.write([
    'usage:',
    '  ops-package-contract-bridge verify-phase1 BUNDLE_DIR',
    '  ops-package-contract-bridge build-phase2 --ops-source DIR --ops-candidate-sha SHA --out DIR [--repository OWNER/REPO]',
    '  ops-package-contract-bridge verify-phase2 BUNDLE_DIR',
    '  ops-package-contract-bridge build-phase2-v4 --ops-source DIR --ops-candidate-sha SHA --local-source-universe FILE --out DIR [--repository OWNER/REPO]',
    '  ops-package-contract-bridge verify-phase2-v4 BUNDLE_DIR',
    '',
  ].join('\n'));
}

function flags(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument pair: ${key ?? ''}`);
    }
    if (Object.hasOwn(values, key)) throw new Error(`duplicate argument: ${key}`);
    values[key] = value;
  }
  return values;
}

function parseBuildFlags(args, sourceUniverse = false) {
  const values = flags(args);
  const allowed = new Set([
    '--ops-source', '--ops-candidate-sha', '--out', '--repository',
    ...(sourceUniverse ? ['--local-source-universe'] : []),
  ]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
  }
  const required = ['--ops-source', '--ops-candidate-sha', '--out', ...(sourceUniverse ? ['--local-source-universe'] : [])];
  for (const key of required) {
    if (!values[key]) throw new Error(`missing argument: ${key}`);
  }
  return values;
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (['verify-phase1', 'verify-phase2', 'verify-phase2-v4'].includes(command)) {
    if (args.length !== 1) {
      usage();
      process.exit(2);
    }
    const result = command === 'verify-phase1'
      ? verifyPhase1Bundle(args[0])
      : command === 'verify-phase2'
        ? verifyPhase2Bundle(args[0])
        : verifyPhase2V4Bundle(args[0]);
    process.stdout.write(`${stableJson(result)}\n`);
  } else if (command === 'build-phase2' || command === 'build-phase2-v4') {
    const sourceUniverse = command === 'build-phase2-v4';
    const values = parseBuildFlags(args, sourceUniverse);
    const common = {
      opsSource: values['--ops-source'],
      opsCandidateSha: values['--ops-candidate-sha'],
      outDir: values['--out'],
      repository: values['--repository'] ?? 'roccho-org/ops',
    };
    const result = sourceUniverse
      ? buildPhase2V4Bundle({
        ...common,
        localSourceUniverseFile: values['--local-source-universe'],
      })
      : buildPhase2Bundle(common);
    process.stdout.write(`${stableJson(result)}\n`);
  } else {
    usage();
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
