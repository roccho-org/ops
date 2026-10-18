import { createHash } from 'node:crypto';
import { snapshotJson, exact } from '../../packages/jev-review/semlint-entry.mjs';

const copy = value => JSON.parse(JSON.stringify(snapshotJson(value)));
const fail = code => { throw new Error(code); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const unique = values => new Set(values).size === values.length;
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const DEFAULTS = { maxQuestions: 4, maxClauses: 16, maxBytes: 28000, maxCalls: 4 };
const KINDS = ['obligation', 'exception', 'alternative'];
const LABELS = ['problem', 'ok', 'unknown'];
const MODES = ['live', 'test-double'];
// Native three-valued label from a ModelPort; deliberately not the Jev Choice primitive or a Noul value.
const ANSWER_TYPE = 'native-three-label';
const digest = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
// judge writes these missing reasons; report re-derives and checks them instead of trusting the result.
const CALL_LIMIT = 'Call limit', BYTE_LIMIT = 'Model question byte limit', FAILED = 'Model operation failed or answer invalid';
const notSupplied = q => 'Semantic observations not supplied: ' + q.needs.join('; ');
const REASONS = { INCOMPLETE: q => [notSupplied(q)], NOT_RUN: () => [CALL_LIMIT, BYTE_LIMIT], EXECUTION_ERROR: () => [FAILED] };
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
  if (!exact(criteria, LABELS) || !Object.values(criteria).every(text)) fail('INVALID_CRITERIA');
}
// A clause is an exact quote from the Goal or a supplied source. The quote check is mechanical provenance,
// not proof that the clause was read correctly, is complete, or is satisfied.
function clauseShape(clause, contents) {
  if (!exact(clause, ['id', 'kind', 'ref', 'quote']) || !text(clause.id) || !KINDS.includes(clause.kind)
    || !contents.has(clause.ref) || !text(clause.quote)) fail('INVALID_CLAUSE');
  if (!contents.get(clause.ref).includes(clause.quote)) fail('CLAUSE_QUOTE_NOT_FOUND');
}
function validate(plan, ceiling) {
  if (!exact(plan, ['schema', 'request', 'clauses', 'questions', 'missing']) || plan.schema !== 'ops.goal-evaluation.plan.v2') fail('INVALID_PLAN');
  requestShape(plan.request);
  const contents = new Map([plan.request.goal, ...plan.request.observations].map(row => [row.ref, row.content]));
  const observed = new Set(plan.request.observations.map(row => row.ref));
  if (!Array.isArray(plan.clauses) || plan.clauses.length > ceiling.maxClauses || !unique(plan.clauses.map(c => c.id))) fail('CLAUSE_LIMIT_OR_ID');
  for (const clause of plan.clauses) clauseShape(clause, contents);
  const kinds = new Map(plan.clauses.map(c => [c.id, c.kind]));
  if (!Array.isArray(plan.questions) || plan.questions.length > ceiling.maxQuestions || !unique(plan.questions.map(q => q.id))) fail('QUESTION_LIMIT_OR_ID');
  for (const q of plan.questions) {
    if (!exact(q, ['id', 'core', 'question', 'criteria', 'clauseIds', 'basisRefs', 'requiredRefs', 'needs']) || !text(q.id) || !text(q.question)
      || !(q.core === null || text(q.core)) || !Array.isArray(q.basisRefs) || !unique(q.basisRefs)
      || !q.basisRefs.includes(plan.request.goal.ref) || q.basisRefs.some(ref => !contents.has(ref))
      || !Array.isArray(q.clauseIds) || !unique(q.clauseIds) || q.clauseIds.some(id => !kinds.has(id))
      || !q.clauseIds.some(id => kinds.get(id) === 'obligation')
      || !Array.isArray(q.needs) || !q.needs.every(text) || !unique(q.needs)) fail('INVALID_QUESTION');
    // requiredRefs name supplied observations only. An unsupplied observation is a semantic need, never a ref.
    if (!Array.isArray(q.requiredRefs) || !unique(q.requiredRefs) || q.requiredRefs.some(ref => !observed.has(ref))) fail('REQUIRED_REF_NOT_SUPPLIED');
    criteriaShape(q.criteria);
  }
  if (!Array.isArray(plan.missing) || plan.missing.some(row => !exact(row, ['need', 'reason']) || !Object.values(row).every(text))) fail('INVALID_MISSING');
  if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > ceiling.maxBytes) fail('BYTE_LIMIT');
}

// Same Plan rules for other caller-local consumers of a JSON-roundtripped Plan; returns a frozen copy.
export function checkPlan(value, options = {}) {
  const input = copy(value);
  validate(input, limits(options));
  return freeze(input);
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
  const prompt = freeze(copy({ ...input, cores: catalog, maxQuestions: ceiling.maxQuestions, maxClauses: ceiling.maxClauses }));
  if (Buffer.byteLength(JSON.stringify(prompt), 'utf8') > ceiling.maxBytes) fail('BYTE_LIMIT');
  const candidate = copy(await propose(prompt));
  if (!exact(candidate, ['clauses', 'questions', 'missing'])) fail('INVALID_PROPOSAL');
  const value = { schema: 'ops.goal-evaluation.plan.v2', request: input, ...candidate };
  validate(value, ceiling);
  for (const q of value.questions) if (q.core !== null) {
    const core = catalog.find(core => core.id === q.core);
    if (!core || q.question !== core.question || LABELS.some(key => q.criteria[key] !== core.criteria[key])) fail('CORE_MISMATCH');
  }
  if (!value.questions.length && !value.missing.length) value.missing.push({ need: 'Goal coverage', reason: 'No questions or independent evidence of non-applicability supplied.' });
  validate(value, ceiling);
  return freeze(value);
}

// Accepts a JSON-roundtripped Plan. No process-local brand, generated code, or authority is required.
export async function judge(value, model, options = {}) {
  const input = copy(value), ceiling = limits(options);
  validate(input, ceiling); freeze(input);
  if (!model || typeof model.which !== 'function' || !text(model.id) || !MODES.includes(model.mode)) fail('INVALID_PORT');
  const missing = copy(input.missing), judgments = [];
  let calls = 0;
  for (const q of input.questions) {
    if (q.needs.length) {
      judgments.push({ id: q.id, status: 'INCOMPLETE', missingNeeds: copy(q.needs) });
      missing.push({ need: q.id, reason: notSupplied(q) });
      continue;
    }
    if (calls >= ceiling.maxCalls) { judgments.push({ id: q.id, status: 'NOT_RUN' }); missing.push({ need: q.id, reason: CALL_LIMIT }); continue; }
    // Exceptions and legitimate alternatives travel with the obligation they qualify.
    const clauses = input.clauses.filter(c => q.clauseIds.includes(c.id));
    const question = { text: JSON.stringify({ ...input.request, clauses }), instructions: q.question, criteria: copy(q.criteria) };
    if (Buffer.byteLength(JSON.stringify(question), 'utf8') > ceiling.maxBytes) {
      judgments.push({ id: q.id, status: 'NOT_RUN' }); missing.push({ need: q.id, reason: BYTE_LIMIT }); continue;
    }
    calls++;
    try {
      const answer = await model.which(question);
      const rationale = answer?.rationale ?? null;
      if (!answer || !Object.hasOwn(q.criteria, answer.label) || !text(answer.model)
        || !(rationale === null || text(rationale))) fail('INVALID_ANSWER');
      judgments.push({ id: q.id, status: 'OBSERVED', label: answer.label, model: answer.model, rationale });
    } catch { judgments.push({ id: q.id, status: 'EXECUTION_ERROR' }); missing.push({ need: q.id, reason: FAILED }); }
  }
  // planDigest binds raw answers to the exact Plan (request, clauses, questions) they answered.
  return { schema: 'ops.goal-evaluation.judgments.v2', planDigest: digest(input), port: { id: model.id, mode: model.mode },
    judgments, missing, calls, goalCoverage: 'NOT_CERTIFIED', authority: false };
}

// Mechanical visibility only: Goal text not covered by any Goal clause quote, as maximal spans with a letter or digit.
// Offsets are JavaScript string (UTF-16 code unit) indexes into goal.content. This judges no meaning.
export function unquotedGoalText(request, clauses) {
  const content = request.goal.content, covered = new Array(content.length).fill(false);
  for (const c of clauses) if (c.ref === request.goal.ref) {
    for (let at = content.indexOf(c.quote); at >= 0; at = content.indexOf(c.quote, at + 1)) covered.fill(true, at, at + c.quote.length);
  }
  const spans = [];
  for (let start = 0; start < content.length;) {
    if (covered[start]) { start++; continue; }
    let end = start;
    while (end < content.length && !covered[end]) end++;
    const raw = content.slice(start, end), lead = raw.length - raw.trimStart().length, body = raw.trim();
    if (/[\p{L}\p{N}]/u.test(body)) spans.push({ start: start + lead, end: start + lead + body.length, text: body });
    start = end;
  }
  return spans;
}
function judgmentShape(j, q) {
  if (j?.id !== q.id) return false;
  if (q.needs.length) return j.status === 'INCOMPLETE' && exact(j, ['id', 'status', 'missingNeeds'])
    && JSON.stringify(j.missingNeeds) === JSON.stringify(q.needs);
  if (j.status === 'OBSERVED') return exact(j, ['id', 'status', 'label', 'model', 'rationale']) && Object.hasOwn(q.criteria, j.label)
    && text(j.model) && (j.rationale === null || text(j.rationale));
  return ['NOT_RUN', 'EXECUTION_ERROR'].includes(j.status) && exact(j, ['id', 'status']);
}
// missing = Plan missing, then one row per unjudged question in order; calls = model invocations actually made.
function accountingMatches(value, result) {
  if (!Array.isArray(result.missing)) return false;
  const unjudged = result.judgments.map((j, i) => [j, value.questions[i]]).filter(([j]) => j.status !== 'OBSERVED');
  const rows = result.missing.slice(value.missing.length);
  return JSON.stringify(result.missing.slice(0, value.missing.length)) === JSON.stringify(value.missing)
    && rows.length === unjudged.length
    && rows.every((row, k) => { const [j, q] = unjudged[k]; return exact(row, ['need', 'reason']) && row.need === q.id && REASONS[j.status](q).includes(row.reason); })
    && result.calls === result.judgments.filter(j => ['OBSERVED', 'EXECUTION_ERROR'].includes(j.status)).length;
}

// Pure consumer view. It exposes what was and was not judged; it verifies no support and decides nothing.
export function report(planValue, resultValue, options = {}) {
  const value = copy(planValue), result = copy(resultValue);
  validate(value, limits(options));
  if (!exact(result, ['schema', 'planDigest', 'port', 'judgments', 'missing', 'calls', 'goalCoverage', 'authority'])
    || result.schema !== 'ops.goal-evaluation.judgments.v2' || result.planDigest !== digest(value)
    || !exact(result.port, ['id', 'mode']) || !text(result.port.id) || !MODES.includes(result.port.mode)
    || !Array.isArray(result.judgments) || result.judgments.length !== value.questions.length
    || result.judgments.some((j, i) => !judgmentShape(j, value.questions[i])) || !accountingMatches(value, result)
    || result.goalCoverage !== 'NOT_CERTIFIED' || result.authority !== false) fail('RESULT_PLAN_MISMATCH');
  const status = new Map(result.judgments.map(j => [j.id, j.status]));
  const questions = value.questions.map((q, i) => {
    const j = result.judgments[i];
    const outcome = j.status === 'OBSERVED'
      ? { status: j.status, answer: { type: ANSWER_TYPE, labels: LABELS, value: j.label }, model: j.model,
        rationale: j.rationale === null ? null : { text: j.rationale, verified: false } }
      : { status: j.status, ...(j.missingNeeds ? { missingNeeds: j.missingNeeds } : {}) };
    return { id: q.id, core: q.core, question: q.question, criteria: q.criteria, clauseIds: q.clauseIds,
      requiredRefs: q.requiredRefs.map(ref => ({ ref, supplied: true, support: 'NOT_VERIFIED' })), needs: q.needs, result: outcome };
  });
  const clauses = value.clauses.map(c => {
    const asked = value.questions.filter(q => q.clauseIds.includes(c.id)).map(q => q.id);
    const judged = asked.filter(id => status.get(id) === 'OBSERVED');
    return { ...c, questions: asked, assessment: judged.length ? 'JUDGED_UNVERIFIED' : 'UNASSESSED',
      ...(judged.length ? {} : { reason: asked.length ? 'QUESTIONS_NOT_JUDGED: ' + asked.map(id => status.get(id)).join(', ') : 'NO_QUESTION' }) };
  });
  const nextObservations = [...new Set([...value.missing.map(row => row.need),
    ...result.judgments.flatMap(j => j.missingNeeds ?? [])])];
  return { schema: 'ops.goal-evaluation.report.v1', goalRef: value.request.goal.ref, planDigest: result.planDigest, port: result.port,
    clauses, unquotedGoalText: unquotedGoalText(value.request, value.clauses),
    unassessed: clauses.filter(c => c.assessment === 'UNASSESSED').map(({ id, kind, quote, reason }) => ({ id, kind, quote, reason })),
    questions, missing: result.missing, nextObservations, nextDecision: 'CONSUMER_OWNED',
    goalCoverage: 'NOT_CERTIFIED', authority: false };
}
