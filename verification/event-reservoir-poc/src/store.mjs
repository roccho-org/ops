export class PocError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function hash(value) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function observationKey(event) {
  if (!['http', 'webpush'].includes(event.source) || typeof event.sourceId !== 'string' || !event.sourceId) throw new PocError('INVALID_OBSERVATION');
  return `observations/${event.source}/${await hash(event.sourceId)}.json`;
}

// First observation wins. Re-fetching changing metrics must never rewrite it.
export async function saveObservation(bucket, event) {
  const key = await observationKey(event);
  const bytes = canonical(event);
  const written = await bucket.put(key, bytes, {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
    httpMetadata: { contentType: 'application/json' },
  });
  const stored = await bucket.get(key);
  if (!stored) throw new PocError('SAVE_NOT_READABLE');
  const text = await stored.text();
  const old = JSON.parse(text);
  if (old.source !== event.source || old.sourceId !== event.sourceId || (written && text !== bytes)) throw new PocError('SAVE_MISMATCH');
  return { created: Boolean(written), verified: true, version: stored.version, key };
}

export async function proveReplay(bucket, event) {
  const parallel = await Promise.all([saveObservation(bucket, event), saveObservation(bucket, event)]);
  const repeat = await saveObservation(bucket, event);
  const listed = await bucket.list({ prefix: repeat.key });
  const oneObject = listed.objects.filter(x => x.key === repeat.key).length === 1;
  const unchanged = parallel.every(x => x.version === repeat.version);
  if (!oneObject || !unchanged || repeat.created) throw new PocError('REPLAY_FAILED');
  return { created: parallel.filter(x => x.created).length, duplicate: parallel.filter(x => !x.created).length + 1, oneObject, unchanged, verified: true };
}

// R2 CAS prevents Cron and a manual receive from opening the same UAID together.
export async function withPushLease(bucket, action, now = Date.now()) {
  const key = 'state/webpush-lease.json';
  const previous = await bucket.get(key);
  if (previous && (await previous.json()).until > now) throw new PocError('WEBPUSH_BUSY');
  const lease = await bucket.put(key, JSON.stringify({ until: now + 120_000 }), {
    onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ 'If-None-Match': '*' }),
  });
  if (!lease) throw new PocError('WEBPUSH_BUSY');
  try { return await action(); }
  finally { await bucket.put(key, JSON.stringify({ until: 0 }), { onlyIf: { etagMatches: lease.etag } }); }
}
