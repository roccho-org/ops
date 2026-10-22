import assert from 'node:assert/strict';
import test from 'node:test';
import { compareContext } from './context.mjs';
import { JEV_MODEL } from '../jev-review/core.mjs';

// Only the provider answer is controlled; real semcmp/review/rank run unchanged.
globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
const query = { input: '# コメント', state: { current: 'r1', lines: ['# コメント', 'unsaved'] }, focus: { target: 'fixture', revision: 1, cursor: [1, 1] } };
const rows = [
  { id: 'A', meaning: { kind: 'text' }, representation: '同じ表示', detail: { format: 'text', source: 'detail A' } },
  { id: 'B', meaning: { kind: 'text' }, representation: '同じ表示', detail: { format: 'mermaid', source: 'flowchart TB\nA-->B' } },
];
const jsonl = list => list.map(row => JSON.stringify(row)).join('\n');
const ask = async (state, questions) => {
  assert.deepEqual(state.query, query);
  assert.ok(state.proposals.every(row => !Object.hasOwn(row, 'detail')));
  return { model: JEV_MODEL, answers: Object.fromEntries(Object.keys(questions).map((id, i) =>
    [id, { type: 'noul', noul: state.proposals[i].id === 'B' ? 0.9 : 0.1 }])), usage: {} };
};
const run = (q = query, records = rows, provider = ask) => compareContext(JSON.stringify(q), jsonl(records), { ask: provider });

test('real core ranks while original ID, meaning and detail stay together', async () => {
  const out = await run();
  assert.deepEqual(out.proposals.map(row => row.id), ['B', 'A']);
  assert.deepEqual(out.proposals[0].detail, rows[1].detail);
  assert.deepEqual(out.proposals[0].meaning, rows[1].meaning);
  assert.equal(out.evaluation.calls, 1);
});
test('source order changes do not attach detail by index', async () => {
  const out = await run(query, [...rows].reverse());
  assert.equal(out.proposals[0].id, 'B');
  assert.deepEqual(out.proposals[0].detail, rows[1].detail);
});
test('query and current revisions change request identity', async () => {
  const a = await run();
  const changed = structuredClone(query); changed.focus.revision++;
  const provider = async (state, qs) => ({ model: JEV_MODEL, answers: Object.fromEntries(Object.keys(qs).map(id => [id, { type: 'noul', noul: 0.5 }])) });
  assert.notEqual(a.requestId, (await run(changed, rows, provider)).requestId);
  const catalog = structuredClone(rows); catalog[0].detail.source += ' changed';
  assert.notEqual(a.requestId, (await run(query, catalog)).requestId);
});
test('caller mutation after call cannot replace the captured input', async () => {
  const q = structuredClone(query), catalog = structuredClone(rows);
  const promise = run(q, catalog); q.state.lines[1] = 'changed'; catalog[1].detail.source = 'changed';
  const out = await promise;
  assert.deepEqual(out.query, query); assert.deepEqual(out.proposals[0].detail, rows[1].detail);
});
test('duplicate IDs fail before any provider call', async () => {
  await assert.rejects(run(query, [rows[0], rows[0]], () => assert.fail('called')), /DUPLICATE_PROPOSAL_ID/);
});
test('empty catalog has no provider call', async () => {
  const out = await run(query, [], () => assert.fail('called'));
  assert.deepEqual(out.proposals, []); assert.equal(out.evaluation.calls, 0);
});
test('extra query keys cannot alter the shared core contract', async () => {
  await assert.rejects(run({ ...query, generation: 1 }), /INVALID_QUERY/);
});
test('malformed JSONL is refused', async () => {
  await assert.rejects(compareContext(JSON.stringify(query), '{bad}', { ask }), SyntaxError);
});
test('oversized input is refused, never silently truncated', async () => {
  await assert.rejects(compareContext('x'.repeat(28001), '', { ask }), /INVALID_CONTEXT_INPUT/);
});
test('unknown row fields are not silently discarded', async () => {
  await assert.rejects(run(query, [{ ...rows[0], unexpected: 1 }]), /INVALID_CURRENT_ROWS/);
});
test('provider failure is not converted to a successful empty set', async () => {
  await assert.rejects(run(query, rows, async () => { throw new Error('fixture failure'); }), /fixture failure/);
});
test('invalid proposal is rejected by the original validator', async () => {
  await assert.rejects(run(query, [{ ...rows[0], id: '' }]), /INVALID_PROPOSALS/);
});
