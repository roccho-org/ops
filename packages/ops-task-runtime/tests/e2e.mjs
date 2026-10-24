#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'ops-task-runtime.mjs');
const run = (root, expected) => {
  const result = spawnSync(process.execPath, [cli, 'selftest', '--root', root], { encoding: 'utf8' });
  if ((result.status === 0) !== expected) throw new Error(`unexpected status ${result.status}: ${result.stderr || result.stdout}`);
};

// Producer metadata is outside the suite interval. No child interval is claimed.
const timingPath = process.env.OPS_TASK_CI_TIMING;
const stat = timingPath ? fs.readFileSync('/proc/self/stat', 'utf8') : undefined;
const producer = timingPath ? {
  pid: process.pid,
  startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
  nodePath: process.execPath,
  nodeSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
  hostBootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  root: packageRoot,
} : undefined;
let suiteError;
const start = process.hrtime.bigint();
try {
  run(packageRoot, true);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-task-runtime-'));
  try {
    fs.cpSync(packageRoot, tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tasks.jsonl'), '{}\n');
    run(tmp, false);
    fs.rmSync(path.join(tmp, 'tasks.jsonl'));
    const sourcePath = path.join(tmp, 'source.json');
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    source.goTask.binarySha256 = '0'.repeat(64);
    fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
    run(tmp, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} catch (error) { suiteError = error; }
const end = process.hrtime.bigint();
if (timingPath) {
  try {
    fs.writeFileSync(timingPath, JSON.stringify({
      schema: 'ops.taskRuntimeE2ETiming/1', startNs: String(start), endNs: String(end),
      outcome: suiteError ? 'failure' : 'success', producer,
    }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Preserve an existing suite failure if evidence writing also fails.
    if (!suiteError) throw error;
  }
}
if (suiteError) throw suiteError;
process.stdout.write('{"schema":"ops.taskRuntimeE2E/1","status":"PASS","positive":1,"negative":2}\n');
