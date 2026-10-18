import { PocError, proveReplay, saveObservation } from './store.mjs';

export async function collectHttp(env, { fetcher = fetch, proof = false } = {}) {
  const id = env.HTTP_POST_ID;
  if (!/^\d{1,25}$/.test(id ?? '')) throw new PocError('HTTP_POST_ID_REQUIRED');
  let response;
  try {
    response = await fetcher(`https://api.fxtwitter.com/status/${id}`, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'manual',
    });
  } catch { throw new PocError('HTTP_UPSTREAM_UNREACHABLE'); }
  if (!response.ok) throw new PocError('HTTP_UPSTREAM_STATUS');
  const bytes = await response.text();
  if (bytes.length > 512_000) throw new PocError('HTTP_UPSTREAM_TOO_LARGE');
  let body;
  try { body = JSON.parse(bytes); } catch { throw new PocError('HTTP_UPSTREAM_INVALID'); }
  if (body.code !== 200 || String(body.tweet?.id) !== id || typeof body.tweet?.text !== 'string' || !body.tweet.text.length) throw new PocError('HTTP_POST_NOT_RETURNED');
  const event = { schema: 'event-reservoir.observation/1', source: 'http', sourceId: `fxtwitter:${id}`, postId: id, observedAt: new Date().toISOString(), payload: body };
  const result = proof ? await proveReplay(env.RESERVOIR, event) : await saveObservation(env.RESERVOIR, event);
  return { status: 'OK', postId: id, created: Number(result.created), verified: result.verified, ...(proof ? { replay: result } : {}) };
}
