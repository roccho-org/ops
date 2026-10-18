import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, unlink, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrap, github, preflight, registerMozilla, SECRET } from '../scripts/setup-webpush.mjs';
import { decode } from '../src/ece.mjs';

const cookies = { auth_token: 'dummy-account-cookie', ct0: 'dummy-csrf-cookie' };
class Mozilla extends EventTarget {
  sent = []; closed = false;
  constructor(answer = value => value) { super(); this.answer = answer; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(text) {
    const value = JSON.parse(text); this.sent.push(value);
    const reply = value.messageType === 'hello'
      ? { messageType: 'hello', status: 200, uaid: '0123456789abcdef0123456789abcdef' }
      : { messageType: 'register', status: 200, channelID: value.channelID, pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/dummy' };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(this.answer(reply)) })));
  }
  close() { this.closed = true; }
}
async function context(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reservoir-setup-test-'));
  assert.equal(dirname(dir), resolve(tmpdir()));
  t.after(async () => {
    const absent = error => { if (error.code !== 'ENOENT') throw error; };
    for (const path of ['handoff.jsonl', 'bridge.mjs', 'private/dummy', 'full/marker']) await unlink(join(dir, path)).catch(absent);
    for (const path of ['private', 'full', 'weak']) await rmdir(join(dir, path)).catch(absent);
    await rmdir(dir);
  });
  return { dir, handoff: join(dir, 'handoff.jsonl') };
}
const journal = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
function ghMock(change = () => {}) {
  const calls = []; let configured = false;
  const gh = (args, input) => {
    calls.push({ args, input }); change(args, input, calls);
    assert.equal(args[args.indexOf('--repo') + 1], 'github.com/roccho-org/ops');
    assert.equal(args[args.indexOf('--env') + 1], 'cloudflare-production');
    if (args[1] === 'list') {
      assert.deepEqual(args.slice(-2), ['--json', 'name']);
      return JSON.stringify(configured ? [{ name: SECRET }] : []);
    }
    assert.deepEqual(args.slice(0, 3), ['secret', 'set', SECRET]);
    configured = true; return '';
  };
  return { gh, calls };
}
const mozilla = () => registerMozilla(() => new Mozilla());

test('Mozilla bootstrap uses production protocol and creates interoperable receiver key sizes', async () => {
  let socket;
  const sub = await registerMozilla(url => { assert.equal(url, 'wss://push.services.mozilla.com/'); return socket = new Mozilla(); });
  assert.deepEqual(socket.sent[0], { messageType: 'hello', use_webpush: true, broadcasts: {} });
  assert.equal(socket.sent[1].channelID, sub.channel_id);
  assert.equal(decode(socket.sent[1].key).length, 65);
  assert.equal(decode(sub.keys.public_key).length, 65);
  assert.equal(decode(sub.keys.private_key).length, 32);
  assert.equal(decode(sub.keys.auth_secret).length, 16);
  const raw = decode(sub.keys.public_key);
  const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: Buffer.from(raw.slice(1, 33)).toString('base64url'), y: Buffer.from(raw.slice(33)).toString('base64url'), d: sub.keys.private_key, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  assert.equal(privateKey.type, 'private');
  assert.equal(socket.closed, true);
});

test('Mozilla rejects wrong channel and non-production or credential-bearing endpoints', async () => {
  for (const change of [
    value => ({ ...value, status: 401 }),
    value => value.messageType === 'register' ? { ...value, channelID: 'wrong' } : value,
    ...['https://other.invalid/push', 'https://user@updates.push.services.mozilla.com/push', 'http://updates.push.services.mozilla.com/push'].map(pushEndpoint => value => value.messageType === 'register' ? { ...value, pushEndpoint } : value),
  ]) {
    let socket;
    await assert.rejects(registerMozilla(() => socket = new Mozilla(change)), error => /^MOZILLA_/.test(error.code));
    assert.equal(socket.closed, true);
  }
});

test('setup journals receiver and device before X; writes receiver only by GitHub stdin and reads metadata back', async t => {
  const { handoff } = await context(t), { gh, calls } = ghMock();
  let requests = 0;
  const result = await bootstrap(cookies, { handoff, gh, mozilla, fetcher: async (url, options) => {
    requests++;
    assert.equal(url, 'https://x.com/i/api/1.1/notifications/settings/login.json');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-csrf-token'], cookies.ct0);
    assert.equal(options.headers.cookie, `auth_token=${cookies.auth_token}; ct0=${cookies.ct0}`);
    const rows = await journal(handoff), device = JSON.parse(options.body).push_device_info;
    assert.equal(rows.at(-1).stage, 'X_REGISTER_STARTED');
    assert.equal(rows.at(-1).udid, device.udid);
    assert.match(device.udid, /^event-reservoir-[0-9a-f-]{36}$/);
    assert.equal(device.token, rows[1].subscription.endpoint);
    assert.equal(device.encryption_key1, rows[1].subscription.keys.public_key);
    assert.equal(device.os_version, 'Mac/Firefox');
    return Response.json({});
  } });
  assert.equal(requests, 1);
  assert.equal(result.status, 'X_REQUEST_ACCEPTED_AND_SECRET_CONFIGURED');
  assert.equal(result.actualNotificationVerified, false);
  assert.deepEqual(calls.map(call => call.args[1]), ['list', 'list', 'set', 'list']);
  const secret = JSON.parse(calls[2].input);
  assert.deepEqual(Object.keys(secret), ['uaid', 'channel_id', 'keys']);
  assert.equal((await journal(handoff)).at(-1).stage, 'GITHUB_SECRET_CONFIRMED');
  const text = await readFile(handoff, 'utf8');
  for (const cookie of Object.values(cookies)) { assert.equal(text.includes(cookie), false); assert.equal(calls[2].input.includes(cookie), false); }
  if (process.platform !== 'win32') assert.equal((await stat(handoff)).mode & 0o777, 0o600);
});

test('preflight refuses existing file, late-listed secret, malformed metadata and Git directories before registration', async t => {
  const { dir, handoff } = await context(t);
  await writeFile(handoff, 'original');
  await assert.rejects(preflight(handoff, () => { throw Error('must not call'); }), { code: 'HANDOFF_EXISTS_STOP' });
  assert.equal(await readFile(handoff, 'utf8'), 'original');
  const other = join(dir, 'other');
  const many = Array.from({ length: 130 }, (_, i) => ({ name: `OTHER_${i}` }));
  await assert.rejects(preflight(other, () => JSON.stringify([...many, { name: SECRET }])), { code: 'EXISTING_SECRET_STOP' });
  for (const body of ['[null]', '[{}]', '{}', 'not-json']) await assert.rejects(preflight(other, () => body), { code: 'GITHUB_METADATA_INVALID' });
  await preflight(join(dir, 'not-yet-created', 'handoff'), () => '[]');
  const sourcePath = fileURLToPath(new URL('../handoff-must-not-be-written', import.meta.url));
  await assert.rejects(preflight(sourcePath, () => '[]'), { code: 'HANDOFF_MUST_BE_OUTSIDE_GIT' });
});

test('unknown or rejected X results retain receiver and device without GitHub write or resend', async t => {
  const cases = [
    [() => { throw Error(cookies.auth_token); }, 'X_REGISTRATION_UNKNOWN'],
    [() => new Response('private body', { status: 403 }), 'X_REGISTRATION_REJECTED'],
    [() => new Response('private body'), 'X_REGISTRATION_UNKNOWN'],
    [() => Response.json({ errors: [{ code: 32, message: cookies.ct0 }] }), 'X_REGISTRATION_NOT_ACCEPTED'],
    [() => Response.json({ success: false }), 'X_REGISTRATION_NOT_ACCEPTED'],
  ];
  for (const [answer, code] of cases) {
    const { handoff } = await context(t), { gh, calls } = ghMock(); let requests = 0;
    await assert.rejects(bootstrap(cookies, { handoff, gh, mozilla, fetcher: async () => { requests++; return answer(); } }), { code });
    assert.equal(requests, 1); assert.equal(calls.length, 1);
    const rows = await journal(handoff);
    assert.ok(rows.find(row => row.subscription?.keys.private_key));
    assert.ok(rows.find(row => row.stage === 'X_REGISTER_STARTED').udid);
    assert.equal(rows.at(-1).code, code);
    for (const cookie of Object.values(cookies)) assert.equal((await readFile(handoff, 'utf8')).includes(cookie), false);
    await assert.rejects(bootstrap(cookies, { handoff, gh, mozilla, fetcher: () => { throw Error('must not resend'); } }), { code: 'HANDOFF_EXISTS_STOP' });
  }
});

test('late metadata and unknown GitHub write preserve X acceptance, never overwrite or retry', async t => {
  for (const condition of ['secret-appeared', 'invalid-metadata', 'write-unknown', 'readback-missing']) {
    const { handoff } = await context(t); let lists = 0, writes = 0;
    const gh = args => {
      if (args[1] === 'set') { writes++; if (condition === 'write-unknown') throw Error(cookies.auth_token); return ''; }
      lists++;
      if (lists === 1) return '[]';
      if (condition === 'secret-appeared') return JSON.stringify([{ name: SECRET }]);
      if (condition === 'invalid-metadata') return '[{}]';
      return '[]';
    };
    await assert.rejects(bootstrap(cookies, { handoff, gh, mozilla, fetcher: async () => Response.json({}) }));
    assert.equal(writes, ['secret-appeared', 'invalid-metadata'].includes(condition) ? 0 : 1);
    const rows = await journal(handoff);
    assert.ok(rows.some(row => row.stage === 'X_REQUEST_ACCEPTED'));
    assert.ok(rows[1].subscription.keys.private_key);
    assert.equal(rows.at(-1).phase, 'github-secret');
    assert.equal((await readFile(handoff, 'utf8')).includes(cookies.auth_token), false);
  }
});

test('native child boundaries keep secrets out of argv, errors and invalid-input output', () => {
  const child = github(process.execPath);
  assert.equal(child(['-e', 'process.stdin.on("data",v=>process.stdout.write(v))'], 'dummy-stdin'), 'dummy-stdin');
  assert.throws(() => child(['-e', 'console.error("dummy-private-error");process.exit(1)'], 'dummy-stdin'), error => error.code === 'GITHUB_SECRET_WRITE_UNKNOWN' && !error.message.includes('private'));
  const source = fileURLToPath(new URL('../scripts/setup-webpush.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [source, '--handoff', join(tmpdir(), 'not-created-handoff')], { input: JSON.stringify({ auth_token: cookies.auth_token }), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).code, 'COOKIE_INPUT_INVALID');
  assert.equal(result.stderr.includes(cookies.auth_token), false);
});

test('PowerShell input bridge sends cookies only through stdin to its child', { skip: process.platform !== 'win32' }, async t => {
  const { dir, handoff } = await context(t), bridge = join(dir, 'bridge.mjs');
  await writeFile(bridge, `
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const value = JSON.parse(input);
    const stdinOnly = value.auth_token === 'dummy-account-cookie' && value.ct0 === 'dummy-csrf-cookie'
      && !JSON.stringify(process.argv).includes(value.auth_token) && !JSON.stringify(process.env).includes(value.auth_token);
    console.log(JSON.stringify({ status: 'X_REQUEST_ACCEPTED_AND_SECRET_CONFIGURED', stdinOnly }));
  `);
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const source = fileURLToPath(new URL('../scripts/setup-webpush.ps1', import.meta.url));
  const command = `. ${quote(source)}; $value = Invoke-SetupNode ${quote(process.execPath)} ${quote(bridge)} unused-gh ${quote(handoff)} ${quote(JSON.stringify(cookies))}; if (!$value.stdinOnly) { exit 2 }; Write-Output STDIN_ONLY_OK`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'STDIN_ONLY_OK');
});

test('Windows entrypoint protects new or empty private directory and refuses nonempty or weak-ACL reuse', {
  // A restricted AppContainer cannot regain access after dropping its package
  // SID. The supported entrypoint runs in the user's ordinary terminal.
  skip: process.platform !== 'win32' || /[\\/]Packages[\\/]sandbox\./i.test(tmpdir()),
}, async t => {
  const { dir } = await context(t), privateDir = join(dir, 'private');
  const script = fileURLToPath(new URL('../scripts/setup-webpush.ps1', import.meta.url));
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const command = `
    . ${quote(script)}
    New-PrivateSetupDirectory ${quote(privateDir)}
    New-PrivateSetupDirectory ${quote(privateDir)}
    $dummy = Join-Path ${quote(privateDir)} dummy
    Set-Content -LiteralPath $dummy -Value dummy
    if ((Get-Content -LiteralPath $dummy -Raw).Trim() -ne 'dummy') { exit 6 }
    Remove-Item -LiteralPath $dummy
    $full = Join-Path ${quote(dir)} full
    New-Item -ItemType Directory -Path $full | Out-Null
    Set-Content -LiteralPath (Join-Path $full marker) -Value dummy
    try { New-PrivateSetupDirectory $full; exit 2 }
    catch { if ($_.Exception.Message -ne 'SETUP_DIRECTORY_EXISTS_STOP') { exit 3 } }
    $weak = Join-Path ${quote(dir)} weak
    New-Item -ItemType Directory -Path $weak | Out-Null
    try { New-PrivateSetupDirectory $weak; exit 4 }
    catch { if ($_.Exception.Message -ne 'PRIVATE_DIRECTORY_ACL_FAILED') { exit 5 } }
    Write-Output ACL_OK
  `;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, `PowerShell ACL self-check must succeed without input or network: ${result.stderr}`);
  assert.equal(result.stdout.trim(), 'ACL_OK');
});
