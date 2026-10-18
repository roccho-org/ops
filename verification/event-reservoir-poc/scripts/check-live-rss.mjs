import assert from 'node:assert/strict';
import { RSS_FEEDS, parseFeed } from '../src/rss.mjs';

// Real network smoke in GitHub CI: no R2, X cookies, credentials or Cloudflare deploy.
for (const feed of RSS_FEEDS) {
  const response = await fetch(feed.url, {
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml', 'user-agent': 'event-reservoir-poc/1' },
    redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.ok, true, 'LIVE_FEED_HTTP_FAILED:' + feed.id + ':' + response.status);
  assert.match(response.headers.get('content-type') || '', /(?:application\/(?:rss\+xml|atom\+xml|xml)|text\/xml)/i);
  const entries = parseFeed(await response.text(), feed);
  assert.ok(entries.length > 0, 'LIVE_FEED_EMPTY:' + feed.id);
  assert.ok(entries.every(e => e.payload.title && e.payload.url.startsWith('https://')));
  console.log(JSON.stringify({ feed: feed.id, liveHttp: response.status, parsed: entries.length, firstTitle: entries[0].payload.title.slice(0, 120), firstUrl: entries[0].payload.url }));
}
