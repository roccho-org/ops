import { collectHttp } from '../src/http.mjs';
import { collectWebpush, openMozilla } from '../src/webpush.mjs';
import { collectRss } from '../src/rss.mjs';
import worker from '../src/worker.mjs';

// Local workerd fixture only: no external network, credentials or Cloudflare deployment.
const uaid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const channel_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ ready: true });
    // Integration fixture: actual public HTTPS -> real workerd fetch -> local R2 -> readback.
    if (path === '/rss-live' && request.method === 'POST') {
      try {
        const rss = await collectRss(env, { proof: true });
        const proofEnv = { ...env, PROOF_TOKEN: 'local-workerd-test-only' };
        const unauthorized = await worker.fetch(new Request('https://example.local/rss'), proofEnv);
        const response = await worker.fetch(new Request('https://example.local/rss', { headers: { authorization: 'Bearer local-workerd-test-only' } }), proofEnv);
        if (unauthorized.status !== 401 || response.status !== 200) throw new Error('RSS_AUTH_READ_FAILED');
        const read = await response.json();
        const ids = [...new Set(read.items.map(item => item.feed))].sort();
        return Response.json({ live: rss.status === 'OK' && rss.verified && rss.replayVerified, fetched: rss.entries, saved: read.total, feeds: ids });
      } catch (error) { return Response.json({ code: error?.code ?? 'RSS_LIVE_FAILED' }, { status: 500 }); }
    }
    try {
      const http = await collectHttp(env, { proof: true, fetcher: async (url, options) => {
        // This is workerd's actual constructor, which rejects redirect:'error'.
        const upstream = new Request(url, options);
        if (upstream.url !== 'https://api.fxtwitter.com/status/20') throw new Error();
        // FxTwitter's documented API policy: identify the application or receive 401.
        if (!upstream.headers.get('user-agent')?.startsWith('event-reservoir-poc/')) return Response.json({}, { status: 401 });
        return Response.json({ code: 200, tweet: { id: '20', text: 'local workerd fixture' } });
      } });
      const webpush = await collectWebpush({ ...env, WEBPUSH_SUBSCRIPTION: JSON.stringify({ uaid, channel_id, keys: {} }) }, {
        windowMs: 100,
        opener: () => openMozilla(async (url, options) => {
          const upstream = new Request(url, options);
          if (upstream.url !== 'https://push.services.mozilla.com/' || upstream.headers.get('upgrade') !== 'websocket') throw new Error();
          const pair = new WebSocketPair();
          pair[1].accept();
          pair[1].addEventListener('message', event => {
            const hello = JSON.parse(event.data);
            if (hello.messageType === 'hello' && hello.uaid === uaid) pair[1].send(JSON.stringify({ messageType: 'hello', status: 200, uaid, use_webpush: true }));
          });
          return new Response(null, { status: 101, webSocket: pair[0] });
        }),
      });
      const rss = await collectRss(env, { proof: true, fetcher: async (url, options) => {
        const upstream = new Request(url, options);
        const isRss = upstream.url === 'https://www.latent.space/feed';
        if (!isRss && upstream.url !== 'https://simonwillison.net/atom/entries/') throw new Error();
        const body = isRss
          ? '<rss version="2.0"><channel><item><title>Fixture RSS</title><link>https://www.latent.space/p/fixture</link><guid>fixture-a</guid></item></channel></rss>'
          : '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Fixture Atom</title><id>fixture-b</id><link href="https://simonwillison.net/2026/Oct/18/fixture/"/></entry></feed>';
        return new Response(body, { headers: { 'content-type': isRss ? 'application/rss+xml' : 'application/atom+xml' } });
      } });
      const read = await readRss(env.RESERVOIR);
      return Response.json({ http: http.status === 'OK' && http.replay.oneObject && http.replay.unchanged, webpush: webpush.connected && webpush.status === 'NO_NOTIFICATION', rss: rss.status === 'OK' && rss.created <= 2 && rss.replayVerified && read.total === 2 });
    } catch (error) { return Response.json({ code: error?.code ?? 'WORKERD_FIXTURE_FAILED' }, { status: 500 }); }
  },
};
