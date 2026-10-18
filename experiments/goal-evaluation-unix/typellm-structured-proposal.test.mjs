import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { plan, checkPlan } from './core.mjs';
import { generateTyped } from '../../packages/typellm/src/typellm.mjs';
import { bindTypeLLMExecutorPorts } from './typellm-executor-ports.mjs';
import { buildTypeLLMProposalRequest } from './typellm-port.mjs';
import { buildTypeLLMStructuredProposalRequest, assembleTypeLLMStructuredProposal } from './typellm-structured-proposal.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const input = () => ({ goal: { ref: 'goal', content: 'Keep supplied requirements.' },
  observations: [{ ref: 'source', content: 'Statement A. Statement B.' }] });
const prompt = () => ({ ...input(), cores: [], maxQuestions: 4, maxClauses: 16 });
const criteria = () => ({ problem: 'Requirement contradicted.', ok: 'Requirement supported.', unknown: 'Evidence missing.' });
function wire(withCores = false) {
  return {
    clauses: [{ id: 'c1', kind: 'obligation', ref: 'goal', quote: 'Keep supplied requirements.' },
      { id: 'c2', kind: 'exception', ref: 'source', quote: 'Statement A.' }],
    questions: [1, 2].map(n => ({ id: 'q' + n, ...(withCores ? { hasCore: false, coreId: '' } : {}),
      question: 'Is requirement ' + n + ' supported?', criteria: criteria() })),
    questionClauseLinks: [{ questionId: 'q1', clauseId: 'c2' },
      { questionId: 'q2', clauseId: 'c1' }, { questionId: 'q1', clauseId: 'c1' }],
    basisLinks: [{ questionId: 'q2', ref: 'goal' }, { questionId: 'q1', ref: 'source' },
      { questionId: 'q1', ref: 'goal' }, { questionId: 'q2', ref: 'source' }],
    requiredLinks: [{ questionId: 'q2', ref: 'source' }, { questionId: 'q1', ref: 'source' }],
    needs: [{ questionId: 'q1', need: 'Unobserved measurement A.' },
      { questionId: 'q2', need: 'Unobserved measurement B.' }, { questionId: 'q1', need: 'Unobserved measurement C.' }],
    missing: [{ need: 'Independent evidence.', reason: 'Not supplied.' }]
  };
}
function port(executeTyped, options = {}) {
  const config = { id: 'synthetic-structured', mode: 'test-double',
    executorId: 'synthetic-only', bindingSha256: 'a'.repeat(64),
    runId: '11111111-2222-4333-8444-555555555555', deadlineMs: 1000,
    proposalFormat: 'typed-relations-v1', executeTyped, ...options };
  if (Object.hasOwn(options, 'proposalFormat') && options.proposalFormat === undefined) delete config.proposalFormat;
  return bindTypeLLMExecutorPorts(config);
}
const response = value => ({ result: clone(value) });
function fieldCount(definitions) {
  let count = 0;
  function schema(s, depth = 0) {
    if (s.type === 'array') {
      assert.equal(depth, 0); assert.ok(s.maxItems <= 32); assert.equal(s.depends_on, undefined);
      schema(s.items, depth + 1);
    }
    if (s.type === 'object') fields(s.properties, depth + 1);
    if (s.instructions !== undefined) assert.ok(s.instructions.length <= 8192);
  }
  function fields(rows, depth) {
    for (const value of Object.values(rows)) { count++; schema(value, depth); }
  }
  fields(definitions, 0);
  return count;
}

test('structured proposal: seven SDK-valid top arrays have exactly 27/29 counted fields', async () => {
  const p = prompt(), built = buildTypeLLMStructuredProposalRequest(p);
  assert.equal(built.request.context, buildTypeLLMProposalRequest(p).request.context);
  assert.deepEqual(Object.keys(built.request.questions),
    ['clauses', 'questions', 'questionClauseLinks', 'basisLinks', 'requiredLinks', 'needs', 'missing']);
  assert.equal(fieldCount(built.request.questions), 27);
  assert.equal(Object.hasOwn(built.request.questions.questions.items.properties, 'hasCore'), false);
  assert.equal(Object.hasOwn(built.request.questions.questions.items.properties, 'coreId'), false);
  const withCore = prompt(); withCore.cores = [{ id: 'supplied', question: 'Question', criteria: criteria() }];
  assert.equal(fieldCount(buildTypeLLMStructuredProposalRequest(withCore).request.questions), 29);
  assert.equal(built.request.questions.clauses.maxItems, 16);
  assert.equal(built.request.questions.questions.maxItems, 4);
  let posts = 0;
  const result = await generateTyped({ request: built.request, provider: { available: true,
    post: async body => {
      posts++; const sent = JSON.parse(body);
      assert.equal(sent.model, 'typellm-latest');
      assert.equal(fieldCount(sent.questions), 27);
      return response(wire());
    } } });
  assert.equal(posts, 1); assert.deepEqual(result.result, wire());
});

test('structured proposal: exact Core shape, null and relation order survive assembly', async () => {
  const supplied = wire(); let executions = 0;
  const bound = port(async (request, options) => {
    executions++;
    assert.equal(options.callId, '11111111-2222-4333-8444-555555555555/proposal/1');
    assert.ok(Object.isFrozen(request));
    assert.equal(JSON.parse(request.context).goal.content, input().goal.content);
    return response(supplied);
  });
  const value = await plan(input(), { propose: bound.propose });
  assert.equal(executions, 1);
  assert.deepEqual(checkPlan(value), value);
  assert.deepEqual(Object.keys(value.questions[0]),
    ['id', 'core', 'question', 'criteria', 'clauseIds', 'basisRefs', 'requiredRefs', 'needs']);
  assert.equal(value.questions[0].core, null);
  assert.deepEqual(value.questions[0].clauseIds, ['c2', 'c1']);
  assert.deepEqual(value.questions[0].basisRefs, ['source', 'goal']);
  assert.deepEqual(value.questions[0].requiredRefs, ['source']);
  assert.deepEqual(value.questions[0].needs, ['Unobserved measurement A.', 'Unobserved measurement C.']);
  assert.deepEqual(value.clauses, supplied.clauses);
  assert.deepEqual(value.missing, supplied.missing);
  const receipt = bound.receipts()[0];
  assert.equal(receipt.status, 'STRUCTURED_ASSEMBLED');
  assert.equal(receipt.proposalFormat, 'typed-relations-v1');
  assert.equal(receipt.structuredFieldCount, 27);
  assert.equal(receipt.structuredCoverage, 'UNKNOWN');
  assert.equal(receipt.saturatedArrays, 0);
  assert.equal(receipt.proposalUnits, null);
  assert.equal(receipt.proposalSha256, sha(JSON.stringify({ clauses: value.clauses,
    questions: value.questions, missing: value.missing })));
  assert.equal(receipt.remoteEffects, 'UNKNOWN');
  assert.equal(receipt.httpFetchAttempts, null);
});

test('structured proposal: core presence is explicit and Core still checks exact adopted content', async () => {
  const base = wire(true), catalog = { id: 'supplied-core', question: base.questions[0].question, criteria: criteria() };
  base.questions[0].hasCore = true; base.questions[0].coreId = catalog.id;
  const good = port(async () => response(base));
  const value = await plan(input(), { cores: [catalog], propose: good.propose });
  assert.equal(value.questions[0].core, catalog.id); assert.equal(value.questions[1].core, null);
  assert.equal(good.receipts()[0].structuredFieldCount, 29);
  for (const change of [
    x => { x.questions[0].hasCore = false; },
    x => { x.questions[0].coreId = 'not-supplied'; },
    x => { x.questions[0].coreId = ''; }
  ]) {
    const bad = clone(base); change(bad);
    const bound = port(async () => response(bad));
    await assert.rejects(plan(input(), { cores: [catalog], propose: bound.propose }),
      error => error.code === 'INVALID_STRUCTURED_PROPOSAL');
    assert.equal(bound.receipts()[0].executorInvocations, 1);
  }
  const mismatch = clone(base); mismatch.questions[0].question += ' changed';
  await assert.rejects(plan(input(), { cores: [catalog],
    propose: port(async () => response(mismatch)).propose }), /CORE_MISMATCH/);
});

test('structured proposal: orphan links, duplicate IDs or relations, and extra data fail without repair', async () => {
  const changes = [
    x => { x.questions[1].id = 'q1'; },
    x => { x.clauses[1].id = 'c1'; },
    x => { x.questions[0].id = 'arbitrary-id'; },
    x => { x.questionClauseLinks[0].questionId = 'q3'; },
    x => { x.questionClauseLinks[0].clauseId = 'c3'; },
    x => { x.basisLinks[0].questionId = 'q3'; },
    x => { x.requiredLinks.push(clone(x.requiredLinks[0])); },
    x => { x.needs.push(clone(x.needs[0])); }
  ];
  for (const change of changes) {
    const bad = wire(); change(bad); const before = JSON.stringify(bad);
    const bound = port(async () => response(bad));
    await assert.rejects(bound.propose(prompt()), error => error.code === 'INVALID_STRUCTURED_PROPOSAL');
    assert.equal(JSON.stringify(bad), before);
    assert.equal(bound.receipts().length, 1);
    await assert.rejects(bound.propose(prompt()), /PROPOSAL_ALREADY_CONSUMED/);
  }
  const extra = wire(); extra.basisLinks[0].discardable = 'must not be discarded';
  await assert.rejects(port(async () => response(extra)).propose(prompt()),
    error => error.code === 'provider_contract_error');
  assert.throws(() => assembleTypeLLMStructuredProposal({ ...wire(), extra: [] }, prompt()),
    /INVALID_STRUCTURED_PROPOSAL/);
  const extraCore = wire(); extraCore.questions[0].hasCore = false; extraCore.questions[0].coreId = '';
  await assert.rejects(port(async () => response(extraCore)).propose(prompt()),
    error => error.code === 'provider_contract_error');
});

test('structured proposal: source refs and quotes remain unchanged for Core rejection', async () => {
  for (const [change, code] of [
    [x => { x.requiredLinks[0].ref = 'unsupplied'; }, 'REQUIRED_REF_NOT_SUPPLIED'],
    [x => { x.basisLinks[0].ref = 'unsupplied'; }, 'INVALID_QUESTION'],
    [x => { x.clauses[0].quote = 'not an exact supplied quote'; }, 'CLAUSE_QUOTE_NOT_FOUND']
  ]) {
    const bad = wire(); change(bad); const bound = port(async () => response(bad));
    await assert.rejects(plan(input(), { propose: bound.propose }), new RegExp(code));
    assert.equal(bound.receipts()[0].status, 'STRUCTURED_ASSEMBLED');
    assert.equal(bound.receipts()[0].structuredCoverage, 'UNKNOWN');
  }
});

test('structured proposal: empty/all-missing candidates retain the existing Core behavior', async () => {
  const empty = Object.fromEntries(Object.keys(wire()).map(key => [key, []]));
  const emptyPlan = await plan(input(), { propose: port(async () => response(empty)).propose });
  assert.equal(emptyPlan.questions.length, 0); assert.equal(emptyPlan.clauses.length, 0);
  assert.deepEqual(emptyPlan.missing, [{ need: 'Goal coverage',
    reason: 'No questions or independent evidence of non-applicability supplied.' }]);
  const missing = clone(empty); missing.missing = [{ need: 'Missing evidence.', reason: 'Not observed.' }];
  const missingPlan = await plan(input(), { propose: port(async () => response(missing)).propose });
  assert.deepEqual(missingPlan.missing, missing.missing);
});

test('structured proposal: caller limits are preserved, unsupported >32 dispatches nothing', async () => {
  for (const field of ['maxQuestions', 'maxClauses']) {
    for (const value of [0, 33, 1.5]) {
      const p = prompt(); p[field] = value; let executions = 0;
      const bound = port(async () => { executions++; return response(wire()); });
      await assert.rejects(bound.propose(p), error => error.code === 'STRUCTURED_PROPOSAL_LIMIT');
      assert.equal(executions, 0); assert.equal(bound.receipts()[0].executorInvocations, 0);
      await assert.rejects(bound.propose(p), /PROPOSAL_ALREADY_CONSUMED/);
    }
  }
  const large = prompt(); large.maxQuestions = 32; large.maxClauses = 32;
  const built = buildTypeLLMStructuredProposalRequest(large);
  assert.equal(built.request.questions.questions.maxItems, 32);
  assert.equal(built.request.questions.clauses.maxItems, 32);
  assert.equal(fieldCount(built.request.questions), 27);
});

test('structured proposal: array saturation stays UNKNOWN, overflow is rejected rather than clipped', async () => {
  const full = wire(); full.missing = Array.from({ length: 32 }, (_, i) => ({ need: 'Need ' + i, reason: 'Not observed.' }));
  const bound = port(async () => response(full)); const candidate = await bound.propose(prompt());
  assert.equal(candidate.missing.length, 32);
  assert.equal(bound.receipts()[0].saturatedArrays, 1);
  assert.equal(bound.receipts()[0].structuredCoverage, 'UNKNOWN');
  const overflow = clone(full); overflow.missing.push({ need: 'Need 32', reason: 'Not observed.' });
  await assert.rejects(port(async () => response(overflow)).propose(prompt()),
    error => error.code === 'provider_contract_error');
  assert.throws(() => assembleTypeLLMStructuredProposal(overflow, prompt()), /INVALID_STRUCTURED_PROPOSAL/);
});

test('structured proposal: total structured output can exceed 2048 while each SDK leaf remains bounded', async () => {
  const long = 'x'.repeat(200), request = { goal: { ref: 'goal', content: long }, observations: [] };
  const output = wire(); output.clauses = Array.from({ length: 16 }, (_, i) => ({
    id: 'c' + (i + 1), kind: 'obligation', ref: 'goal', quote: long }));
  output.questions = output.questions.slice(0, 1);
  output.questionClauseLinks = output.clauses.map(row => ({ questionId: 'q1', clauseId: row.id }));
  output.basisLinks = [{ questionId: 'q1', ref: 'goal' }]; output.requiredLinks = []; output.needs = [];
  const bound = port(async () => response(output));
  const value = await plan(request, { propose: bound.propose });
  assert.ok(JSON.stringify(value.clauses).length > 2048);
  assert.equal(value.clauses.length, 16);
  assert.ok(bound.receipts()[0].proposalBytes > 2048);
  assert.equal(bound.receipts()[0].proposalUnits, null);
  const tooLong = clone(output); tooLong.clauses[0].quote = 'x'.repeat(2049);
  await assert.rejects(port(async () => response(tooLong)).propose({ ...request, cores: [], maxClauses: 16, maxQuestions: 4 }),
    error => error.code === 'provider_contract_error');
});

test('structured proposal: existing SDK request byte cap still rejects before executor', async () => {
  const p = prompt(); p.goal.content = 'x'.repeat(131072); let executions = 0;
  const bound = port(async () => { executions++; return response(wire()); });
  await assert.rejects(bound.propose(p), error => error.code === 'input_invalid');
  assert.equal(executions, 0); assert.equal(bound.receipts()[0].executorInvocations, 0);
  assert.equal(bound.receipts()[0].remoteEffects, 'NOT_DISPATCHED_BY_PORT');
});

test('structured proposal: snapshots survive mutation and returned candidates are frozen', async () => {
  const p = prompt(), original = JSON.stringify(p); let seen;
  const bound = port(async request => { seen = request; return response(wire()); });
  const pending = bound.propose(p); p.goal.content = 'changed after invocation';
  const candidate = await pending;
  assert.equal(seen.context, original); assert.ok(Object.isFrozen(seen.questions));
  assert.ok(Object.isFrozen(candidate)); assert.ok(Object.isFrozen(candidate.questions[0].criteria));
  assert.deepEqual(candidate.questions[0].basisRefs, ['source', 'goal']);
});

test('structured proposal: cancellation and pending executor timeout remain finite without retry', async () => {
  const controller = new AbortController(); controller.abort(); let executions = 0;
  const cancelled = port(async () => { executions++; return response(wire()); }, { signal: controller.signal });
  await assert.rejects(cancelled.propose(prompt()), error => error.code === 'cancelled');
  assert.equal(executions, 0); assert.equal(cancelled.receipts()[0].remoteEffects, 'NOT_DISPATCHED_BY_PORT');
  const timed = port(async () => { executions++; return new Promise(() => {}); }, { deadlineMs: 10 });
  await assert.rejects(timed.propose(prompt()), error => error.code === 'executor_timeout');
  assert.equal(executions, 1); assert.equal(timed.receipts()[0].remoteEffects, 'UNKNOWN');
  await assert.rejects(timed.propose(prompt()), /PROPOSAL_ALREADY_CONSUMED/); assert.equal(executions, 1);
});

test('structured proposal: default/explicit json-string request and SDK body retain exact parity', async () => {
  const p = prompt(), expected = buildTypeLLMProposalRequest(p).request;
  const native = clone(assembleTypeLLMStructuredProposal(wire(), p).candidate);
  const seen = [];
  for (const extra of [{ proposalFormat: undefined }, { proposalFormat: 'json-string' }]) {
    const bound = port(async request => { seen.push(clone(request)); return { result: { proposal: JSON.stringify(native) } }; }, extra);
    const candidate = await bound.propose(p); assert.deepEqual(candidate, native);
    assert.deepEqual(seen.at(-1), expected);
    assert.equal(bound.receipts()[0].status, 'JSON_PARSED');
    assert.equal(Object.hasOwn(bound.receipts()[0], 'proposalFormat'), false);
    assert.equal(Object.hasOwn(bound.receipts()[0], 'structuredCoverage'), false);
  }
  const bodies = [];
  for (const request of [expected, ...seen]) await generateTyped({ request, provider: { available: true,
    post: async body => { bodies.push(body); return { result: { proposal: JSON.stringify(native) } }; } } });
  assert.equal(bodies[0], bodies[1]); assert.equal(bodies[1], bodies[2]);
  assert.throws(() => port(async () => response(wire()), { proposalFormat: 'implicit-auto' }),
    /INVALID_TYPELLM_EXECUTOR_PORT/);
});


test('structured proposal: explicit timeout survives the exact SDK-to-executor request and Core validation', async () => {
  const captured = [], bodies = [], plans = [];
  for (const options of [{}, { requestTimeoutSeconds: 60 }]) {
    const bound = port(async request => {
      assert.ok(Object.isFrozen(request));
      captured.push(JSON.stringify(request));
      return generateTyped({ request, provider: { available: true, post: async body => {
        bodies.push(JSON.parse(body)); return response(wire());
      } } });
    }, options);
    plans.push(await plan(input(), { propose: bound.propose }));
    const receipt = bound.receipts()[0];
    assert.equal(receipt.typedRequestBytes, Buffer.byteLength(captured.at(-1)));
    assert.equal(receipt.typedRequestSha256, sha(captured.at(-1)));
    assert.equal(receipt.status, 'STRUCTURED_ASSEMBLED');
    assert.equal(receipt.structuredCoverage, 'UNKNOWN');
    assert.equal(receipt.remoteEffects, 'UNKNOWN');
  }
  const original = JSON.parse(captured[0]), explicit = JSON.parse(captured[1]);
  assert.equal(Object.hasOwn(original, 'timeout'), false);
  assert.equal(explicit.timeout, 60);
  delete explicit.timeout;
  assert.equal(JSON.stringify(explicit), captured[0]);
  assert.equal(bodies[0].timeout, 30); assert.equal(bodies[1].timeout, 60);
  const explicitBody = clone(bodies[1]); explicitBody.timeout = 30;
  assert.deepEqual(explicitBody, bodies[0]);
  assert.deepEqual(plans[1], plans[0]);
});

test('structured proposal: unsupported explicit timeout is refused before any executor invocation', () => {
  let executions = 0;
  for (const requestTimeoutSeconds of [undefined, 30, 90, 0, -1, 60.5, '60', null, false]) {
    assert.throws(() => port(async () => { executions++; return response(wire()); }, { requestTimeoutSeconds }),
      { message: 'INVALID_TYPELLM_EXECUTOR_PORT' });
  }
  assert.equal(executions, 0);
});
