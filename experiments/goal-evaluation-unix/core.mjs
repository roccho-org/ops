import { snapshotJson, exact } from '../../packages/jev-review/semlint-entry.mjs';

const copy = value => JSON.parse(JSON.stringify(snapshotJson(value)));
const fail = code => { throw new Error(code); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const unique = values => new Set(values).size === values.length;
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const DEFAULTS = { maxQuestions: 4, maxBytes: 28000, maxCalls: 4 };
function limits(options) {
  const value = { ...DEFAULTS, ...options };
  if (!exact(value, Object.keys(DEFAULTS)) || Object.values(value).some(x => !Number.isSafeInteger(x) || x < 1)) fail('INVALID_LIMITS');
  return value;
}
function requestShape(request) {
  if (!exact(request, ['goal', 'observations']) || !exact(request.goal, ['ref', 'content'])
    || !Object.values(request.goal).every(text) || !Array.isArray(request.observations)
    || request.observations.some(row => !exact(row, ['ref', 'content']) || !Object.values(row).every(text))
    || !unique([request.goal.ref, ...request.observations.map(row => row.ref)])) fail('INVALID_REQUEST');
}
function criteriaShape(criteria) {
  if (!exact(criteria, ['problem', 'ok', 'unknown']) || !Object.values(criteria).every(text)) fail('INVALID_CRITERIA');
}
function validate(plan, ceiling) {
  if (!exact(plan, ['schema', 'request', 'questions', 'missing']) || plan.schema !== 'ops.goal-evaluation.plan.v1') fail('INVALID_PLAN');
  requestShape(plan.request);
  const refs = [plan.request.goal.ref, ...plan.request.observations.map(row => row.ref)];
  if (!Array.isArray(plan.questions) || plan.questions.length > ceiling.maxQuestions || !unique(plan.questions.map(q => q.id))) fail('QUESTION_LIMIT_OR_ID');
  for (const q of plan.questions) {
    if (!exact(q, ['id', 'core', 'question', 'criteria', 'basisRefs', 'requires']) || !text(q.id) || !text(q.question)
      || !(q.core === null || text(q.core)) || !Array.isArray(q.basisRefs) || !unique(q.basisRefs)
      || !q.basisRefs.includes(plan.request.goal.ref) || q.basisRefs.some(ref => !refs.includes(ref))
      || !Array.isArray(q.requires) || !q.requires.every(text) || !unique(q.requires)) fail('INVALID_QUESTION');
    criteriaShape(q.criteria);
  }
  if (!Array.isArray(plan.missing) || plan.missing.some(row => !exact(row, ['need', 'reason']) || !Object.values(row).every(text))) fail('INVALID_MISSING');
  if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > ceiling.maxBytes) fail('BYTE_LIMIT');
}

// Core/template metadata is ordinary caller-owned data; propose sees the original Goal, not only the catalog.
export async function plan(request, { propose, cores = [], ...options }) {
  const input = copy(request), catalog = copy(cores), ceiling = limits(options);
  requestShape(input);
  if (typeof propose !== 'function' || !Array.isArray(catalog) || !unique(catalog.map(core => core.id))) fail('INVALID_PORT');
  for (const core of catalog) {
    if (!exact(core, ['id', 'question', 'criteria']) || !text(core.id) || !text(core.question)) fail('INVALID_CORE');
    criteriaShape(core.criteria);
  }
  const prompt = freeze(copy({ ...input, cores: catalog, maxQuestions: ceiling.maxQuestions }));
  if (Buffer.byteLength(JSON.stringify(prompt), 'utf8') > ceiling.maxBytes) fail('BYTE_LIMIT');
  const candidate = copy(await propose(prompt));
  if (!exact(candidate, ['questions', 'missing'])) fail('INVALID_PROPOSAL');
  const value = { schema: 'ops.goal-evaluation.plan.v1', request: input, ...candidate };
  validate(value, ceiling);
  for (const q of value.questions) if (q.core !== null) {
    const core = catalog.find(core => core.id === q.core);
    if (!core || q.question !== core.question || ['problem', 'ok', 'unknown'].some(key => q.criteria[key] !== core.criteria[key])) fail('CORE_MISMATCH');
  }
  if (!value.questions.length && !value.missing.length) value.missing.push({ need: 'Goal coverage', reason: 'No questions or independent evidence of non-applicability supplied.' });
  validate(value, ceiling);
  return freeze(value);
}

// Accepts a JSON-roundtripped Plan. No process-local brand, generated code, or authority is required.
export async function judge(value, model, options = {}) {
  const input = copy(value), ceiling = limits(options);
  validate(input, ceiling); freeze(input);
  if (!model || typeof model.which !== 'function') fail('INVALID_PORT');
  const present = new Set(input.request.observations.map(row => row.ref));
  const missing = copy(input.missing), judgments = [];
  let calls = 0;
  for (const q of input.questions) {
    const unavailable = q.requires.filter(ref => !present.has(ref));
    if (unavailable.length) {
      judgments.push({ id: q.id, status: 'INCOMPLETE', missingRefs: unavailable });
      missing.push({ need: q.id, reason: 'Required observations missing: ' + unavailable.join(', ') });
      continue;
    }
    if (calls >= ceiling.maxCalls) { judgments.push({ id: q.id, status: 'NOT_RUN' }); missing.push({ need: q.id, reason: 'Call limit' }); continue; }
    const question = { text: JSON.stringify(input.request), instructions: q.question, criteria: copy(q.criteria) };
    if (Buffer.byteLength(JSON.stringify(question), 'utf8') > ceiling.maxBytes) {
      judgments.push({ id: q.id, status: 'NOT_RUN' }); missing.push({ need: q.id, reason: 'Model question byte limit' }); continue;
    }
    calls++;
    try {
      const answer = await model.which(question);
      if (!answer || !Object.hasOwn(q.criteria, answer.label) || !text(answer.model)) fail('INVALID_ANSWER');
      judgments.push({ id: q.id, status: 'OBSERVED', label: answer.label, model: answer.model, rationale: answer.rationale ?? null });
    } catch { judgments.push({ id: q.id, status: 'EXECUTION_ERROR' }); missing.push({ need: q.id, reason: 'Model operation failed or answer invalid' }); }
  }
  return { schema: 'ops.goal-evaluation.judgments.v1', judgments, missing, calls, goalCoverage: 'NOT_CERTIFIED', authority: false };
}
