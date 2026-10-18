import { collectHttp } from './http.mjs';
import { collectWebpush } from './webpush.mjs';
import { collectRss, readRss } from './rss.mjs';
import { PocError } from './store.mjs';

const safeCode = error => error instanceof PocError ? error.code : 'INTERNAL_FAILURE';
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }

export async function collect(env, { proof = false, trigger = 'manual', scheduledTime = null } = {}, adapters = { http: collectHttp, webpush: collectWebpush, rss: collectRss }) {
  const selected = trigger === 'scheduled' && new Date(scheduledTime).getUTCMinutes() !== 0
    ? Object.entries(adapters).filter(([name]) => name !== 'rss') : Object.entries(adapters);
  const result = await Promise.all(selected.map(async ([name, run]) => {
    try { return [name, await run(env, { proof })]; }
    catch (error) {
      return [name, { status: 'ERROR', code: safeCode(error), ...(error instanceof PocError && error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}) }];
    }
  }));
  const inputs = Object.fromEntries(result);
  const receipt = { schema: 'event-reservoir.run/1', version: env.APP_VERSION, trigger, scheduledTime, finishedAt: new Date().toISOString(), inputs };
  receipt.complete = inputs.http?.status === 'OK' && inputs.webpush?.status === 'OK';
  if (inputs.rss) receipt.rssComplete = inputs.rss.status === 'OK' && inputs.rss.verified === true;
  // Receipts contain counts, public post IDs and error codes, never payloads or subscriptions.
  const key = `runs/${scheduledTime ?? Date.now()}-${crypto.randomUUID()}.json`;
  try { await env.RESERVOIR.put(key, JSON.stringify(receipt)); }
  catch { throw new PocError('RUN_RECEIPT_WRITE_FAILED'); }
  return receipt;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ schema: 'event-reservoir.health/1', version: env.APP_VERSION });
    if (!env.PROOF_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PROOF_TOKEN}`) return json({ code: 'UNAUTHORIZED' }, 401);
    try {
      if (url.pathname === '/proof' && request.method === 'POST') return json(await collect(env, { proof: true }));
      if (url.pathname === '/collect' && request.method === 'POST') return json(await collect(env));
      if (url.pathname === '/rss' && request.method === 'GET') return json(await readRss(env.RESERVOIR));
      if (url.pathname === '/evidence' && request.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? Date.now() - 60 * 60_000);
        if (!Number.isSafeInteger(since) || since < 1_000_000_000_000 || since > Date.now() + 60_000) return json({ code: 'INVALID_SINCE' }, 400);
        const listed = await env.RESERVOIR.list({ prefix: 'runs/', startAfter: `runs/${since}-`, limit: 1000 });
        if (listed.truncated) throw new PocError('RECEIPT_LIMIT');
        const runs = await Promise.all(listed.objects.slice(-20).map(async item => {
          const object = await env.RESERVOIR.get(item.key);
          if (!object) throw new PocError('RECEIPT_MISSING');
          return object.json();
        }));
        return json({ schema: 'event-reservoir.evidence/1', version: env.APP_VERSION, runs });
      }
      return json({ code: 'NOT_FOUND' }, 404);
    } catch (error) { return json({ code: safeCode(error) }, 500); }
  },
  async scheduled(controller, env) {
    const receipt = await collect(env, { proof: true, trigger: 'scheduled', scheduledTime: controller.scheduledTime });
    if (Object.values(receipt.inputs).some(result => result.status === 'ERROR')) throw new PocError('COLLECTION_INCOMPLETE');
  },
};
