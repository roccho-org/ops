import { PocError, proveReplay, saveObservation } from './store.mjs';

// Explicit, public, immutable source selection. Requests cannot supply arbitrary URLs.
export const RSS_FEEDS = Object.freeze([
  { id: 'latent-space', kind: 'rss', url: 'https://www.latent.space/feed' },
  { id: 'simon-willison', kind: 'atom', url: 'https://simonwillison.net/atom/entries/' },
]);

function unescapeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, part) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (part[0] !== '#') return named[part.toLowerCase()] ?? whole;
    const numeric = part[1].toLowerCase() === 'x' ? parseInt(part.slice(2), 16) : parseInt(part.slice(1), 10);
    return numeric > 0 && numeric <= 0x10ffff && !(numeric >= 0xd800 && numeric <= 0xdfff) ? String.fromCodePoint(numeric) : '';
  });
}

function value(block, name) {
  const pattern = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + "\\s*>", 'i');
  const match = pattern.exec(block);
  if (!match) return '';
  const raw = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return unescapeXml(raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function atomLink(block) {
  for (const match of block.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = /\brel\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    if (rel && rel !== 'alternate') continue;
    const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    if (href) return unescapeXml(href);
  }
  return '';
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch { return null; }
}

// Bounded RSS 2.0 / Atom 1.0 article metadata, not a general XML/HTML interpreter.
export function parseFeed(xml, feed) {
  if (typeof xml !== 'string' || xml.length > 1_000_000) throw new PocError('RSS_TOO_LARGE');
  if (!['rss', 'atom'].includes(feed.kind) || !/^[a-z0-9-]{1,40}$/.test(feed.id)) throw new PocError('RSS_FEED_CONFIGURATION');
  const root = feed.kind === 'rss' ? /<rss(?:\s|>)/i : /<feed(?:\s|>)/i;
  if (!root.test(xml)) throw new PocError('RSS_INVALID_XML');
  const tag = feed.kind === 'rss' ? 'item' : 'entry';
  const entries = [...xml.matchAll(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + tag + "\\s*>", 'gi'))];
  if (!entries.length) throw new PocError('RSS_NO_ENTRIES');
  const unique = new Set();
  const events = [];
  for (const [, block] of entries.slice(0, 20)) {
    const title = value(block, 'title').slice(0, 400);
    const link = publicUrl(feed.kind === 'rss' ? value(block, 'link') : atomLink(block));
    const entryId = (value(block, feed.kind === 'rss' ? 'guid' : 'id') || link || '').slice(0, 2048);
    if (!title || !link || !entryId) throw new PocError('RSS_ENTRY_INVALID');
    const sourceId = feed.id + ":" + entryId;
    if (unique.has(sourceId)) continue;
    unique.add(sourceId);
    const date = value(block, feed.kind === 'rss' ? 'pubDate' : 'published') || value(block, 'updated');
    const parsedDate = date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
    const summary = (value(block, feed.kind === 'rss' ? 'description' : 'summary') || value(block, 'content')).slice(0, 2000);
    events.push({
      schema: 'event-reservoir.observation/1', source: 'rss', sourceId,
      observedAt: new Date().toISOString(),
      payload: { feed: feed.id, title, url: link, publishedAt: parsedDate, summary },
    });
  }
  if (!events.length) throw new PocError('RSS_NO_ENTRIES');
  return events;
}

export async function collectRss(env, { fetcher = fetch, proof = false, feeds = RSS_FEEDS } = {}) {
  let created = 0, duplicate = 0, entries = 0, replayVerified = false;
  const results = [];
  for (const feed of feeds) {
    if (!RSS_FEEDS.some(source => source.id === feed.id && source.url === feed.url && source.kind === feed.kind)) throw new PocError('RSS_FEED_CONFIGURATION');
    let response;
    try {
      response = await fetcher(feed.url, {
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml', 'user-agent': 'event-reservoir-poc/1' },
        redirect: 'manual', signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new PocError('RSS_UPSTREAM_UNREACHABLE'); }
    if (!response.ok) throw new PocError('RSS_UPSTREAM_STATUS', response.status);
    if (!/(?:application\/(?:rss\+xml|atom\+xml|xml)|text\/xml)/i.test(response.headers.get('content-type') ?? '')) throw new PocError('RSS_UNEXPECTED_MEDIA_TYPE');
    if (Number(response.headers.get('content-length') || 0) > 1_000_000) throw new PocError('RSS_TOO_LARGE');
    let xml;
    try { xml = await response.text(); } catch { throw new PocError('RSS_UPSTREAM_UNREACHABLE'); }
    const events = parseFeed(xml, feed);
    for (const [i, event] of events.entries()) {
      const result = proof && i === 0 ? await proveReplay(env.RESERVOIR, event) : await saveObservation(env.RESERVOIR, event);
      created += result.created ? Number(result.created) : 0;
      duplicate += proof && i === 0 ? result.duplicate : Number(!result.created);
      if (proof && i === 0) replayVerified = replayVerified || (result.oneObject && result.unchanged);
    }
    entries += events.length;
    results.push({ feed: feed.id, entries: events.length });
  }
  return { status: 'OK', feeds: results, entries, created, duplicate, verified: true, ...(proof ? { replayVerified } : {}) };
}

export async function readRss(bucket) {
  const listed = await bucket.list({ prefix: 'observations/rss/', limit: 1000 });
  if (listed.truncated) throw new PocError('RSS_READ_LIMIT');
  const entries = await Promise.all(listed.objects.map(async ({ key }) => {
    const object = await bucket.get(key);
    if (!object) throw new PocError('RSS_READ_MISSING');
    const row = await object.json();
    if (row.schema !== 'event-reservoir.observation/1' || row.source !== 'rss' || !row.payload?.feed || !row.payload?.title || !row.payload?.url) throw new PocError('RSS_READ_INVALID');
    return { sourceId: row.sourceId, observedAt: row.observedAt, ...row.payload };
  }));
  entries.sort((a, b) => String(b.publishedAt || b.observedAt).localeCompare(String(a.publishedAt || a.observedAt)));
  return { schema: 'event-reservoir.rssItems/1', total: entries.length, items: entries.slice(0, 20) };
}
