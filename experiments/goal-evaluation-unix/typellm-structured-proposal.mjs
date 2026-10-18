import { snapshotJson } from '../../packages/jev-review/semlint-entry.mjs';
import { buildTypeLLMProposalRequest } from './typellm-port.mjs';

const KEYS = ['clauses', 'questions', 'questionClauseLinks', 'basisLinks', 'requiredLinks', 'needs', 'missing'];
const ARRAY_LIMIT = 32; // Existing SDK limit; not the larger hosted API limit.
const fail = code => { throw new Error(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length
  && keys.every(key => Object.hasOwn(x, key));
const string = x => typeof x === 'string' && x.length <= 2048;
const freeze = x => {
  if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); }
  return x;
};
function bounds(prompt) {
  if (!Number.isSafeInteger(prompt.maxClauses) || !Number.isSafeInteger(prompt.maxQuestions)
      || prompt.maxClauses < 1 || prompt.maxClauses > ARRAY_LIMIT
      || prompt.maxQuestions < 1 || prompt.maxQuestions > ARRAY_LIMIT)
    fail('STRUCTURED_PROPOSAL_LIMIT');
  if (!Array.isArray(prompt.cores) || prompt.cores.some(x => !object(x)
      || !string(x.id) || !x.id.trim())
      || new Set(prompt.cores.map(x => x.id)).size !== prompt.cores.length)
    fail('INVALID_STRUCTURED_PROPOSAL_INPUT');
  return { clauses: prompt.maxClauses, questions: prompt.maxQuestions,
    questionClauseLinks: ARRAY_LIMIT, basisLinks: ARRAY_LIMIT, requiredLinks: ARRAY_LIMIT,
    needs: ARRAY_LIMIT, missing: ARRAY_LIMIT };
}

// Seven top-level arrays, no nested arrays/null schema/dependencies. The SDK counts
// 27/29 named fields recursively; core fields are absent for an empty catalog.
// Array item containers add no name.
export function buildTypeLLMStructuredProposalRequest(prompt, format = 'typed-relations-v1') {
  if (!['typed-relations-v1', 'typed-relations-dependent-v1'].includes(format))
    fail('INVALID_STRUCTURED_PROPOSAL_INPUT');
  const { captured, request: base } = buildTypeLLMProposalRequest(prompt);
  const limits = bounds(captured);
  const s = instructions => ({ type: 'string', instructions });
  const array = (key, instructions, properties) => ({ type: 'array', minItems: 0,
    maxItems: limits[key], instructions, items: { type: 'object', properties } });
  const questions = {
    clauses: array('clauses',
      'Preserve required obligations, exceptions and legitimate alternatives. Use c1,c2,... in emitted order. Quotes must be exact supplied text; a claim is not proof. Never drop uncertainty to fit.', {
        id: s('Use c followed by the 1-based position in clauses, e.g. c1.'),
        kind: { type: 'string', enum: ['obligation', 'exception', 'alternative'] },
        ref: s('Exact original Goal or observation ref; do not rename input refs.'),
        quote: s('Exact quote from that ref, without paraphrase or trimming.')
      }),
    questions: array('questions',
      'One judgment per question. Use q1,q2,... in emitted order. Relation arrays use those exact ids; preserve all needed conditions and unknowns. Empty questions is allowed with explicit missing information.', {
        id: s('Use q followed by the 1-based position in questions, e.g. q1.'),
        ...(captured.cores.length ? {
          hasCore: { type: 'boolean', instructions: 'True only when using an exact supplied core id.' },
          coreId: s('When hasCore=false return the empty string. When true return an exact supplied core id; do not invent one.')
        } : {}),
        question: s('The one judgment to ask; an adopted core keeps its exact question and criteria.'),
        criteria: { type: 'object', properties: {
          problem: s('Criterion for problem.'), ok: s('Criterion for ok.'), unknown: s('Criterion for unknown.')
        } }
      }),
    questionClauseLinks: array('questionClauseLinks',
      'Every question-to-clause relationship, in desired per-question order. questionId is q1,q2,... and clauseId is c1,c2,... from the emitted rows. Do not invent or omit relationships.', {
        questionId: s('Exact emitted question id.'), clauseId: s('Exact emitted clause id.')
      }),
    basisLinks: array('basisLinks',
      'All original basisRefs for each emitted question, in order, including the Goal ref. Use original supplied refs, never newly invented input ids.', {
        questionId: s('Exact emitted question id.'), ref: s('Exact supplied Goal or observation ref.')
      }),
    requiredLinks: array('requiredLinks',
      'All requiredRefs for each question in order. Only supplied observation refs belong here; unsupplied information belongs in needs.', {
        questionId: s('Exact emitted question id.'), ref: s('Exact supplied observation ref.')
      }),
    needs: array('needs',
      'Every unsupplied semantic observation needed by each question, in order. Do not hide unknowns or replace them with invented refs.', {
        questionId: s('Exact emitted question id.'), need: s('The missing semantic observation.')
      }),
    missing: array('missing',
      'Unresolved Goal coverage or observations, with reasons. If the bounded arrays or per-field string limit cannot represent all needed content, report the limitation; never clip, summarize away conditions, or certify completeness.', {
        need: s('What remains missing.'), reason: s('Why it remains missing or cannot be represented.')
      })
  };
  if (format === 'typed-relations-dependent-v1') {
    // Context remains the full original input. Only relations see generated siblings.
    questions.clauses.items.properties.quote.instructions =
      'Copy one contiguous substring of the decoded original ref.content exactly. Do not stitch parts, add omitted words or ellipses, paraphrase, trim, normalize, or quote JSON serialization escapes.';
    for (const key of KEYS.slice(2)) questions[key].depends_on = ['clauses', 'questions'];
  }
  return { captured, request: { context: base.context, questions } };
}

// Structural assembly only. No JSON-in-string parse, ID repair, deduplication,
// ref substitution, coverage inference, or adoption. Core still validates it.
export function assembleTypeLLMStructuredProposal(value, prompt) {
  const result = snapshotJson(value), captured = snapshotJson(prompt), limits = bounds(captured);
  if (!exact(result, KEYS)) fail('INVALID_STRUCTURED_PROPOSAL');
  for (const key of KEYS) if (!Array.isArray(result[key]) || result[key].length > limits[key])
    fail('INVALID_STRUCTURED_PROPOSAL');
  const clauseIds = new Set();
  result.clauses.forEach((row, i) => {
    if (!exact(row, ['id', 'kind', 'ref', 'quote']) || row.id !== 'c' + (i + 1)
        || clauseIds.has(row.id) || !['obligation', 'exception', 'alternative'].includes(row.kind)
        || !string(row.ref) || !string(row.quote)) fail('INVALID_STRUCTURED_PROPOSAL');
    clauseIds.add(row.id);
  });
  const ids = new Set(), suppliedCores = new Set(captured.cores.map(x => x.id));
  const withCores = suppliedCores.size > 0;
  const questions = result.questions.map((row, i) => {
    if (!exact(row, withCores ? ['id', 'hasCore', 'coreId', 'question', 'criteria'] : ['id', 'question', 'criteria'])
        || row.id !== 'q' + (i + 1) || ids.has(row.id) || !string(row.question)
        || !exact(row.criteria, ['problem', 'ok', 'unknown']) || !Object.values(row.criteria).every(string)
        || (withCores && (typeof row.hasCore !== 'boolean' || !string(row.coreId)
          || (row.hasCore ? !suppliedCores.has(row.coreId) : row.coreId !== ''))))
      fail('INVALID_STRUCTURED_PROPOSAL');
    ids.add(row.id);
    return { id: row.id, core: withCores && row.hasCore ? row.coreId : null, question: row.question,
      criteria: row.criteria, clauseIds: [], basisRefs: [], requiredRefs: [], needs: [] };
  });
  const byId = new Map(questions.map(row => [row.id, row]));
  for (const [key, field, target] of [['questionClauseLinks', 'clauseId', 'clauseIds'],
    ['basisLinks', 'ref', 'basisRefs'], ['requiredLinks', 'ref', 'requiredRefs'], ['needs', 'need', 'needs']]) {
    const seen = new Map();
    for (const row of result[key]) {
      if (!exact(row, ['questionId', field]) || !byId.has(row.questionId) || !string(row[field])
          || (key === 'questionClauseLinks' && !clauseIds.has(row[field])))
        fail('INVALID_STRUCTURED_PROPOSAL');
      const values = seen.get(row.questionId) ?? new Set();
      if (values.has(row[field])) fail('INVALID_STRUCTURED_PROPOSAL');
      values.add(row[field]); seen.set(row.questionId, values);
      byId.get(row.questionId)[target].push(row[field]);
    }
  }
  for (const row of result.missing) if (!exact(row, ['need', 'reason']) || !Object.values(row).every(string))
    fail('INVALID_STRUCTURED_PROPOSAL');
  return freeze({ candidate: { clauses: result.clauses, questions, missing: result.missing },
    metadata: { structuredFieldCount: withCores ? 29 : 27, structuredArrayLimit: ARRAY_LIMIT,
      structuredRows: KEYS.reduce((n, key) => n + result[key].length, 0),
      saturatedArrays: KEYS.filter(key => result[key].length === limits[key]).length,
      structuredCoverage: 'UNKNOWN' } });
}
