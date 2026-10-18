import { spawnSync } from 'node:child_process';
import { open, access } from 'node:fs/promises';
import { dirname, basename, relative, isAbsolute, sep, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { encode } from '../src/ece.mjs';

const REPO = 'github.com/roccho-org/ops', ENVIRONMENT = 'cloudflare-production';
export const SECRET = 'EVENT_RESERVOIR_WEBPUSH_SUBSCRIPTION';
const WS_URL = 'wss://push.services.mozilla.com/';
// Public X application constants from Angelic-Angel@169a098, not account credentials.
const VAPID = encode(new Uint8Array([4,94,104,18,141,49,13,74,96,202,82,131,78,91,29,242,150,102,197,0,53,149,230,8,54,38,62,173,43,28,89,130,191,222,213,128,147,62,21,49,187,95,212,194,196,253,140,157,234,34,8,234,143,158,221,15,83,8,222,111,100,204,213,48,75]));
const X_APP = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
class SetupError extends Error {
  constructor(code, httpStatus) { super(code); this.code = code; if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus; }
}
const fail = (ok, code) => { if (!ok) throw new SetupError(code); };
export function github(gh = 'gh') {
  return (args, input) => {
    const result = spawnSync(gh, args, { input, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 256_000 });
    // Neither child stderr nor arbitrary provider text is safe to print.
    if (result.status !== 0) throw new SetupError(input === undefined ? 'GITHUB_METADATA_FAILED' : 'GITHUB_SECRET_WRITE_UNKNOWN');
    return result.stdout;
  };
}
async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw new SetupError('HANDOFF_CHECK_FAILED'); }
}
function secretNames(gh) {
  // gh's standard list handles pagination. Never use one REST page as absence proof.
  const text = gh(['secret', 'list', '--repo', REPO, '--env', ENVIRONMENT, '--json', 'name']);
  let names;
  try { names = JSON.parse(text); } catch { throw new SetupError('GITHUB_METADATA_INVALID'); }
  fail(Array.isArray(names) && names.every(item => item && typeof item.name === 'string'), 'GITHUB_METADATA_INVALID');
  return names.map(item => item.name);
}
export async function preflight(handoff, gh) {
  fail(typeof handoff === 'string' && resolve(handoff) === handoff, 'ABSOLUTE_HANDOFF_PATH_REQUIRED');
  fail(!await exists(handoff), 'HANDOFF_EXISTS_STOP');
  // The supported entrypoint fixes the path in private LOCALAPPDATA, outside
  // this checkout/bare repository. A home dotfiles repo may ignore AppData.
  const checkout = fileURLToPath(new URL('../../../', import.meta.url));
  const forbidden = [checkout];
  if (basename(dirname(checkout)) === '.worktrees') forbidden.push(dirname(dirname(checkout)));
  for (const root of forbidden) {
    const child = relative(root, handoff);
    fail(child === '..' || child.startsWith('..' + sep) || isAbsolute(child), 'HANDOFF_MUST_BE_OUTSIDE_GIT');
  }
  fail(!secretNames(gh).includes(SECRET), 'EXISTING_SECRET_STOP');
}
function receive(socket, send) {
  return new Promise((resolveMessage, reject) => {
    const end = (error, value) => {
      clearTimeout(timer);
      for (const [event, handler] of listeners) socket.removeEventListener(event, handler);
      error ? reject(error) : resolveMessage(value);
    };
    const listeners = [
      ['message', event => { try { end(null, JSON.parse(event.data)); } catch { end(new SetupError('MOZILLA_PROTOCOL_INVALID')); } }],
      ['error', () => end(new SetupError('MOZILLA_RESULT_UNKNOWN'))],
      ['close', () => end(new SetupError('MOZILLA_RESULT_UNKNOWN'))],
    ];
    const timer = setTimeout(() => end(new SetupError('MOZILLA_RESULT_UNKNOWN')), 10_000);
    for (const [event, handler] of listeners) socket.addEventListener(event, handler);
    try { send(); } catch { end(new SetupError('MOZILLA_RESULT_UNKNOWN')); }
  });
}
export async function registerMozilla(socketFactory = url => new WebSocket(url)) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const keys = { public_key: encode(publicKey), private_key: privateKey.d, auth_secret: encode(crypto.getRandomValues(new Uint8Array(16))) };
  const socket = socketFactory(WS_URL);
  try {
    await new Promise((ok, reject) => {
      const timer = setTimeout(() => reject(new SetupError('MOZILLA_CONNECT_FAILED')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); ok(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new SetupError('MOZILLA_CONNECT_FAILED')); }, { once: true });
    });
    const hello = await receive(socket, () => socket.send(JSON.stringify({ messageType: 'hello', use_webpush: true, broadcasts: {} })));
    fail(hello.messageType === 'hello' && hello.status === 200 && /^[a-f0-9-]{32,36}$/i.test(hello.uaid ?? ''), 'MOZILLA_HELLO_FAILED');
    const channel_id = crypto.randomUUID();
    const registered = await receive(socket, () => socket.send(JSON.stringify({ messageType: 'register', channelID: channel_id, key: VAPID })));
    fail(registered.messageType === 'register' && registered.status === 200 && registered.channelID === channel_id, 'MOZILLA_REGISTER_FAILED');
    let endpoint;
    try { endpoint = new URL(registered.pushEndpoint); } catch { throw new SetupError('MOZILLA_ENDPOINT_INVALID'); }
    fail(endpoint.protocol === 'https:' && endpoint.hostname === 'updates.push.services.mozilla.com' && !endpoint.port && !endpoint.username && !endpoint.password && !endpoint.hash, 'MOZILLA_ENDPOINT_INVALID');
    return { uaid: hello.uaid, channel_id, keys, endpoint: registered.pushEndpoint };
  } finally { socket.close(); }
}
export async function bootstrap(cookies, { handoff, gh = github(), mozilla = registerMozilla, fetcher = fetch }) {
  fail(cookies && Object.keys(cookies).length === 2 && ['auth_token', 'ct0'].every(key => typeof cookies[key] === 'string' && /^[\x21-\x7e]{8,4096}$/.test(cookies[key]) && !/[;,\\]/.test(cookies[key])), 'COOKIE_INPUT_INVALID');
  await preflight(handoff, gh);
  const file = await open(handoff, 'wx', 0o600);
  const stage = async value => { await file.appendFile(JSON.stringify(value) + '\n'); await file.sync(); };
  let phase = 'mozilla-register';
  try {
    await stage({ schema: 'event-reservoir.setup-handoff/1', stage: 'MOZILLA_REGISTER_STARTED' });
    const subscription = await mozilla();
    await stage({ stage: 'MOZILLA_REGISTERED', subscription });
    phase = 'x-register';
    const udid = `event-reservoir-${crypto.randomUUID()}`;
    await stage({ stage: 'X_REGISTER_STARTED', udid });
    let response;
    try {
      response = await fetcher('https://x.com/i/api/1.1/notifications/settings/login.json', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: X_APP, 'x-csrf-token': cookies.ct0, 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes', 'x-twitter-client-language': 'en', 'content-type': 'application/json', 'user-agent': 'event-reservoir-poc-setup/1', cookie: `auth_token=${cookies.auth_token}; ct0=${cookies.ct0}` },
        body: JSON.stringify({ push_device_info: { os_version: 'Mac/Firefox', udid, env: 3, locale: 'en', protocol_version: 1, token: subscription.endpoint, encryption_key1: subscription.keys.public_key, encryption_key2: subscription.keys.auth_secret } }),
      });
    } catch { throw new SetupError('X_REGISTRATION_UNKNOWN'); }
    if (!response.ok) throw new SetupError('X_REGISTRATION_REJECTED', response.status);
    let body;
    try { body = await response.json(); } catch { throw new SetupError('X_REGISTRATION_UNKNOWN', response.status); }
    fail(body && typeof body === 'object' && !Array.isArray(body) && !body.error && body.success !== false && (!body.errors || Array.isArray(body.errors) && body.errors.length === 0), 'X_REGISTRATION_NOT_ACCEPTED');
    await stage({ stage: 'X_REQUEST_ACCEPTED', httpStatus: response.status });
    phase = 'github-secret';
    // Recheck absence just before the write. The API has no create-only CAS.
    const receiver = { uaid: subscription.uaid, channel_id: subscription.channel_id, keys: subscription.keys };
    fail(!secretNames(gh).includes(SECRET), 'EXISTING_SECRET_STOP');
    await stage({ stage: 'GITHUB_SECRET_WRITE_STARTED' });
    gh(['secret', 'set', SECRET, '--repo', REPO, '--env', ENVIRONMENT], JSON.stringify(receiver));
    fail(secretNames(gh).includes(SECRET), 'GITHUB_SECRET_READBACK_FAILED');
    await stage({ stage: 'GITHUB_SECRET_CONFIRMED' });
    return { status: 'X_REQUEST_ACCEPTED_AND_SECRET_CONFIGURED', actualNotificationVerified: false, handoff };
  } catch (error) {
    const safe = { stage: 'STOP', phase, code: error instanceof SetupError ? error.code : 'SETUP_FAILED', ...(error instanceof SetupError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) };
    await stage(safe);
    throw Object.assign(new SetupError(safe.code, safe.httpStatus), { phase });
  } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), handoff = args[args.indexOf('--handoff') + 1], gh = github(args.includes('--gh') ? args[args.indexOf('--gh') + 1] : 'gh');
    fail(typeof handoff === 'string' && args.includes('--handoff'), 'HANDOFF_REQUIRED');
    if (args.includes('--preflight')) { await preflight(handoff, gh); console.log(JSON.stringify({ status: 'PREFLIGHT_OK' })); }
    else {
      let text = '';
      for await (const part of process.stdin) { text += part; fail(text.length <= 12_000, 'COOKIE_INPUT_INVALID'); }
      let cookies;
      try { cookies = JSON.parse(text); } catch { throw new SetupError('COOKIE_INPUT_INVALID'); }
      text = '';
      console.log(JSON.stringify(await bootstrap(cookies, { handoff, gh })));
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'STOP', code: error instanceof SetupError ? error.code : 'SETUP_FAILED', phase: error.phase ?? 'preflight', ...(error instanceof SetupError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) }));
    process.exitCode = 1;
  }
}
