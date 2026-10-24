import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classify, conclude, requestSpec } from './probe.mjs';

const cases = (await readFile(new URL('./disruptives.jsonl', import.meta.url), 'utf8'))
  .trim().split('\n').map((line) => JSON.parse(line));
for (const entry of cases) {
  test(`${entry.id}: ${entry.case}`, () => {
    assert.equal(classify(entry.observation), entry.expected);
    const result = conclude([entry.observation]);
    assert.equal(result.verdict, 'UNPROVEN');
    assert.equal(result.received, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.claimAttempted, false);
  });
}

test('missing evidence never passes', () => {
  assert.equal(conclude([]).exitCode, 1);
});
test('requests cannot select arbitrary origins, mutations, or credentials', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  for (const surface of ['preview', 'balance']) {
    const { url, options } = requestSpec(surface, id);
    assert.equal(new URL(url).origin, 'https://zcode.z.ai');
    assert.equal(options.method, 'GET');
    assert.equal(options.agent, false);
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent', 'X-Device-Mid']);
  }
  for (const surface of ['claim', 'https://example.com', '../claim']) {
    assert.throws(() => requestSpec(surface, id));
  }
  assert.throws(() => requestSpec('balance', 'invalid'));
});
test('a local fixture cannot be promoted to live campaign proof', () => {
  for (let status = 100; status < 600; status++) {
    const result = conclude([{ surface: 'balance', httpStatus: status, jsonEnvelope: true, received: true }]);
    assert.equal(result.verdict, 'UNPROVEN');
    assert.notEqual(result.exitCode, 0);
  }
});
