import { PocError, proveReplay, saveObservation, withPushLease } from './store.mjs';
import { decryptNotification } from './ece.mjs';

const WINDOW_MS = 12_000;

export async function openMozilla(fetcher = fetch) {
  let response;
  try { response = await fetcher('https://push.services.mozilla.com/', { headers: { Upgrade: 'websocket', Origin: 'https://x.com' }, signal: AbortSignal.timeout(10_000), redirect: 'manual' }); }
  catch { throw new PocError('WEBPUSH_CONNECT_FAILED'); }
  const ws = response.webSocket;
  if (response.status !== 101 || !ws) throw new PocError('WEBPUSH_UPGRADE_FAILED', response.status);
  const queue = [];
  let waiting, closed;
  function deliver(value) { if (waiting) { const resolve = waiting; waiting = null; resolve(value); } else queue.push(value); }
  ws.addEventListener('message', event => {
    try { deliver(JSON.parse(event.data)); } catch { deliver(new PocError('WEBPUSH_PROTOCOL_INVALID')); }
  });
  ws.addEventListener('close', event => { closed = new PocError(event.code === 4774 ? 'WEBPUSH_BACKOFF' : 'WEBPUSH_CLOSED'); deliver(closed); });
  ws.addEventListener('error', () => { closed = new PocError('WEBPUSH_SOCKET_FAILED'); deliver(closed); });
  ws.accept();
  return {
    send: message => ws.send(JSON.stringify(message)),
    async next(timeout) {
      let value;
      if (queue.length) value = queue.shift();
      else if (closed) value = closed;
      else value = await new Promise(resolve => {
        const timer = setTimeout(() => { waiting = null; resolve(null); }, timeout);
        waiting = item => { clearTimeout(timer); resolve(item); };
      });
      if (value instanceof Error) throw value;
      return value;
    },
    close: () => { try { ws.close(1000, 'bounded collection complete'); } catch {} },
  };
}

function subscription(secret) {
  let config;
  try { config = JSON.parse(secret); } catch { throw new PocError('WEBPUSH_SETUP_REQUIRED'); }
  if (!/^[0-9a-f-]{32,36}$/i.test(config.uaid ?? '') || !/^[0-9a-f-]{32,36}$/i.test(config.channel_id ?? '') || !config.keys) throw new PocError('WEBPUSH_SETUP_REQUIRED');
  return config;
}

function postId(payload) {
  const candidates = [payload?.url, payload?.data?.url, payload?.notification?.data?.url, payload?.data?.navigation_url];
  for (const url of candidates) {
    if (typeof url !== 'string') continue;
    const match = url.match(/^https:\/\/(?:x\.com|twitter\.com)\/[^/?#]+\/status\/(\d+)(?:[/?#]|$)/);
    if (match) return match[1];
  }
  return null;
}

export async function collectWebpush(env, { opener = openMozilla, proof = false, windowMs = WINDOW_MS } = {}) {
  if (!env.WEBPUSH_SUBSCRIPTION) throw new PocError('WEBPUSH_SETUP_REQUIRED');
  const config = subscription(env.WEBPUSH_SUBSCRIPTION);
  return withPushLease(env.RESERVOIR, async () => {
    const stateKey = 'state/webpush.json';
    let state = await env.RESERVOIR.get(stateKey);
    state = state ? await state.json() : { uaid: config.uaid, channelId: config.channel_id, notBefore: 0 };
    if (state.uaid !== config.uaid || state.channelId !== config.channel_id) throw new PocError('WEBPUSH_SUBSCRIPTION_CHANGED');
    if (state.notBefore > Date.now()) throw new PocError('WEBPUSH_BACKOFF');
    await env.RESERVOIR.put(stateKey, JSON.stringify(state));
    const counts = { received: 0, created: 0, acknowledged: 0, decrypted: 0, verified: true };
    let pending, replayed = false, reconnected = false;
    async function session(deferFirst) {
      const socket = await opener();
      const deadline = Date.now() + windowMs;
      try {
        socket.send({ messageType: 'hello', uaid: config.uaid, use_webpush: true, broadcasts: {} });
        const hello = await socket.next(10_000);
        if (hello?.messageType !== 'hello' || hello.status !== 200 || hello.use_webpush !== true) throw new PocError('WEBPUSH_HELLO_FAILED');
        if (hello.uaid !== config.uaid) throw new PocError('WEBPUSH_SUBSCRIPTION_EXPIRED');
        state.lastConnectedAt = new Date().toISOString();
        await env.RESERVOIR.put(stateKey, JSON.stringify(state));
        while (Date.now() < deadline) {
          const message = await socket.next(Math.min(2_000, deadline - Date.now()));
          if (message === null) break;
          if (!message.messageType) continue; // Mozilla application-level pong.
          if (message.messageType !== 'notification' || message.channelID !== config.channel_id || typeof message.version !== 'string' || !message.version) throw new PocError('WEBPUSH_NOTIFICATION_INVALID');
          let payload = null;
          if (message.data) {
            const plain = await decryptNotification(message, config.keys);
            try { payload = JSON.parse(plain); } catch { payload = { text: plain }; }
            counts.decrypted++;
          }
          const sourceId = `${config.uaid}:${config.channel_id}:${message.version}`;
          const event = { schema: 'event-reservoir.observation/1', source: 'webpush', sourceId, postId: postId(payload), observedAt: new Date().toISOString(), payload, encrypted: { data: message.data ?? null, headers: message.headers ?? {} } };
          const stored = await saveObservation(env.RESERVOIR, event);
          counts.received++; counts.created += Number(stored.created);
          if (proof) await proveReplay(env.RESERVOIR, event);
          if (deferFirst) { pending = sourceId; return; }
          if (pending === sourceId) replayed = true;
          socket.send({ messageType: 'ack', updates: [{ channelID: config.channel_id, version: message.version, code: 100 }] });
          counts.acknowledged++;
        }
      } finally { socket.close(); }
    }
    try {
      await session(proof);
      if (proof) { await session(false); reconnected = true; }
      if (pending && !replayed) throw new PocError('WEBPUSH_REPLAY_NOT_OBSERVED');
      return { status: counts.received ? 'OK' : 'NO_NOTIFICATION', connected: true, reconnected, replayed, ...counts };
    } catch (error) {
      if (error?.code === 'WEBPUSH_BACKOFF') {
        state.notBefore = Date.now() + 30 * 60_000;
        await env.RESERVOIR.put(stateKey, JSON.stringify(state));
      }
      throw error;
    }
  });
}
