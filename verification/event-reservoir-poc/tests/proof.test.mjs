import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveObservation, proveReplay, PocError, withPushLease } from '../src/store.mjs';
import { collectHttp } from '../src/http.mjs';
import { decryptNotification, decode } from '../src/ece.mjs';
import { collectWebpush } from '../src/webpush.mjs';
import worker, { collect } from '../src/worker.mjs';

class Bucket {
  objects = new Map();
  history = [];
  fail = false;
  async put(key, text, options = {}) {
    await Promise.resolve();
    if (this.fail) throw new Error('private upstream body that must never be returned');
    const old = this.objects.get(key);
    const only = options.onlyIf;
    if ((only instanceof Headers && only.get('if-none-match') === '*' && old) || (only?.etagMatches && old?.etag !== only.etagMatches)) return null;
    const value = { text, version: crypto.randomUUID() };
    value.etag = value.version;
    this.objects.set(key, value); this.history.push(`put:${key}`);
    return value;
  }
  async get(key) {
    const value = this.objects.get(key);
    if (!value) return null;
    this.history.push(`get:${key}`);
    return { version: value.version, etag: value.etag, text: async () => value.text, json: async () => JSON.parse(value.text) };
  }
  async list({ prefix, startAfter = '', limit = 1000 }) {
    const keys = [...this.objects.keys()].sort().filter(key => key.startsWith(prefix) && key > startAfter);
    return { objects: keys.slice(0, limit).map(key => ({ key })), truncated: keys.length > limit };
  }
}
const event = { schema: 'event-reservoir.observation/1', source: 'http', sourceId: 'fxtwitter:20', postId: '20', observedAt: '2026-10-18T00:00:00.000Z', payload: { text: 'existing public post' } };

test('conditional creation has one winner; sequential replay and changed metrics preserve first bytes', async () => {
  const bucket = new Bucket();
  const result = await proveReplay(bucket, event);
  assert.deepEqual(result, { created: 1, duplicate: 2, oneObject: true, unchanged: true, verified: true });
  const original = [...bucket.objects.values()][0];
  await saveObservation(bucket, { ...event, payload: { metrics: 99 } });
  assert.equal([...bucket.objects.values()][0], original);
});

test('HTTP refuses upstream failure, malformed data and wrong IDs without saving', async () => {
  for (const response of [new Response('error', { status: 503 }), new Response('{}'), Response.json({ code: 200, tweet: { id: '21', text: 'other' } })]) {
    const env = { RESERVOIR: new Bucket(), HTTP_POST_ID: '20' };
    await assert.rejects(collectHttp(env, { fetcher: async () => response }), PocError);
    assert.equal(env.RESERVOIR.objects.size, 0);
  }
  const env = { RESERVOIR: new Bucket(), HTTP_POST_ID: '20' };
  assert.equal((await collectHttp(env, { proof: true, fetcher: async url => {
    assert.equal(url, 'https://api.fxtwitter.com/status/20');
    return Response.json({ code: 200, tweet: { id: '20', text: 'real-shaped fixture' } });
  } })).replay.oneObject, true);
});

// Public test data from RFC 8291 section 5 / Appendix A; these are NOT credentials.
const rfc = {
  keys: { private_key: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', public_key: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth_secret: 'BTBZMqHH6r4Tts7J_aSIgg' },
  data: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
test('WebCrypto decrypts independent RFC 8291 interoperability vector and rejects tampering', async () => {
  assert.equal(await decryptNotification(rfc, rfc.keys), 'When I grow up, I want to be a watermelon');
  const fullRecord = decode(rfc.data);
  new DataView(fullRecord.buffer).setUint32(16, fullRecord.length - 86);
  assert.equal(await decryptNotification({ ...rfc, data: [...fullRecord] }, rfc.keys), 'When I grow up, I want to be a watermelon');
  new DataView(fullRecord.buffer).setUint32(16, 17);
  await assert.rejects(decryptNotification({ ...rfc, data: [...fullRecord] }, rfc.keys), /WEBPUSH_DECRYPT_FAILED/);
  const damaged = decode(rfc.data); damaged[100] ^= 1;
  await assert.rejects(decryptNotification({ ...rfc, data: [...damaged] }, rfc.keys), /WEBPUSH_DECRYPT_FAILED/);
});

test('legacy aesgcm interoperates with Mozilla Firefox public crypto test vector', async () => {
  // https://github.com/mozilla/gecko-dev/blob/master/dom/push/test/xpcshell/test_crypto.js
  const keys = { private_key: '4h23G_KkXC9TvBSK2v0Q7ImpS2YAuRd8hQyN0rFAwBg', public_key: 'BLHfOWQmxBunRJBjApg8hgSLeOeEMvmKPtcYW2k9iZZOvr3cKpQ-Sp1kpZ9HipNjUCwSA55yy0uM8N9byE8dmLs', auth_secret: 'aTDc6JebzR6eScy2oLo4RQ' };
  const notification = { data: 'Oo34w2F9VVnTMFfKtdx48AZWQ9Li9M6DauWJVgXU', headers: { encoding: 'aesgcm', crypto_key: 'dh=BCHFVrflyxibGLlgztLwKelsRZp4gqX3tNfAKFaxAcBhpvYeN1yIUMrxaDKiLh4LNKPtj0BOXGdr-IQ-QP82Wjo', encryption: 'salt=zCU18Rw3A5aB_Xi-vfixmA; rs=24' } };
  assert.equal(await decryptNotification(notification, keys), 'Some message');
});

function pushEnvironment() {
  return { RESERVOIR: new Bucket(), WEBPUSH_SUBSCRIPTION: JSON.stringify({ uaid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', channel_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', keys: rfc.keys }) };
}
function fakeSocket(env, queue, { invalidUaid = false, failStorage = false } = {}) {
  const config = JSON.parse(env.WEBPUSH_SUBSCRIPTION);
  const sent = [];
  return {
    sent, closed: false,
    send(value) {
      sent.push(value);
      if (value.messageType === 'hello') assert.equal(value.uaid, config.uaid);
      if (value.messageType === 'ack') {
        const stored = [...env.RESERVOIR.objects.entries()].filter(([key]) => key.startsWith('observations/webpush/'));
        assert.equal(stored.length, 1, 'ACK requires durable observation');
        assert.ok(env.RESERVOIR.history.some(entry => entry.startsWith('get:observations/webpush/')), 'ACK requires readback');
      }
    },
    async next() {
      if (!this.hello) {
        this.hello = true;
        if (failStorage) env.RESERVOIR.fail = true;
        return { messageType: 'hello', status: 200, uaid: invalidUaid ? 'new-id' : config.uaid, use_webpush: true };
      }
      return queue.shift() ?? null;
    },
    close() { this.closed = true; },
  };
}
const notification = { messageType: 'notification', channelID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', version: 'test-version', data: rfc.data, headers: { encoding: 'aes128gcm' } };

test('Mozilla proof reconnects same subscription after save-before-ACK interruption; re-delivery stays one object', async () => {
  const env = pushEnvironment(), sockets = [];
  const result = await collectWebpush(env, { proof: true, opener: async () => {
    const socket = fakeSocket(env, [notification]); sockets.push(socket); return socket;
  } });
  assert.equal(result.created, 1); assert.equal(result.received, 2);
  assert.equal(result.replayed, true); assert.equal(result.reconnected, true);
  assert.equal(result.acknowledged, 1); assert.equal(result.decrypted, 2);
  assert.equal(sockets[0].sent.some(x => x.messageType === 'ack'), false);
  assert.equal(sockets.every(x => x.closed), true);
});

test('Mozilla storage/decryption failures and changed UAID never send success ACK', async () => {
  for (const mode of ['storage', 'decrypt', 'uaid']) {
    const env = pushEnvironment();
    let socket;
    await assert.rejects(collectWebpush(env, { opener: async () => {
      socket = fakeSocket(env, [mode === 'decrypt' ? { ...notification, data: 'AAAA' } : notification], { invalidUaid: mode === 'uaid', failStorage: mode === 'storage' });
      return socket;
    } }));
    assert.equal(socket.sent.some(x => x.messageType === 'ack'), false);
    assert.equal(socket.closed, true);
  }
});

test('concurrent Mozilla receive is refused; expired lease permits a later Cron attempt', async () => {
  const bucket = new Bucket();
  let release;
  const first = withPushLease(bucket, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(withPushLease(bucket, async () => {}), /WEBPUSH_BUSY/);
  release(); await first;
  assert.equal(await withPushLease(bucket, async () => 'next'), 'next');
  await bucket.put('state/webpush-lease.json', JSON.stringify({ until: 1 }));
  assert.equal(await withPushLease(bucket, async () => 'expired'), 'expired');
});

test('Mozilla backoff is durable and prevents the next Cron from reconnecting early', async () => {
  const env = pushEnvironment();
  let opened = 0;
  const opener = async () => {
    opened++;
    const socket = fakeSocket(env, []);
    const next = socket.next.bind(socket);
    socket.next = async () => { if (socket.hello) throw new PocError('WEBPUSH_BACKOFF'); return next(); };
    return socket;
  };
  await assert.rejects(collectWebpush(env, { opener }), /WEBPUSH_BACKOFF/);
  await assert.rejects(collectWebpush(env, { opener }), /WEBPUSH_BACKOFF/);
  assert.equal(opened, 1);
});

test('both adapters run independently; public proof requires its own token and errors omit secrets', async () => {
  const env = { RESERVOIR: new Bucket(), APP_VERSION: 'test', PROOF_TOKEN: 'private-proof-token' };
  assert.equal((await worker.fetch(new Request('https://example.test/proof', { method: 'POST' }), env)).status, 401);
  const receipt = await collect(env, {}, { http: async () => ({ status: 'OK' }), webpush: async () => { throw new Error('private-material'); } });
  assert.equal(receipt.inputs.http.status, 'OK');
  assert.equal(receipt.inputs.webpush.code, 'INTERNAL_FAILURE');
  assert.equal(JSON.stringify(receipt).includes('private-material'), false);
});

test('recent evidence remains readable after more than 1000 historical Cron receipts', async () => {
  const env = { RESERVOIR: new Bucket(), PROOF_TOKEN: 'private-proof-token' };
  const now = Date.now();
  for (let index = 0; index < 1001; index++) await env.RESERVOIR.put(`runs/${now - 10_000_000 + index}-old.json`, '{}');
  await env.RESERVOIR.put(`runs/${now}-new.json`, JSON.stringify({ trigger: 'scheduled' }));
  const response = await worker.fetch(new Request(`https://example.test/evidence?since=${now - 1000}`, { headers: { authorization: `Bearer ${env.PROOF_TOKEN}` } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).runs, [{ trigger: 'scheduled' }]);
});
