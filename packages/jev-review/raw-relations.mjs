import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assertNoDuplicateObjectKeys } from '../structured-diagnostic/lib/diagnostic.mjs';
import { evaluate } from './review.mjs';
import { bindJevReview } from './jev.mjs';
import { JEV_MODEL } from './core.mjs';

const POLICY = 'ops.raw-relations.policy.v1';
const KINDS = ['duplicate', 'inconsistent', 'shared_concept_different_angle', 'term_alias'];
const BASELINES = ['exact_context_text', 'finite_set_intersection', 'declared_concept_angles', 'declared_term_senses'];
const fail = code => { throw new Error(code); };
const string = x => typeof x === 'string' && x.isWellFormed() && x.trim().length > 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, required, optional = []) => object(x) && required.every(k => Object.hasOwn(x, k))
  && Object.keys(x).every(k => [...required, ...optional].includes(k));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = x => Array.isArray(x) ? '[' + x.map(canonical).join(',') + ']'
  : object(x) ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}' : JSON.stringify(x);
const digest = x => hash(canonical(x));
const unique = xs => new Set(xs).size === xs.length;

export function strictJson(text) {
  let value;
  try {
    value = JSON.parse(text);
    assertNoDuplicateObjectKeys(text);
    // Parsed numbers are finite binary64, not exact arbitrary decimals. The
    // owner bytes remain the numeric lexical source; unsafe integers refuse.
    const valid = x => typeof x === 'number' ? Number.isFinite(x) && (!Number.isInteger(x) || Number.isSafeInteger(x))
      : typeof x === 'string' ? x.isWellFormed()
      : Array.isArray(x) ? x.every(valid) : object(x) ? Object.entries(x).every(([k, v]) => k.isWellFormed() && valid(v)) : true;
    if (!valid(value)) fail('UNSUPPORTED_PARSED_JSON');
  } catch { fail('INVALID_OR_DUPLICATE_JSON'); }
  return value;
}

const participantKey = p => canonical({ source: p.source, revision: p.revision, occurrence: p.occurrence });
const groupKey = g => digest({ check: g.check, participants: g.participants });
function validatePlan(plan) {
  if (!exact(plan, ['schema', 'sources', 'checks', 'context', 'obligations', 'candidates', 'candidateRule', 'scope', 'asOf'], ['filter'])
    || plan.schema !== 'ops.raw-relations.plan.v1' || !string(plan.scope) || !string(plan.asOf)
    || !Number.isFinite(Date.parse(plan.asOf))
    || !exact(plan.candidateRule, ['id', 'version']) || !Object.values(plan.candidateRule).every(string)) fail('INVALID_PLAN');
  for (const key of ['sources', 'checks', 'context', 'obligations', 'candidates']) if (!Array.isArray(plan[key]) || plan[key].length > 1000) fail('PLAN_LIMIT');
  if (!unique(plan.sources.map(s => canonical([s.id, s.revision]))) || !unique(plan.checks.map(c => c.id))
    || !unique(plan.context.map(c => c.id))) fail('IDENTITY_CONFLICT');
  for (const s of plan.sources) if (!exact(s, ['id', 'revision', 'path']) || !Object.values(s).every(string)) fail('INVALID_SOURCE');
  for (const c of plan.context) if (!exact(c, ['id', 'revision', 'value']) || !string(c.id) || !string(c.revision)) fail('INVALID_CONTEXT');
  for (const c of plan.checks) {
    if (!exact(c, ['id', 'version', 'kind', 'meaning', 'applicability', 'context'], ['baseline'])
      || ![c.id, c.version, c.meaning, c.applicability].every(string) || !KINDS.includes(c.kind)
      || (c.baseline !== undefined && c.baseline !== BASELINES[KINDS.indexOf(c.kind)])
      || !Array.isArray(c.context) || !unique(c.context)
      || c.context.some(id => !plan.context.some(x => x.id === id))) fail('INVALID_CHECK');
  }
  for (const groups of [plan.obligations, plan.candidates]) {
    if (!unique(groups.map(g => g.id))) fail('IDENTITY_CONFLICT');
    for (const g of groups) {
      if (!exact(g, ['id', 'check', 'participants']) || !string(g.id) || !plan.checks.some(c => c.id === g.check)
        || !Array.isArray(g.participants) || g.participants.length < 2 || g.participants.length > 64
        || !unique(g.participants.map(participantKey))) fail('INVALID_GROUP');
      for (const p of g.participants) if (!exact(p, ['source', 'revision', 'occurrence', 'role'])
        || !string(p.role) || !Number.isSafeInteger(p.occurrence) || p.occurrence < 1
        || !plan.sources.some(s => s.id === p.source && s.revision === p.revision)) fail('INVALID_PARTICIPANT');
    }
    if (!unique(groups.map(groupKey))) fail('DUPLICATE_GROUP');
  }
  if (plan.candidates.some(k => !plan.obligations.some(u => groupKey(k) === groupKey(u)))) fail('CANDIDATE_OUTSIDE_OBLIGATIONS');
  if (plan.filter !== undefined && (!exact(plan.filter, [], ['source', 'occurrence'])
    || (plan.filter.source !== undefined && !string(plan.filter.source))
    || (plan.filter.occurrence !== undefined && (!Number.isSafeInteger(plan.filter.occurrence) || plan.filter.occurrence < 1)))) fail('INVALID_FILTER');
}

// Original bytes remain owner files. Occurrence is the physical 1-based line;
// byte spans exclude the LF delimiter and retain a CR in CRLF input.
export function resolvePlan(plan, baseDir = '.') {
  validatePlan(plan);
  const rows = [], sources = [];
  let totalBytes = 0;
  for (const source of plan.sources) {
    const file = path.resolve(baseDir, source.path);
    if (fs.statSync(file).size > 1048576) fail('RAW_BYTE_LIMIT');
    const bytes = fs.readFileSync(file);
    totalBytes += bytes.length;
    if (totalBytes > 1048576) fail('RAW_BYTE_LIMIT');
    const sourceHash = hash(bytes), records = new Map();
    let start = 0, line = 1;
    for (let end = 0; end <= bytes.length; end++) {
      if (end !== bytes.length && bytes[end] !== 10) continue;
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end)); }
      catch { fail('INVALID_UTF8'); }
      if (text.trim()) {
        const raw = strictJson(text);
        if (!object(raw)) fail('RAW_NOT_OBJECT');
        if (Object.hasOwn(raw, 'id')) {
          if (!string(raw.id)) fail('INVALID_RECORD_ID');
          const recordBytes = bytes.subarray(start, end);
          if (records.has(raw.id) && !records.get(raw.id).equals(recordBytes)) fail('RECORD_IDENTITY_CONFLICT');
          records.set(raw.id, recordBytes);
        }
        rows.push({ sourceRef: { source: source.id, revision: source.revision, path: source.path,
          sha256: sourceHash, occurrence: line, recordId: raw.id ?? null,
          startByte: start, endByte: end }, raw });
      }
      start = end + 1; line++;
    }
    sources.push({ ...source, sha256: sourceHash, bytes: bytes.length });
  }
  const lookup = new Map(rows.map(row => [participantKey(row.sourceRef), row]));
  for (const g of [...plan.obligations, ...plan.candidates]) for (const p of g.participants)
    if (!lookup.has(participantKey(p))) fail('UNRESOLVED_PARTICIPANT');
  // Full source-set and candidate-rule binding deliberately invalidate all old
  // results when membership or any context changes, including new nary groups.
  const { filter: _filter, ...input } = plan;
  const dependencies = { policy: POLICY, ...input, sources };
  return { plan, rows, lookup, dependencies, binding: digest(dependencies) };
}

function baseline(check, participants) {
  const unknown = { assessment: 'UNKNOWN', basis: 'UNSUPPORTED_STRUCTURED_INPUT' };
  if (check.baseline !== BASELINES[KINDS.indexOf(check.kind)]) return { ...unknown, basis: 'NO_DECLARED_BASELINE_RULE' };
  const raws = participants.map(p => p.raw);
  const same = key => raws.every(r => Object.hasOwn(r, key)) && unique(raws.map(r => canonical(r[key])));
  // A deliberately limited comparator over explicitly supplied facts. It does
  // not infer natural-language equivalence, scope, authority, or alias senses.
  if (check.kind === 'duplicate') {
    if (!raws.every(r => string(r.content) && ['scope', 'authority', 'time'].every(k => Object.hasOwn(r, k)))) return unknown;
    const equal = key => raws.every(r => canonical(r[key]) === canonical(raws[0][key]));
    if (!['scope', 'authority', 'time'].every(equal)) return { assessment: 'NEGATIVE', basis: 'DISTINCT_DECLARED_CONTEXT' };
    return equal('content') ? { assessment: 'POSITIVE', basis: 'EXACT_TEXT_AND_DECLARED_CONTEXT' } : unknown;
  }
  if (check.kind === 'inconsistent') {
    const cs = raws.map(r => r.constraint);
    if (!cs.every(c => exact(c, ['variable', 'allowed']) && string(c.variable) && Array.isArray(c.allowed)
      && c.allowed.length > 0 && c.allowed.every(string)) || !cs.every(c => c.variable === cs[0].variable)) return unknown;
    return { assessment: cs[0].allowed.some(v => cs.every(c => c.allowed.includes(v))) ? 'NEGATIVE' : 'POSITIVE', basis: 'FINITE_ALLOWED_SET_INTERSECTION' };
  }
  if (check.kind === 'shared_concept_different_angle') {
    if (!raws.every(r => string(r.concept) && string(r.angle))) return unknown;
    if (!raws.every(r => r.concept === raws[0].concept)) return { assessment: 'NEGATIVE', basis: 'DISTINCT_DECLARED_CONCEPTS' };
    return same('angle') ? { assessment: 'POSITIVE', basis: 'DECLARED_CONCEPT_DISTINCT_ANGLES' } : unknown;
  }
  if (!raws.every(r => string(r.term) && string(r.sense) && string(r.concept))) return unknown;
  if (raws.every(r => r.concept === raws[0].concept && r.sense === raws[0].sense) && same('term'))
    return { assessment: 'POSITIVE', basis: 'DECLARED_SENSE_CONCEPT_ALIAS' };
  if (raws.every(r => r.term === raws[0].term) && same('sense')) return { assessment: 'NEGATIVE', basis: 'DECLARED_HOMONYM' };
  return unknown;
}

export async function evaluateRelations(resolved, { provider = 'baseline', ask, clock = () => performance.now() } = {}) {
  if (!['baseline', 'jev'].includes(provider) || (provider === 'jev' && typeof ask !== 'function')) fail('INVALID_PROVIDER');
  const { plan, lookup, binding, dependencies } = resolved;
  const outcomes = [], attempted = [];
  const started = clock();
  let calls = 0, waitMs = 0, tokenSum = 0, usageKnown = true, stopped = null;
  for (const candidate of plan.candidates) {
    const check = plan.checks.find(c => c.id === candidate.check);
    const participants = candidate.participants.map(p => ({ ...p, ...lookup.get(participantKey(p)) }));
    let result;
    if (check.context.some(id => {
      const value = plan.context.find(c => c.id === id).value;
      return value === null || (typeof value === 'string' && !value.trim());
    })) {
      result = { execution: 'NOT_RUN', assessment: 'UNKNOWN', basis: 'MISSING_CONTEXT', score: null,
        evidenceValidity: 'UNRESOLVED', usage: null, elapsedMs: 0 };
    } else if (provider === 'baseline') {
      attempted.push(candidate.id);
      const before = clock();
      result = { execution: 'COMPLETED', ...baseline(check, participants), score: null, evidenceValidity: 'VALID', usage: null, elapsedMs: clock() - before };
      if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) fail('INVALID_CLOCK');
    } else if (stopped || calls >= 24 || waitMs + 15000 > 600000 || tokenSum >= 100000) {
      result = { execution: 'NOT_RUN', assessment: 'UNKNOWN', basis: stopped ?? 'BUDGET_STOP', score: null, evidenceValidity: 'UNRESOLVED', usage: null, elapsedMs: 0 };
    } else {
      attempted.push(candidate.id);
      const before = clock(); calls++;
      try {
        const state = { schema: 'ops.raw-relations.state.v1', scope: plan.scope, asOf: plan.asOf,
          check, participants, context: plan.context, candidateRule: plan.candidateRule };
        const reply = await evaluate(state, { themes: [check.id], items: [{ theme: check.id,
          subject: candidate.participants.map(p => canonical(p)), concern: `${check.meaning} Applicability: ${check.applicability}. Assess the entire participant group with its roles, scope, time and authority. Pairwise compatibility is not proof of whole-group compatibility.` }] }, ask);
        const score = reply.judgments[0].noul;
        const usage = Object.fromEntries(Object.entries(reply.usage).filter(([key]) => ['input_tokens', 'output_tokens', 'total_tokens'].includes(key)));
        if (Object.values(usage).some(v => !Number.isSafeInteger(v) || v < 0)) fail('INVALID_USAGE');
        const tokens = Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens
          : Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens) ? usage.input_tokens + usage.output_tokens : null;
        if (tokens === null) { usageKnown = false; stopped = 'MISSING_USAGE'; } else tokenSum += tokens;
        result = { execution: 'COMPLETED', assessment: score >= .65 ? 'POSITIVE' : score <= .35 ? 'NEGATIVE' : 'UNKNOWN',
          basis: 'MODEL_RELATION_CANDIDATE_NOT_VERIFIED_TRUTH', score, evidenceValidity: 'VALID', usage: tokens === null ? null : usage };
      } catch {
        usageKnown = false; stopped = 'FAILED_OR_UNKNOWN_ATTEMPT';
        result = { execution: 'FAILED', assessment: 'UNKNOWN', basis: stopped, score: null, evidenceValidity: 'INVALID', usage: null };
      }
      result.elapsedMs = clock() - before;
      if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) fail('INVALID_CLOCK');
      waitMs += result.elapsedMs;
    }
    outcomes.push({ candidate: candidate.id, check: candidate.check, participants: candidate.participants,
      measurement: result.score === null ? null : { type: 'noul', noul: result.score },
      dependency: binding, ...result, review: 'UNREVIEWED', adoption: 'NOT_ADOPTED' });
  }
  const omissions = plan.obligations.filter(u => !plan.candidates.some(k => groupKey(k) === groupKey(u)))
    .map(u => ({ obligation: u.id, cause: 'OUTSIDE_SUPPLIED_CANDIDATES', assessment: 'UNKNOWN' }));
  const accounting = { provider, model: provider === 'jev' ? JEV_MODEL : null, calls, waitMs,
    reportedTokens: provider === 'jev' && !usageKnown ? null : tokenSum, elapsedMs: clock() - started,
    dollars: 'UNKNOWN', preparationReviewEffort: 'UNKNOWN', tokenPolicy: 'OBSERVED_STOP_NOT_HARD_CAP' };
  return { schema: 'ops.raw-relations.D.v1', policy: POLICY, binding, dependencies,
    checks: plan.checks, U: plan.obligations, K: plan.candidates, T: attempted, outcomes,
    positiveFindings: outcomes.filter(o => o.assessment === 'POSITIVE').map(o => o.candidate), omissions, accounting };
}

function validateD(d) {
  if (!exact(d, ['schema', 'policy', 'binding', 'dependencies', 'checks', 'U', 'K', 'T', 'outcomes', 'positiveFindings', 'omissions', 'accounting'])
    || d.schema !== 'ops.raw-relations.D.v1' || d.policy !== POLICY || d.binding !== digest(d.dependencies)
    || !['checks', 'U', 'K', 'T', 'outcomes', 'positiveFindings', 'omissions'].every(k => Array.isArray(d[k]))
    || canonical(d.checks) !== canonical(d.dependencies.checks) || canonical(d.U) !== canonical(d.dependencies.obligations)
    || canonical(d.K) !== canonical(d.dependencies.candidates) || !unique(d.T)
    || d.outcomes.length !== d.K.length || !unique(d.outcomes.map(o => o.candidate))) fail('INVALID_D');
  if (!object(d.dependencies) || d.dependencies.policy !== POLICY || !Array.isArray(d.dependencies.sources)) fail('INVALID_DEPENDENCIES');
  const { policy: _policy, ...boundPlan } = d.dependencies;
  boundPlan.sources = d.dependencies.sources.map(s => {
    if (!exact(s, ['id', 'revision', 'path', 'sha256', 'bytes']) || !/^[a-f0-9]{64}$/.test(s.sha256)
      || !Number.isSafeInteger(s.bytes) || s.bytes < 0 || s.bytes > 1048576) fail('INVALID_DEPENDENCIES');
    return { id: s.id, revision: s.revision, path: s.path };
  });
  validatePlan(boundPlan);
  const accounting = d.accounting;
  if (!exact(accounting, ['provider', 'model', 'calls', 'waitMs', 'reportedTokens', 'elapsedMs', 'dollars', 'preparationReviewEffort', 'tokenPolicy'])
    || !['baseline', 'jev'].includes(accounting.provider)) fail('INVALID_ACCOUNTING');
  const isJev = accounting.provider === 'jev';
  let knownTokens = 0, usageKnown = true, measuredWait = 0;
  for (const o of d.outcomes) {
    if (!exact(o, ['candidate', 'check', 'participants', 'measurement', 'dependency', 'execution', 'assessment', 'basis', 'score', 'evidenceValidity', 'usage', 'elapsedMs', 'review', 'adoption'])) fail('INVALID_OUTCOME');
    const k = d.K.find(k => k.id === o.candidate);
    if (!k || o.check !== k.check || canonical(o.participants) !== canonical(k.participants) || o.dependency !== d.binding
      || !['COMPLETED', 'FAILED', 'NOT_RUN'].includes(o.execution) || !['POSITIVE', 'NEGATIVE', 'UNKNOWN'].includes(o.assessment)
      || !['VALID', 'INVALID', 'UNRESOLVED'].includes(o.evidenceValidity) || o.review !== 'UNREVIEWED' || o.adoption !== 'NOT_ADOPTED'
      || (o.execution !== 'COMPLETED' && o.assessment !== 'UNKNOWN') || (o.evidenceValidity !== 'VALID' && o.assessment !== 'UNKNOWN')
      || d.T.includes(o.candidate) !== (o.execution !== 'NOT_RUN')) fail('INVALID_OUTCOME');
    if (!string(o.basis) || !Number.isFinite(o.elapsedMs) || o.elapsedMs < 0
      || (o.score !== null && (!Number.isFinite(o.score) || o.score < 0 || o.score > 1))
      || (o.score !== null && o.assessment !== (o.score >= .65 ? 'POSITIVE' : o.score <= .35 ? 'NEGATIVE' : 'UNKNOWN'))) fail('INVALID_OUTCOME');
    if (o.execution === 'COMPLETED') {
      if (o.evidenceValidity !== 'VALID') fail('INVALID_OUTCOME');
      if (isJev) {
        if (!exact(o.measurement, ['type', 'noul']) || o.measurement.type !== 'noul'
          || o.score === null || o.measurement.noul !== o.score
          || o.basis !== 'MODEL_RELATION_CANDIDATE_NOT_VERIFIED_TRUTH') fail('INVALID_TYPED_MEASUREMENT');
      } else {
        if (o.measurement !== null || o.score !== null || o.usage !== null) fail('INVALID_BASELINE_EVIDENCE');
        const check = d.checks.find(c => c.id === o.check);
        const allowed = {
          NO_DECLARED_BASELINE_RULE: ['UNKNOWN'], UNSUPPORTED_STRUCTURED_INPUT: ['UNKNOWN'],
          DISTINCT_DECLARED_CONTEXT: ['NEGATIVE'], EXACT_TEXT_AND_DECLARED_CONTEXT: ['POSITIVE'],
          FINITE_ALLOWED_SET_INTERSECTION: ['POSITIVE', 'NEGATIVE'], DISTINCT_DECLARED_CONCEPTS: ['NEGATIVE'],
          DECLARED_CONCEPT_DISTINCT_ANGLES: ['POSITIVE'], DECLARED_SENSE_CONCEPT_ALIAS: ['POSITIVE'], DECLARED_HOMONYM: ['NEGATIVE'],
        };
        const kindBases = {
          duplicate: ['DISTINCT_DECLARED_CONTEXT', 'EXACT_TEXT_AND_DECLARED_CONTEXT'],
          inconsistent: ['FINITE_ALLOWED_SET_INTERSECTION'],
          shared_concept_different_angle: ['DISTINCT_DECLARED_CONCEPTS', 'DECLARED_CONCEPT_DISTINCT_ANGLES'],
          term_alias: ['DECLARED_SENSE_CONCEPT_ALIAS', 'DECLARED_HOMONYM'],
        };
        if (!Object.hasOwn(allowed, o.basis) || !allowed[o.basis].includes(o.assessment)
          || !['NO_DECLARED_BASELINE_RULE', 'UNSUPPORTED_STRUCTURED_INPUT', ...kindBases[check.kind]].includes(o.basis)
          || (check.baseline === undefined && o.basis !== 'NO_DECLARED_BASELINE_RULE')
          || (check.baseline !== undefined && o.basis === 'NO_DECLARED_BASELINE_RULE')) fail('INVALID_BASELINE_EVIDENCE');
      }
    } else if (o.measurement !== null || o.score !== null || o.usage !== null
      || o.evidenceValidity !== (o.execution === 'FAILED' ? 'INVALID' : 'UNRESOLVED')) fail('INVALID_UNRESOLVED_EVIDENCE');
    if (o.usage !== null && (!exact(o.usage, [], ['input_tokens', 'output_tokens', 'total_tokens'])
      || Object.values(o.usage).some(v => !Number.isSafeInteger(v) || v < 0))) fail('INVALID_USAGE');
    if (isJev && o.execution !== 'NOT_RUN') {
      measuredWait += o.elapsedMs;
      const tokens = o.usage?.total_tokens ?? (o.usage?.input_tokens !== undefined && o.usage?.output_tokens !== undefined
        ? o.usage.input_tokens + o.usage.output_tokens : null);
      if (tokens === null) usageKnown = false; else knownTokens += tokens;
    }
  }
  if (d.T.some(id => !d.K.some(k => k.id === id))) fail('INVALID_ATTEMPTS');
  const omissions = d.U.filter(u => !d.K.some(k => groupKey(k) === groupKey(u)))
    .map(u => ({ obligation: u.id, cause: 'OUTSIDE_SUPPLIED_CANDIDATES', assessment: 'UNKNOWN' }));
  if (canonical(d.omissions) !== canonical(omissions) || !object(d.accounting)
    || !['baseline', 'jev'].includes(d.accounting.provider) || !Number.isSafeInteger(d.accounting.calls)
    || d.accounting.calls < 0 || d.accounting.calls > 24
    || d.accounting.calls !== (d.accounting.provider === 'jev' ? d.T.length : 0)
    || !Number.isFinite(d.accounting.waitMs) || d.accounting.waitMs < 0
    || (d.accounting.provider === 'baseline' && (d.accounting.model !== null || d.outcomes.some(o => o.score !== null)))
    || (d.accounting.provider === 'jev' && d.accounting.model !== JEV_MODEL)) fail('INVALID_ACCOUNTING');
  if (accounting.reportedTokens !== (usageKnown ? knownTokens : null) || accounting.waitMs !== measuredWait
    || !Number.isFinite(accounting.elapsedMs) || accounting.elapsedMs < 0 || accounting.dollars !== 'UNKNOWN'
    || accounting.preparationReviewEffort !== 'UNKNOWN' || accounting.tokenPolicy !== 'OBSERVED_STOP_NOT_HARD_CAP') fail('INVALID_ACCOUNTING');
  if (canonical(d.positiveFindings) !== canonical(d.outcomes.filter(o => o.assessment === 'POSITIVE').map(o => o.candidate))) fail('INVALID_FINDINGS');
}

export function projectRelations(resolved, d) {
  validateD(d);
  const current = d.binding === resolved.binding;
  return resolved.rows.filter(row => (!resolved.plan.filter?.source || resolved.plan.filter.source === row.sourceRef.source)
    && (!resolved.plan.filter?.occurrence || resolved.plan.filter.occurrence === row.sourceRef.occurrence)).map(row => {
    const matches = d.outcomes.filter(o => o.participants.some(p => participantKey(p) === participantKey(row.sourceRef)));
    const valid = current ? matches.filter(o => o.execution === 'COMPLETED' && o.evidenceValidity === 'VALID') : [];
    const obligations = resolved.plan.obligations.filter(u => u.participants.some(p => participantKey(p) === participantKey(row.sourceRef)));
    const candidates = resolved.plan.candidates.filter(k => k.participants.some(p => participantKey(p) === participantKey(row.sourceRef)));
    const omitted = obligations.filter(u => !candidates.some(k => groupKey(k) === groupKey(u)));
    return { ...row, annotations: valid.filter(o => o.assessment === 'POSITIVE'), evaluation: {
      status: !resolved.plan.checks.length ? 'NOT_SELECTED' : !current ? 'STALE' : !candidates.length ? 'NOT_CANDIDATE'
        : valid.length === candidates.length && !omitted.length ? 'COMPLETED' : 'INCOMPLETE',
      semanticAssessment: !valid.length || valid.length !== candidates.length || omitted.length || valid.some(o => o.assessment === 'UNKNOWN') ? 'UNKNOWN'
        : valid.some(o => o.assessment === 'POSITIVE') ? 'FINDING_CANDIDATE' : 'NEGATIVE_ON_SUPPLIED_CANDIDATES',
      evidenceCurrentness: current ? 'CURRENT' : 'STALE', review: 'UNREVIEWED', adoption: 'NOT_ADOPTED',
      outcomes: valid, diagnostics: matches.filter(o => !valid.includes(o)).map(o => ({ ...o, diagnostic: current ? 'INVALID_OR_UNRESOLVED' : 'STALE_DEPENDENCIES' })),
      obligations: obligations.map(u => u.id), candidates: candidates.map(k => k.id),
      omissionCauses: omitted.map(u => ({ obligation: u.id, cause: 'OUTSIDE_SUPPLIED_CANDIDATES' })),
      scope: resolved.plan.scope, asOf: resolved.plan.asOf, policy: POLICY,
    } };
  });
}

export async function rawRelationsMain(args) {
  const [operation, planFile, dFile, extra] = args;
  if (!['evaluate', 'project'].includes(operation) || !planFile || !dFile || extra) fail('RAW_RELATIONS_USAGE');
  const plan = strictJson(fs.readFileSync(planFile, 'utf8'));
  const resolved = resolvePlan(plan, path.dirname(path.resolve(planFile)));
  if (operation === 'evaluate') {
    // CLI defaults to a real deterministic baseline. Live selection is explicit
    // via the existing owner-injected provider binding, never inferred from a key.
    const d = await evaluateRelations(resolved);
    const bytes = JSON.stringify(d) + '\n';
    fs.writeFileSync(dFile, bytes, { flag: 'wx', mode: 0o600 });
    if (fs.readFileSync(dFile, 'utf8') !== bytes) fail('D_READBACK_MISMATCH');
    process.stdout.write(JSON.stringify({ schema: d.schema, binding: d.binding, accounting: d.accounting }) + '\n');
  } else {
    const d = strictJson(fs.readFileSync(dFile, 'utf8'));
    for (const row of projectRelations(resolved, d)) process.stdout.write(JSON.stringify(row) + '\n');
  }
}

// The target owner may bind this port after the separate route and finite-run
// preflight. No credential acquisition, provider selection or retry is added.
export function existingJevPort(key, fetchImpl = fetch) {
  const ask = bindJevReview({ key, fetchImpl });
  return (state, questions) => ask(state, questions, { timeoutMs: 15000 });
}
