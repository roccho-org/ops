import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectRss, parseFeed, readRss, RSS_FEEDS } from '../src/rss.mjs';
import worker, { collect } from '../src/worker.mjs';

class Bucket {
  objects = new Map();
  async put(key, text, options = {}) {
    const existing = this.objects.get(key);
    if (existing && options.onlyIf instanceof Headers && options.onlyIf.get('if-none-match') === '*') return null;
    const version = crypto.randomUUID();
    this.objects.set(key, { text, version });
    return { version };
  }
  async get(key) {
    const row = this.objects.get(key);
    return row && { version: row.version, text: async () => row.text, json: async () => JSON.parse(row.text) };
  }
  async list({ prefix, limit = 1000 }) {
    const items = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
    return { objects: items.slice(0, limit).map(key => ({ key })), truncated: items.length > limit };
  }
}

const rss = '<rss version="2.0"><channel><item><title><![CDATA[Agents &amp; Profit]]></title><link>https://www.latent.space/p/agents</link><guid>tag:substack:agents</guid><pubDate>Sun, 18 Oct 2026 01:00:00 GMT</pubDate><description><![CDATA[<p>AI &gt; tools</p>]]></description></item></channel></rss>';
const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>LLM &amp; News</title><id>tag:simon:1</id><link rel="self" href="https://simonwillison.net/atom/entries/" /><link rel="alternate" href="https://simonwillison.net/2026/Oct/18/agents/" /><updated>2026-10-18T02:00:00Z</updated><summary>Small tools</summary></entry></feed>';
const fixture = async url => new Response(url.includes('latent.space') ? rss : atom, { headers: { 'content-type': url.includes('latent.space') ? 'application/rss+xml' : 'application/atom+xml' } });

test('two independent RSS/Atom sources: one immutable item, exact readback and no duplicate on replay', async () => {
  assert.equal(parseFeed(rss, RSS_FEEDS[0])[0].payload.title, 'Agents & Profit');
  assert.equal(parseFeed(atom, RSS_FEEDS[1])[0].payload.url, 'https://simonwillison.net/2026/Oct/18/agents/');
  const env = { RESERVOIR: new Bucket(), PROOF_TOKEN: 'test-token', APP_VERSION: 'test' };
  const first = await collectRss(env, { fetcher: fixture, proof: true });
  assert.equal(first.created, 2);
  assert.equal(first.verified, true);
  assert.equal(first.replayVerified, true);
  const second = await collectRss(env, { fetcher: fixture });
  assert.equal(second.created, 0);
  assert.equal(second.duplicate, 2);
  assert.equal(env.RESERVOIR.objects.size, 2);
  const unauthorized = await worker.fetch(new Request('https://test.local/rss'), env);
  assert.equal(unauthorized.status, 401);
  const response = await worker.fetch(new Request('https://test.local/rss', { headers: { authorization: 'Bearer test-token' } }), env);
  assert.equal(response.status, 200);
  const read = await response.json();
  assert.equal(read.total, 2);
  assert.deepEqual(read.items.map(item => item.feed).sort(), ['latent-space', 'simon-willison']);
  assert.equal(read.items[0].title.length > 0, true);
});

test('bad XML, bad URL, changed source or upstream errors do not become valid observations', async () => {
  const env = { RESERVOIR: new Bucket() };
  for (const response of [
    new Response('redirect', { status: 302 }),
    new Response('<html>bad</html>', { headers: { 'content-type': 'application/xml' } }),
    new Response(rss, { headers: { 'content-type': 'text/html' } }),
  ]) {
    await assert.rejects(collectRss(env, { fetcher: async () => response }));
    assert.equal(env.RESERVOIR.objects.size, 0);
  }
  assert.throws(() => parseFeed(rss.replace('https://www.latent.space/p/agents', 'javascript:alert(1)'), RSS_FEEDS[0]), { code: 'RSS_ENTRY_INVALID' });
  await assert.rejects(collectRss(env, { feeds: [{ ...RSS_FEEDS[0], url: 'http://127.0.0.1/' }] }), { code: 'RSS_FEED_CONFIGURATION' });
});

test('Cron polls RSS hourly while retaining existing two-minute HTTP/Push cadence', async () => {
  const env = { RESERVOIR: new Bucket(), APP_VERSION: 'test' };
  let called = 0;
  const adapters = { http: async () => ({ status: 'OK' }), webpush: async () => ({ status: 'OK' }), rss: async () => { called++; return { status: 'OK', verified: true }; } };
  const off = await collect(env, { trigger: 'scheduled', scheduledTime: Date.UTC(2026, 9, 18, 12, 2) }, adapters);
  assert.equal(off.inputs.rss, undefined);
  const on = await collect(env, { trigger: 'scheduled', scheduledTime: Date.UTC(2026, 9, 18, 13, 0) }, adapters);
  assert.equal(on.inputs.rss.status, 'OK');
  assert.equal(called, 1);
});
