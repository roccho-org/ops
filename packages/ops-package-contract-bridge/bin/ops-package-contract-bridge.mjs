#!/usr/bin/env node
import process from 'node:process';
import { stableJson, verifyPhase1Bundle } from '../src/verify.mjs';

function usage() {
  process.stderr.write('usage: ops-package-contract-bridge verify-phase1 BUNDLE_DIR\n');
}

try {
  const [command, bundle, ...rest] = process.argv.slice(2);
  if (command !== 'verify-phase1' || !bundle || rest.length) {
    usage();
    process.exit(2);
  }
  process.stdout.write(`${stableJson(verifyPhase1Bundle(bundle))}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
