#!/usr/bin/env node
// Runs every *.test.mjs beside this file with the current node. Zero test files is a failure, not a pass.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f));
if (files.length === 0) {
  console.error('semlint-g1: no *.test.mjs found');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
