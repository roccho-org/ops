import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://zcode.z.ai';
const VERSION = '3.16.3'; // Request context, not a claim that the desktop app ran.
const UPSTREAM = '3c5b227649371507ddc4eb46ac5133afe6db1cab';
const SHA256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function requestSpec(surface, deviceId) {
  if (!['preview', 'balance'].includes(surface)) throw new Error('unsupported surface');
  if (!/^[0-9a-f-]{36}$/.test(deviceId)) throw new Error('invalid device identity');
  return {
    url: `${ORIGIN}/api/v1/zcode-plan/billing/${surface}?app_version=${VERSION}`,
    options: {
      method: 'GET', agent: false,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ops-zcode-anonymous-boundary-probe/1',
        'X-Device-Mid': deviceId,
      },
    },
  };
}

// No cookie jar, credential/profile reads, proxy client, redirect or retry.
// Only the public preview and the documented balance surface are contacted.
async function observe(surface, deviceId) {
  const spec = requestSpec(surface, deviceId);
  const sampledAt = new Date().toISOString();
  return new Promise((resolveObservation) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveObservation({ surface, url: spec.url, sampledAt, ...result });
    };
    const request = https.request(spec.url, spec.options, (response) => {
      const parts = [];
      let size = 0;
      response.on('data', (part) => {
        size += part.length;
        if (size > 65536) {
          finish({ transportError: 'BODY_LIMIT' });
          response.destroy();
          request.destroy();
        } else parts.push(part);
      });
      response.on('error', () => finish({ transportError: 'RESPONSE_ERROR' }));
      response.on('aborted', () => finish({ transportError: 'RESPONSE_ABORTED' }));
      response.on('end', () => {
        const bytes = Buffer.concat(parts);
        const contentType = response.headers['content-type'] ?? '';
        let envelope;
        try { envelope = JSON.parse(bytes.toString('utf8')); } catch { /* not JSON */ }
        const json = /^application\/json(?:\s*;|$)/i.test(contentType)
          && envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope);
        // Do not publish raw bodies, cookies, JWTs, user identifiers, or server messages.
        finish({
          httpStatus: response.statusCode,
          jsonEnvelope: Boolean(json),
          businessCode: json && (typeof envelope.code === 'number'
            || /^\d{1,6}$/.test(String(envelope.code))) ? envelope.code : null,
          planCount: json && Array.isArray(envelope.data?.plans) ? envelope.data.plans.length : null,
          balanceCount: json && Array.isArray(envelope.data?.balances) ? envelope.data.balances.length : null,
          bodySha256: SHA256(bytes), bodyBytes: bytes.length,
        });
      });
    });
    request.on('error', () => finish({ transportError: 'REQUEST_ERROR' }));
    timer = setTimeout(() => {
      finish({ transportError: 'TIMEOUT' });
      request.destroy();
    }, 15000);
    request.end();
  });
}

export function classify(observation) {
  if (observation.transportError) return 'UNKNOWN';
  // This reports an HTTP boundary, NOT proof that every anonymous route is impossible.
  if (observation.httpStatus === 401 && observation.jsonEnvelope === true) return 'HTTP_AUTH_REJECTION';
  // 403 may be CAPTCHA/WAF; 200 may be an advert, cached state, or a business error.
  return 'UNKNOWN';
}

export function conclude(observations) {
  const boundary = observations.map((observation) => ({
    surface: observation.surface, classification: classify(observation),
  }));
  return {
    assertion: 'The 1024 campaign was received without user authentication',
    verdict: 'UNPROVEN', received: false, exitCode: 1,
    boundary, claimAttempted: false, modelCallAttempted: false,
    reason: 'Official claim flow requires login and security verification. GETs cannot prove a grant.',
  };
}

async function main() {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3) throw new Error('one NEW evidence directory is required');
  // Never reuse yesterday\'s artifacts. Existing output is an error, not success.
  await mkdir(output, { mode: 0o700 });
  const deviceId = randomUUID();
  const context = {
    kind: 'zcode.anonymousBoundary.v1', runId: randomUUID(),
    sourceCommit: process.env.SOURCE_COMMIT ?? null,
    ciRunId: process.env.CI_RUN_ID ?? null, ciAttempt: process.env.CI_ATTEMPT ?? null,
    startedAt: new Date().toISOString(), node: process.version,
    platform: process.platform, arch: process.arch, upstreamSource: UPSTREAM,
    appVersionParameter: VERSION, appExecuted: false,
    authorizationSent: false, cookieSent: false, apiKeySent: false,
    deviceIdSha256: SHA256(deviceId), scope: 'two read-only HTTP boundary observations',
  };
  const design = (await readFile(new URL('./raws.jsonl', import.meta.url), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  const observations = [];
  // Write context before the network so an interruption is not an empty green result.
  await writeFile(resolve(output, 'raws.jsonl'),
    [...design, context].map((row) => JSON.stringify(row)).join('\n') + '\n');
  for (const surface of ['preview', 'balance']) {
    observations.push(await observe(surface, deviceId));
    await writeFile(resolve(output, 'raws.jsonl'),
      [...design, context, ...observations].map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
  const result = { ...conclude(observations), finishedAt: new Date().toISOString() };
  const cases = await readFile(new URL('./disruptives.jsonl', import.meta.url), 'utf8');
  await writeFile(resolve(output, 'disruptives.jsonl'), cases);
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Evidence collection failed; anonymous campaign receipt remains UNPROVEN.');
    process.exitCode = 2;
  });
}
