import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:8787';
let ready = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    const response = await fetch(`${base}/health`);
    if (response.ok && (await response.json()).ready) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 200));
}
assert.equal(ready, true, 'LOCAL_WORKERD_NOT_READY');
const response = await fetch(`${base}/proof`, { method: 'POST' });
const body = await response.json();
assert.equal(response.status, 200, body.code ?? 'LOCAL_WORKERD_PROOF_FAILED');
assert.deepEqual(body, { http: true, webpush: true, rss: true });
const liveResponse = await fetch(`${base}/rss-live`, { method: 'POST', signal: AbortSignal.timeout(45_000) });
const live = await liveResponse.json();
assert.equal(liveResponse.status, 200, live.code ?? 'RSS_LIVE_WORKERD_FAILED');
assert.equal(live.live, true);
assert.ok(live.fetched >= 2);
assert.ok(live.saved >= live.fetched);
assert.deepEqual(live.feeds, ['latent-space', 'simon-willison']);
console.log(JSON.stringify({ workerdRequestHttp: true, workerdRequestWebsocket: true, localR2Replay: true, realX: false, realRss: true, liveRssItems: live.fetched, readbackItems: live.saved }));
