#!/usr/bin/env node
import process from 'node:process';
import {
  buildPhase2Bundle,
  verifyPhase2Bundle,
} from '../src/phase2.mjs';
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

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'verify-phase1' || command === 'verify-phase2') {
    if (args.length !== 1) {
      usage();
      process.exit(2);
    }
    const result = command === 'verify-phase1'
      ? verifyPhase1Bundle(args[0])
      : verifyPhase2Bundle(args[0]);
    process.stdout.write(`${stableJson(result)}\n`);
  } else if (command === 'build-phase2') {
    const values = flags(args);
    const allowed = new Set(['--ops-source', '--ops-candidate-sha', '--out', '--repository']);
    for (const key of Object.keys(values)) {
      if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
    }
    for (const required of ['--ops-source', '--ops-candidate-sha', '--out']) {
      if (!values[required]) throw new Error(`missing argument: ${required}`);
    }
    const result = buildPhase2Bundle({
      opsSource: values['--ops-source'],
      opsCandidateSha: values['--ops-candidate-sha'],
      outDir: values['--out'],
      repository: values['--repository'] ?? 'roccho-org/ops',
    });
    process.stdout.write(`${stableJson(result)}\n`);
  } else {
    usage();
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
