import { collectHttp } from '../src/http.mjs';
import { collectWebpush, openMozilla } from '../src/webpush.mjs';

// Local workerd fixture only: no external network, credentials or Cloudflare deployment.
const uaid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const channel_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ready: true });
    try {
      const http = await collectHttp(env, { proof: true, fetcher: async (url, options) => {
        // This is workerd's actual constructor, which rejects redirect:'error'.
        const upstream = new Request(url, options);
        if (upstream.url !== 'https://api.fxtwitter.com/status/20') throw new Error();
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
      return Response.json({ http: http.status === 'OK' && http.replay.oneObject && http.replay.unchanged, webpush: webpush.connected && webpush.status === 'NO_NOTIFICATION' });
    } catch (error) { return Response.json({ code: error?.code ?? 'WORKERD_FIXTURE_FAILED' }, { status: 500 }); }
  },
};
