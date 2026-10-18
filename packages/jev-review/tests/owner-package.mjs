import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceMode = process.argv.length === 3 && process.argv[2] === '--source';
assert.ok(process.argv.length === 2 || sourceMode, 'fixed source mode only');
const command = sourceMode ? process.execPath : 'semlint-owner';
const entryArgs = sourceMode ? [fileURLToPath(new URL('../semlint-entry.mjs', import.meta.url))] : [];
const childEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', NO_COLOR: '1' };
let checked = 0;
for (const [extra, input, cause] of [
  [[], '{', 'INVALID_ENTRY_JSON'],
  [['--choose-program'], '', 'INVALID_ENTRY_ARGS'],
]) {
  const child = spawnSync(command, entryArgs.concat(extra), {
    input, encoding: null, env: childEnv, timeout: 10000, maxBuffer: 1048576,
    shell: false, windowsHide: true,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 1);
  assert.equal(child.stderr.length, 0);
  const output = JSON.parse(child.stdout.toString('utf8'));
  assert.deepEqual(output, { schema: 'ops.semlint.entry-error.v1', status: 'REJECTED', cause, authority: false });
  checked++;
}
console.log(JSON.stringify({ status: 'PASS', check: 'semlint-owner-package', route: sourceMode ? 'source-entry' : 'installed-package', entryInvocations: checked, validInputs: 0, realProviderCalls: 0, tokenAdmission: 'NOT_TESTED' }));
