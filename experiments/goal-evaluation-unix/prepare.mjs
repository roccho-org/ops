// Caller-local real-input preparation: acquisition receipts, an executor-identity or literal-CJK-refusal subject snapshot
// (of a PR, or on the Issue route of a granted subject Issue beside its invocation origin) and a faithful v14
// provided-request projection, optionally with a supplied English subject rendering. No client, auth, model, renderer,
// posting or Core change; readers are caller-owned ports.
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REQUEST_PREFIX, parseResultComment, COMMAND_OBSERVATION, ISSUE_KEYS, subjectRevision } from '../../packages/jev-review/github-comment.mjs';
import { EXECUTOR_LOGIN } from '../../packages/jev-review/issue-executor.mjs';
import { exact } from '../../packages/jev-review/semlint-entry.mjs';
import { validateJevBudget } from '../../packages/jev-review/core.mjs';
import { checkPlan, unquotedGoalText } from './core.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hold = (cause, extra = {}) => ({ status: 'HOLD', cause, emittable: false, ...extra });
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SCOPE = 'entire body of the approved pull request at the observed revision';
// The Issue route's fixed scope, equal to the shipped subjectScope; a settings file with another scope is not supported here.
const ISSUE_SCOPE = 'entire body of the approved Issue at the observed revision';
const MAX_CHECKS = 6;
const VERDICTS = ['FAITHFUL', 'UNFAITHFUL', 'UNKNOWN'];
const LITERAL_COMMAND = '/jev-evaluate';
const REFUSAL_KIND = 'literal-cjk-refusal';
const ISSUE_REFUSAL_KIND = 'literal-cjk-refusal-issue-subject';

// One receipt per acquisition. Only HTTP 200 with non-empty text is OK; 404 is NOT_FOUND; anything else,
// including 403/429/5xx, a thrown reader or an empty body, is UNKNOWN. A list read is OK only when the reader
// reports its Link header and that header names no next page. A receipt is an observation, not a fact.
export async function acquire({ ref, url, list = false }, reader, now = () => new Date().toISOString()) {
  if (!text(ref) || !text(url) || typeof list !== 'boolean' || !reader || !text(reader.id) || !['live', 'test-double'].includes(reader.mode)
    || typeof reader.get !== 'function') throw new Error('INVALID_READER');
  const base = { ref, url, reader: { id: reader.id, mode: reader.mode }, observedAt: now() };
  const empty = { bytes: null, sha256: null, content: null };
  let response;
  try { response = await reader.get(url); } catch { return { ...base, httpStatus: null, status: 'UNKNOWN', ...(list ? { complete: null } : {}), ...empty }; }
  const httpStatus = Number.isSafeInteger(response?.status) ? response.status : null;
  const body = typeof response?.text === 'string' ? response.text : null;
  const complete = list ? (typeof response?.link === 'string' ? !/rel="next"/.test(response.link) : null) : undefined;
  const status = httpStatus === 404 ? 'NOT_FOUND' : httpStatus === 200 && text(body) && complete !== false && complete !== null ? 'OK' : 'UNKNOWN';
  return { ...base, httpStatus, status, ...(list ? { complete } : {}), ...(status === 'OK'
    ? { bytes: Buffer.byteLength(body, 'utf8'), sha256: sha256(body), content: body } : empty) };
}

const parse = value => { try { return JSON.parse(value); } catch { return undefined; } };

// The target PR as returned by the public REST pulls endpoint; its body is the exact subject text.
export function pullRequestFrom(receipt, { repository, number }) {
  if (receipt?.status !== 'OK') return hold('INPUT_' + (receipt?.status ?? 'MISSING'));
  const pr = parse(receipt.content);
  if (pr?.number !== number || pr?.base?.repo?.full_name !== repository || !text(pr.node_id) || !text(pr.body)) return hold('PULL_REQUEST_MISMATCH');
  return { status: 'OK', pullRequest: { number, nodeId: pr.node_id, body: pr.body } };
}

// The executor's 5-part subjectRevision: node | sha256:<body> | lastEditedAt or unedited | edit count | includesCreatedEdit.
// Node and body come only from the public PR or Issue; only the edit signals are taken from the revision, which must round-trip.
function snapshotFromRevision(revision, { nodeId, body }, number) {
  const parts = revision.split('|');
  if (parts.length !== 5 || parts[0] !== nodeId) return { cause: 'EXECUTOR_IDENTITY_MISMATCH' };
  if (parts[1] !== 'sha256:' + sha256(body)) return { cause: 'SUBJECT_DRIFT' };
  if (!(parts[2] === 'unedited' || Number.isFinite(Date.parse(parts[2]))) || !/^(0|[1-9][0-9]*)$/.test(parts[3]) || !['true', 'false'].includes(parts[4])) {
    return { cause: 'EXECUTOR_IDENTITY_MISMATCH' };
  }
  const snapshot = { number, nodeId, body, lastEditedAt: parts[2] === 'unedited' ? null : parts[2],
    includesCreatedEdit: parts[4] === 'true', userContentEditsTotal: Number(parts[3]) };
  if (subjectRevision(snapshot) !== revision) return { cause: 'EXECUTOR_IDENTITY_MISMATCH' };
  return { snapshot };
}

// N1: the subject snapshot comes only from the existing executor's admitted old-literal result for the caller's
// own expected command/run/runtime. Author, marker, closed envelope, identity and body digest are all checked.
// readerDeclaredLive repeats the caller's reader declaration; it is not evidence that an actual read happened.
const targetValid = target => exact(target, ['repository', 'number']) && REPOSITORY.test(target.repository) && positive(target.number);
const expectedValid = expected => exact(expected, ['commandCommentId', 'runId', 'executionSource']) && positive(expected.commandCommentId)
  && positive(expected.runId) && typeof expected.executionSource === 'string' && /^[0-9a-f]{40}$/.test(expected.executionSource);
// The one executor result comment for the expected command in a complete comments list, or a HOLD.
function executorResult(commentsReceipt, expected) {
  if (commentsReceipt?.status !== 'OK' || commentsReceipt.complete !== true) return hold('INPUT_' + (commentsReceipt?.status === 'OK' ? 'INCOMPLETE' : commentsReceipt?.status ?? 'MISSING'));
  const comments = parse(commentsReceipt.content);
  if (!Array.isArray(comments)) return hold('COMMENTS_UNREADABLE');
  const results = comments.filter(c => c?.user?.login === EXECUTOR_LOGIN && typeof c.body === 'string')
    .map(c => ({ comment: c, envelope: parseResultComment(c.body) }))
    .filter(({ envelope }) => envelope?.identity?.commentId === expected.commandCommentId);
  if (results.length !== 1) return hold(results.length ? 'EXECUTOR_RESULT_AMBIGUOUS' : 'REVISION_UNOBSERVED');
  return results[0];
}

export function executorIdentitySnapshot({ commentsReceipt, pullRequestReceipt, target, expected }) {
  if (!targetValid(target)) return hold('TARGET_INVALID');
  if (!expectedValid(expected)) return hold('EXPECTED_ORIGIN_MISSING');
  const pr = pullRequestFrom(pullRequestReceipt, target);
  if (pr.status !== 'OK') return pr;
  const found = executorResult(commentsReceipt, expected);
  if (found.status === 'HOLD') return found;
  const { comment, envelope } = found, id = envelope.identity, { pullRequest } = pr;
  if (!exact(envelope, ['schema', 'requestDigest', 'identity', 'authority', 'result']) || envelope.schema !== 'ops.jev.issue-result.v1'
    || envelope.authority !== false || id?.repository !== target.repository || id.issue !== target.number || id.targetKind !== 'pull-request'
    || id.observation !== COMMAND_OBSERVATION || id.run?.id !== expected.runId || id.executionSource !== expected.executionSource
    || id.issueNodeId !== pullRequest.nodeId || typeof id.subjectRevision !== 'string') return hold('EXECUTOR_IDENTITY_MISMATCH');
  const { snapshot, cause } = snapshotFromRevision(id.subjectRevision, pullRequest, target.number);
  if (!snapshot) return hold(cause);
  return { status: 'VERIFIED', target: { ...target }, snapshot,
    readerDeclaredLive: [commentsReceipt, pullRequestReceipt].every(r => r.reader.mode === 'live'),
    origin: { resultCommentId: comment.id, requestDigest: envelope.requestDigest, runId: expected.runId, commandCommentId: expected.commandCommentId } };
}

// The Issue route. The invocation origin (the configured Issue that holds command, run, claim and result) and the
// approved subject Issue (the evaluated text) are separate caller inputs, each read at its own canonical URL. Neither
// stands in for the other, and the subject is never inferred from the origin, a URL or the top-level identity.
const subjectTargetValid = target => exact(target, ['repository', 'repositoryId', 'number']) && REPOSITORY.test(target.repository)
  && typeof target.repositoryId === 'string' && /^[1-9][0-9]*$/.test(target.repositoryId) && positive(target.number);
const observedBody = body => typeof body === 'string' && body.length > 0;
const READER_LIMIT = 'readerDeclaredLive repeats the caller\'s reader-port declarations for the public reads used; it is not evidence that an actual read happened';

// One Issue as returned by the public REST issues endpoint, read at exactly its canonical URL. A pull request is an Issue
// there too and carries its own pull_request key, so it is refused. The body is passed on as observed, never coerced.
function issueFrom(receipt, { repository, number }) {
  if (receipt?.status !== 'OK') return hold('INPUT_' + (receipt?.status ?? 'MISSING'));
  const api = `https://api.github.com/repos/${repository}`, value = parse(receipt.content);
  if (receipt.url !== `${api}/issues/${number}` || value?.repository_url !== api || value.number !== number || !text(value.node_id)) return hold('ISSUE_MISMATCH');
  if (Object.hasOwn(value, 'pull_request')) return hold('NOT_AN_ISSUE');
  return { status: 'OK', issue: { number, nodeId: value.node_id, body: value.body } };
}

// A null, empty or non-text body is not an observed body (GitHub reports an empty body as null): it holds, unrepaired.
function readIssues(originIssueReceipt, originTarget, subjectIssueReceipt, subjectTarget) {
  const origin = issueFrom(originIssueReceipt, originTarget);
  if (origin.status !== 'OK') return origin;
  if (!observedBody(origin.issue.body)) return hold('ORIGIN_BODY_UNOBSERVED');
  const subject = issueFrom(subjectIssueReceipt, { repository: subjectTarget.repository, number: subjectTarget.number });
  if (subject.status !== 'OK') return subject;
  if (!observedBody(subject.issue.body)) return hold('SUBJECT_BODY_UNOBSERVED');
  return { status: 'OK', origin: origin.issue, subject: subject.issue };
}

// Each pair binds its own Issue: the node must match and the 5-part revision must round-trip against that Issue's public
// body, through the same parser as the PR route. The origin revision is kept as provenance and never evaluated.
function bindIssues(read, originTarget, subjectTarget, originPair, subjectPair) {
  if (originPair.nodeId !== read.origin.nodeId || typeof originPair.revision !== 'string') return hold('ORIGIN_IDENTITY_MISMATCH');
  const origin = snapshotFromRevision(originPair.revision, read.origin, originTarget.number);
  if (!origin.snapshot) return hold(origin.cause === 'SUBJECT_DRIFT' ? 'ORIGIN_DRIFT' : 'ORIGIN_IDENTITY_MISMATCH');
  if (subjectPair.nodeId !== read.subject.nodeId || typeof subjectPair.revision !== 'string') return hold('EXECUTOR_IDENTITY_MISMATCH');
  const { snapshot, cause } = snapshotFromRevision(subjectPair.revision, read.subject, subjectTarget.number);
  if (!snapshot) return hold(cause);
  return { snapshot, originTarget: { repository: originTarget.repository, number: originTarget.number, nodeId: read.origin.nodeId },
    target: { repository: subjectTarget.repository, number: subjectTarget.number } };
}

// N1 on the Issue route, English branch: the existing executor's admitted literal result for the caller's expected
// command/run/runtime on the origin. Its top-level identity names the origin and identity.subject the evaluated Issue.
export function issueSubjectIdentitySnapshot({ commentsReceipt, originIssueReceipt, subjectIssueReceipt, originTarget, subjectTarget, expected }) {
  if (!targetValid(originTarget) || !subjectTargetValid(subjectTarget)) return hold('TARGET_INVALID');
  if (!expectedValid(expected)) return hold('EXPECTED_ORIGIN_MISSING');
  const read = readIssues(originIssueReceipt, originTarget, subjectIssueReceipt, subjectTarget);
  if (read.status !== 'OK') return read;
  const found = executorResult(commentsReceipt, expected);
  if (found.status === 'HOLD') return found;
  const { comment, envelope } = found, id = envelope.identity, s = id?.subject;
  if (!exact(envelope, ['schema', 'requestDigest', 'identity', 'authority', 'result']) || envelope.schema !== 'ops.jev.issue-result.v1'
    || envelope.authority !== false || id?.repository !== originTarget.repository || id.issue !== originTarget.number || Object.hasOwn(id, 'targetKind')
    || id.observation !== COMMAND_OBSERVATION || id.run?.id !== expected.runId || id.executionSource !== expected.executionSource
    || !exact(s, ['repository', 'repositoryId', 'kind', 'number', 'nodeId', 'revision']) || s.repository !== subjectTarget.repository
    || s.repositoryId !== subjectTarget.repositoryId || s.kind !== 'issue' || s.number !== subjectTarget.number) return hold('EXECUTOR_IDENTITY_MISMATCH');
  const bound = bindIssues(read, originTarget, subjectTarget, { nodeId: id.issueNodeId, revision: id.subjectRevision }, { nodeId: s.nodeId, revision: s.revision });
  if (bound.status === 'HOLD') return bound;
  return { status: 'VERIFIED', subjectKind: 'issue', originTarget: bound.originTarget, target: bound.target, snapshot: bound.snapshot,
    readerDeclaredLive: [commentsReceipt, originIssueReceipt, subjectIssueReceipt].every(r => r.reader.mode === 'live'),
    provenance: { kind: 'literal-result', originRevision: id.subjectRevision, subjectTarget: { ...subjectTarget },
      origin: { resultCommentId: comment.id, requestDigest: envelope.requestDigest, runId: expected.runId, commandCommentId: expected.commandCommentId },
      limits: [READER_LIMIT] } };
}

// S4: the closed Issue-route snapshot, recognised only in exactly this shape.
const issueSnapshotValid = s => exact(s, ['status', 'subjectKind', 'originTarget', 'target', 'snapshot', 'readerDeclaredLive', 'provenance'])
  && s.subjectKind === 'issue' && exact(s.originTarget, ['repository', 'number', 'nodeId']) && exact(s.target, ['repository', 'number'])
  && exact(s.snapshot, ISSUE_KEYS) && typeof s.readerDeclaredLive === 'boolean'
  && exact(s.provenance, ['kind', 'originRevision', 'subjectTarget', 'origin', 'limits']) && ['literal-result', ISSUE_REFUSAL_KIND].includes(s.provenance.kind)
  && exact(s.provenance.subjectTarget, ['repository', 'repositoryId', 'number']) && s.provenance.subjectTarget.repository === s.target.repository
  && s.provenance.subjectTarget.number === s.target.number;

const unit = (fields, content) => ({ ...fields, content, sha256: sha256(content),
  evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(content, 'utf8') }, englishAuxiliary: null });

// The wire question always asks whether the problem criterion holds, so true=problem and false=ok cannot invert
// a question phrased in the ok direction. The plan's own question is quoted, not reworded.
const problemQuestion = q => `Does the problem criterion hold for this target, rather than the ok criterion? Original question: ${q.question}`;

// Fidelity is R's record about exact envelope bytes, supplied from outside; this code never assigns a verdict. With a
// subject rendering the record also carries R's renderingVerdict, separate from the check verdicts.
function fidelityOf(record, envelopeSha256, ids, rendering) {
  if (record === undefined) return { verdicts: Object.fromEntries(ids.map(id => [id, 'UNREVIEWED'])), ...(rendering ? { renderingVerdict: 'UNREVIEWED' } : {}), allFaithful: false };
  if (!exact(record, ['reviewRef', 'envelopeSha256', 'verdicts', ...(rendering ? ['renderingVerdict'] : [])]) || !text(record.reviewRef)
    || record.envelopeSha256 !== envelopeSha256 || !exact(record.verdicts, ids) || ids.some(id => !VERDICTS.includes(record.verdicts[id]))
    || (rendering && !VERDICTS.includes(record.renderingVerdict))) throw new Error('FIDELITY_RECORD_MISMATCH');
  return { reviewRef: record.reviewRef, verdicts: { ...record.verdicts }, ...(rendering ? { renderingVerdict: record.renderingVerdict } : {}),
    allFaithful: ids.every(id => record.verdicts[id] === 'FAITHFUL') && (!rendering || record.renderingVerdict === 'FAITHFUL') };
}

// Faithful binary projection of obligation-bound questions without needs. Goal and clause text stay local:
// the wire carries only the subject, the English predicates and English context the caller selected; a CJK Goal is
// kept as ref and digest.
// `subjectRef` is the caller's declaration of which plan observation is the subject text. Nothing is inferred from
// ref names or URLs: without it, no observation counts as carried. `contextRefs` is the caller's explicit choice of
// other observations that may be published on the wire as context; only those a projected check requires are sent.
export function project(planValue, subject, { fidelity, englishAuxiliary, subjectRef, contextRefs, ...planLimits } = {}) {
  const value = checkPlan(planValue, planLimits);
  const observations = new Map(value.request.observations.map(row => [row.ref, row.content]));
  // The Goal ref is never an observation ref, so it cannot be declared as the subject either.
  if (subjectRef !== undefined && (typeof subjectRef !== 'string' || !observations.has(subjectRef))) throw new Error('INVALID_SUBJECT_REF');
  // An absent selection carries nothing beyond the subject. Each entry names one supplied observation other than the
  // subject, exactly as written; names and contents are never trimmed or rewritten.
  const selected = contextRefs === undefined ? [] : contextRefs;
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length
    || selected.some(ref => typeof ref !== 'string' || ref === subjectRef || !observations.has(ref))) throw new Error('INVALID_CONTEXT_REF');
  // A selected ref is carried only next to a declared subject, and only when its name and whole content are CJK-free:
  // the provided admission refuses CJK outside the subject and any context auxiliary, so it is withheld, never translated.
  const blocked = ref => subjectRef === undefined ? 'SUBJECT_REF_REQUIRED' : CJK.test(ref) || CJK.test(observations.get(ref)) ? 'CJK_CONTEXT_NOT_ADMITTED' : null;
  const carried = ref => ref === subjectRef || (selected.includes(ref) && blocked(ref) === null);
  const checks = [], mapping = [], notProjected = [], contextNotCarried = [], contextUnits = [];
  for (const q of value.questions) {
    if (q.needs.length) { notProjected.push({ id: q.id, reason: 'INCOMPLETE', needs: q.needs, clauseIds: q.clauseIds }); continue; }
    // A question requiring an observation the wire does not carry would be judged without it. It stays for a Program,
    // the local judge or a direct route instead, with every required ref other than the subject listed, since none of
    // them reaches the wire for it. Only requiredRefs are gated; basisRefs and clause sources are not a carriage declaration.
    const others = q.requiredRefs.filter(ref => ref !== subjectRef);
    if (!q.requiredRefs.every(carried)) {
      for (const ref of q.requiredRefs) if (selected.includes(ref) && !carried(ref) && !contextNotCarried.some(row => row.ref === ref)) contextNotCarried.push({ ref, reason: blocked(ref) });
      notProjected.push({ id: q.id, reason: 'REQUIRED_CONTEXT_NOT_CARRIED', requiredRefs: q.requiredRefs, notCarried: others, clauseIds: q.clauseIds });
      continue;
    }
    if (checks.length === MAX_CHECKS) { notProjected.push({ id: q.id, reason: 'LIMIT', clauseIds: q.clauseIds }); continue; }
    for (const ref of others) if (!contextUnits.includes(ref)) contextUnits.push(ref);
    checks.push({ id: q.id, axis: 'Aligned', concern: `Goal-derived question ${q.id}.`, requiredRoles: others.map(ref => 'observation:' + ref), crossLinks: [],
      predicate: { question: problemQuestion(q), true: q.criteria.problem, false: q.criteria.ok } });
    const clauses = value.clauses.filter(c => q.clauseIds.includes(c.id));
    // Exceptions and legitimate alternatives are not on the wire; R checks that the criteria text reflects them.
    mapping.push({ id: q.id, originalQuestion: q.question, clauses, offWireQualifiers: clauses.filter(c => c.kind !== 'obligation'),
      true: 'problem', false: 'ok', notLowered: { unknown: q.criteria.unknown } });
  }
  // Every outcome, HOLD included, keeps what the wire does not carry: clauses no check covers, unquoted Goal text
  // and the Plan's own unresolved needs (including the automatic Goal coverage note).
  const covered = new Set(mapping.flatMap(m => m.clauses.map(c => c.id)));
  const unprojectedClauses = value.clauses.filter(c => !covered.has(c.id)).map(c => {
    const asked = notProjected.filter(n => n.clauseIds.includes(c.id));
    return { ...c, reason: asked.length ? 'NOT_PROJECTED: ' + asked.map(n => `${n.id} ${n.reason}`).join(', ') : 'NO_QUESTION' };
  });
  const goal = value.request.goal;
  const base = { checks, mapping, notProjected, unprojectedClauses, unquotedGoalText: unquotedGoalText(value.request, value.clauses), missing: value.missing,
    goal: { ref: goal.ref, sha256: sha256(goal.content), onWire: !CJK.test(goal.content) }, ...(contextNotCarried.length ? { contextNotCarried } : {}) };
  if (!value.clauses.some(c => c.kind === 'obligation')) return hold('NEED_CLARIFICATION', base);
  // With no Core check the projection is decided without the subject: nothing reaches the wire, so no snapshot or
  // paid identity is awaited. This concludes only the projection, not an evaluation, Program result or posting.
  if (!checks.length) return hold('NOTHING_PROJECTED', base);
  // A verified subject with a subjectKind marker is the Issue route, and only in its exact closed shape; any other marker
  // or shape holds here. PR snapshots carry no marker.
  const issueRoute = subject?.status === 'VERIFIED' && Object.hasOwn(subject, 'subjectKind');
  if (issueRoute && !issueSnapshotValid(subject)) return hold('SUBJECT_KIND_UNSUPPORTED', base);
  if (subject?.status !== 'VERIFIED' || !exact(subject.target, ['repository', 'number']) || !REPOSITORY.test(subject.target.repository)
    || subject.target.number !== subject.snapshot?.number) return hold(subject?.cause ?? 'REVISION_UNOBSERVED', base);
  const { snapshot, target } = subject;
  // A declared subject observation must be the evaluated text byte for byte. Otherwise the plan's clauses and questions
  // describe other text, so the whole case holds, even when no remaining check names the observation.
  if (subjectRef !== undefined && observations.get(subjectRef) !== snapshot.body) return hold('SUBJECT_OBSERVATION_MISMATCH', base);
  const subjectUnit = unit({ kind: 'log-entry', ref: `https://github.com/${target.repository}/${issueRoute ? 'issues' : 'pull'}/${target.number}`,
    revision: subjectRevision(snapshot), scope: issueRoute ? ISSUE_SCOPE : SCOPE }, snapshot.body);
  // A supplied English rendering of the subject only, bound to the whole observed body. Core v14 auxiliary() requires it
  // to be null exactly when the selected text has no CJK, so an English body takes none.
  const rendering = englishAuxiliary !== undefined;
  if (rendering) {
    if (!exact(englishAuxiliary, ['text', 'sourceSha256']) || !text(englishAuxiliary.text) || CJK.test(englishAuxiliary.text)
      || englishAuxiliary.sourceSha256 !== subjectUnit.sha256) return hold('AUXILIARY_INVALID', base);
    if (!CJK.test(snapshot.body)) return hold('RENDERING_NOT_NEEDED', base);
    subjectUnit.englishAuxiliary = { text: englishAuxiliary.text, sourceSha256: englishAuxiliary.sourceSha256 };
  }
  const input = { schema: 'ops.semlint.input.v14', subject: subjectUnit,
    context: [...(base.goal.onWire ? [unit({ role: 'goal', ref: goal.ref, revision: 'sha256:' + base.goal.sha256 }, goal.content)] : []),
      ...contextUnits.map(ref => unit({ role: 'observation:' + ref, ref, revision: 'sha256:' + sha256(observations.get(ref)) }, observations.get(ref)))],
    checks };
  // Without a rendering any CJK makes the case unsupported; with one, CJK may remain only in the original subject content.
  if (CJK.test(JSON.stringify(rendering ? { ...input, subject: { ...subjectUnit, content: '' } } : input))) return { status: 'UNSUPPORTED_CJK', emittable: false, ...base };
  // The runtime refuses a wire input over its raw budget before any claim (semlint's own validateJevBudget). The same
  // existing check runs here, on the exact object the envelope carries, so such a case holds instead of looking eligible.
  try { validateJevBudget(input, {}); } catch { return hold('WIRE_BUDGET_EXCEEDED', base); }
  // The case id names the route by caller convention only; admission does not check it.
  const envelope = REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: [{ id: issueRoute ? 'issue' : 'pull-request', input }] });
  const envelopeSha256 = sha256(envelope);
  const review = fidelityOf(fidelity, envelopeSha256, checks.map(c => c.id), rendering);
  // All checks share one case and its context, so with carried K every projected mapping lists what was serialized for
  // all of them. That is availability and exposure, not the support the Plan declared for a check or what the model used.
  const shared = contextUnits.length ? { mapping: mapping.map(m => ({ ...m, sharedContextRefs: input.context.map(row => row.ref) })) } : {};
  return { status: 'ELIGIBLE', emittable: subject.readerDeclaredLive === true && review.allFaithful, ...base, ...shared, envelope, envelopeSha256,
    fidelity: review, postingAuthorized: false };
}

const SHA1 = /^[0-9a-f]{40}$/;
const okJson = receipt => receipt?.status === 'OK' ? parse(receipt.content) : undefined;
const inputCause = receipt => 'INPUT_' + (receipt?.status ?? 'MISSING');

// The plan-stage receipt the existing executor prints to its job log (one JSON object per line, after the runner's
// timestamp). Logs are not publicly readable and carry no provider digest, so these bytes are a P transport that
// is only checked for internal digest consistency here; they never stand alone as proof. `accept` is PLANNED for the
// old-literal result path, or REFUSED_CJK for the executor's literal CJK refusal in its exact closed shape: no claim, no
// provider call, no request digest, and the executor's own subject observation. A post-stage echo is never a plan receipt.
// REFUSED_CJK_SUBJECT is the Issue route's refusal: the same shape with exactly one more observed key, the evaluated
// subject's own {nodeId, revision}. Each route accepts only its own observation shape.
const REFUSAL_RECEIPT_KEYS = ['schema', 'stage', 'outcome', 'cause', 'claimed', 'providerCalls', 'authority', 'commentId', 'run', 'observed'];
function planStageReceipt(log, accept) {
  if (!exact(log, ['ref', 'route', 'observedAt', 'bytes', 'sha256', 'content', 'providerDigest']) || log.route !== 'p-transported-job-log'
    || log.providerDigest !== null || typeof log.content !== 'string' || log.sha256 !== sha256(log.content)
    || log.bytes !== Buffer.byteLength(log.content, 'utf8')) return { cause: 'PLAN_LOG_RECEIPT_INVALID' };
  const plans = log.content.split(/\r?\n/).map(line => parse(line.slice(Math.max(line.indexOf('{'), 0))))
    .filter(x => x?.schema === 'ops.jev.issue-actions-receipt.v1' && x.stage === 'plan');
  if (plans.length !== 1) return { cause: plans.length ? 'PLAN_RECEIPT_AMBIGUOUS' : 'PLAN_RECEIPT_MISSING' };
  const [p] = plans;
  if (accept === 'REFUSED_CJK' || accept === 'REFUSED_CJK_SUBJECT') {
    const issueRoute = accept === 'REFUSED_CJK_SUBJECT';
    if (!exact(p, REFUSAL_RECEIPT_KEYS) || p.outcome !== 'NONE' || p.cause !== 'UNSUPPORTED_CJK' || p.claimed !== false || p.providerCalls !== 0
      || p.authority !== false || !positive(p.commentId) || !exact(p.run, ['id', 'number', 'attempt', 'workflowId'])
      || !exact(p.observed, ['issueNodeId', 'subjectRevision', ...(issueRoute ? ['subject'] : [])]) || !text(p.observed.issueNodeId) || !text(p.observed.subjectRevision)
      || (issueRoute && (!exact(p.observed.subject, ['nodeId', 'revision']) || !text(p.observed.subject.nodeId) || !text(p.observed.subject.revision)))) {
      return { cause: 'PLAN_RECEIPT_NOT_REFUSED_CJK' };
    }
    return { plan: p };
  }
  if (p.outcome !== 'PLANNED' || !positive(p.commentId) || !exact(p.run, ['id', 'number', 'attempt', 'workflowId'])
    || !/^[0-9a-f]{64}$/.test(p.requestDigest ?? '')) return { cause: 'PLAN_RECEIPT_NOT_PLANNED' };
  return { plan: p };
}

// Each step's `with:` block, as {uses, repository, ref} (null when absent), read by indentation, plus the number of
// `actions/checkout` steps. Nothing else is interpreted.
function withBlocks(workflow) {
  const lines = workflow.split(/\r?\n/), blocks = [];
  let uses = null, checkouts = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-\s/.test(lines[i])) uses = null;
    const step = /^\s*(?:-\s+)?uses:\s*(\S+)\s*$/.exec(lines[i]);
    if (step) { uses = step[1]; if (uses.startsWith('actions/checkout@')) checkouts++; }
    const open = /^(\s*)with:\s*$/.exec(lines[i]);
    if (!open) continue;
    const block = { uses, repository: null, ref: null };
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || /^\s*/.exec(lines[j])[0].length > open[1].length); j++) {
      const kv = /^\s*(repository|ref):\s*(\S+)\s*$/.exec(lines[j]);
      if (kv) block[kv[1]] = kv[2];
    }
    blocks.push(block);
  }
  return { blocks, checkouts };
}

// N-a: the expected old-literal origin is derived only when the observations agree: the approved posting response,
// the public readback of that command comment, the public run metadata and the workflow file at the run's exact
// head_sha, all tied to the executor's own plan receipt (commentId and run). The run's workflow must also be
// byte-identical to the same path at the caller-approved activation commit, read the same way. Actor, time proximity
// or the final result's self-identity are never used to bind a run to a command. The code certifies consistency only.
// Shared by expectedOrigin and refusalOrigin; only the accepted plan receipt differs.
function bindRun({ approved, postingResponse, commandReceipt, runReceipt, workflowReceipt, activationWorkflowReceipt, planLog }, accept) {
  if (!exact(approved, ['repository', 'number', 'principal', 'commandBody', 'workflowId', 'workflowPath', 'runRange', 'runtimeSource', 'activationCommit'])
    || !REPOSITORY.test(approved.repository) || !positive(approved.number) || !text(approved.principal) || !text(approved.commandBody)
    || !positive(approved.workflowId) || !text(approved.workflowPath) || !exact(approved.runRange, ['first', 'last'])
    || !positive(approved.runRange.first) || !(approved.runRange.last >= approved.runRange.first) || !SHA1.test(approved.runtimeSource)
    || !SHA1.test(approved.activationCommit)) return hold('APPROVED_ORIGIN_INVALID');
  if (!exact(postingResponse, ['id']) || !positive(postingResponse.id)) return hold('POSTING_RESPONSE_MISSING');
  const { plan, cause } = planStageReceipt(planLog, accept);
  if (!plan) return hold(cause);
  for (const receipt of [commandReceipt, runReceipt, workflowReceipt, activationWorkflowReceipt]) if (receipt?.status !== 'OK') return hold(inputCause(receipt));
  const cmd = okJson(commandReceipt), run = okJson(runReceipt);
  if (!cmd || !run) return hold('INPUT_UNREADABLE');
  if (cmd.id !== postingResponse.id || plan.commentId !== postingResponse.id) return hold('COMMAND_MISMATCH');
  if (cmd.user?.login !== approved.principal) return hold('PRINCIPAL_MISMATCH');
  if (cmd.body !== approved.commandBody) return hold('COMMAND_BODY_MISMATCH');
  if (typeof cmd.issue_url !== 'string' || !cmd.issue_url.endsWith(`/repos/${approved.repository}/issues/${approved.number}`)) return hold('TARGET_MISMATCH');
  if (run.id !== plan.run.id || run.run_number !== plan.run.number || run.run_attempt !== plan.run.attempt || run.run_attempt !== 1
    || run.workflow_id !== plan.run.workflowId || run.workflow_id !== approved.workflowId || run.path !== approved.workflowPath
    || run.event !== 'issue_comment' || run.repository?.full_name !== approved.repository || !SHA1.test(run.head_sha ?? '')) return hold('RUN_MISMATCH');
  if (run.run_number < approved.runRange.first || run.run_number > approved.runRange.last) return hold('RUN_OUTSIDE_RANGE');
  // The workflow bytes must come from exactly the approved repository, at the run's head_sha, at the approved path.
  const raw = commit => `https://raw.githubusercontent.com/${approved.repository}/${commit}/${approved.workflowPath}`;
  if (workflowReceipt.url !== raw(run.head_sha)) return hold('WORKFLOW_NOT_AT_RUN_HEAD');
  // R-A7: the run's workflow must be byte-identical to the workflow at the caller-approved activation commit. Text
  // heuristics cannot see every way a later step could replace the pinned runtime (quoted or commented uses, other
  // spellings, run: git checkout), so equality with the reviewed bytes is the guarantee; the checks below only add to it.
  if (activationWorkflowReceipt.url !== raw(approved.activationCommit)) return hold('ACTIVATION_WORKFLOW_NOT_CANONICAL');
  if (workflowReceipt.content !== activationWorkflowReceipt.content || workflowReceipt.sha256 !== activationWorkflowReceipt.sha256) {
    return hold('WORKFLOW_DRIFT_FROM_ACTIVATION');
  }
  // The checkout pin counts only inside a with: block that checks out the approved repository; any other
  // checkout repository, or a ref pin without one, is not the approved runtime.
  const { blocks, checkouts } = withBlocks(workflowReceipt.content);
  if (blocks.some(b => b.repository !== null && b.repository !== approved.repository) || blocks.some(b => b.ref !== null && b.repository === null)) {
    return hold('CHECKOUT_REPOSITORY_MISMATCH');
  }
  // Exactly one checkout step, and it is the pinned one: any further checkout (with or without with:, any path)
  // could replace the pinned runtime bytes in the workspace with a mutable ref.
  const pinned = blocks.filter(b => b.ref !== null);
  if (checkouts !== 1 || pinned.length !== 1 || !pinned[0].uses?.startsWith('actions/checkout@')) return hold('CHECKOUT_STEP_MISMATCH');
  const pins = [...blocks.filter(b => b.ref !== null).map(b => b.ref),
    ...[...workflowReceipt.content.matchAll(/^\s*runtime_source=(\S+)\s*$/gm)].map(m => m[1])];
  if (pins.length !== 2 || pins.some(pin => pin !== approved.runtimeSource)) return hold('RUNTIME_PIN_MISMATCH');
  return { plan, run };
}

const ORIGIN_LIMITS = ['plan receipt bytes are a P-transported job log without a provider digest; they are only cross-checked here',
  'the activation commit is a caller-approved fact from the phase contract; this code does not review the activation workflow itself'];

export function expectedOrigin(args) {
  const bound = bindRun(args, 'PLANNED');
  if (!bound.plan) return bound;
  const { plan, run } = bound, { approved, postingResponse, workflowReceipt, planLog } = args;
  return { status: 'BOUND', expected: { commandCommentId: postingResponse.id, runId: run.id, executionSource: approved.runtimeSource },
    origin: { runNumber: run.run_number, runHeadSha: run.head_sha, activationCommit: approved.activationCommit, workflowSha256: workflowReceipt.sha256,
      planLogSha256: planLog.sha256, planRequestDigest: plan.requestDigest },
    limits: [...ORIGIN_LIMITS] };
}

// C1: the origin of a literal CJK refusal. The executor refused before any claim or result comment, so the only record
// of the subject state it observed is its plan receipt's `observed`. The same N-a bindings apply and the approved command
// must be the literal one. The result is a distinct kind with no request digest and no `expected`, so it cannot stand in
// for expectedOrigin, and refusalIdentitySnapshot accepts nothing else. issueRefusalOrigin is the same for the Issue
// route's refusal: its own kind, and a plan observation that also carries the evaluated subject's own pair.
function boundRefusal(args, accept, kind) {
  const bound = bindRun(args, accept);
  if (!bound.plan) return bound;
  const { plan, run } = bound, { approved, postingResponse, commandReceipt, runReceipt, workflowReceipt, activationWorkflowReceipt, planLog } = args;
  if (approved.commandBody !== LITERAL_COMMAND) return hold('COMMAND_NOT_LITERAL');
  const { observed } = plan;
  return { status: 'BOUND', kind, target: { repository: approved.repository, number: approved.number },
    planObservation: { issueNodeId: observed.issueNodeId, subjectRevision: observed.subjectRevision,
      ...(kind === ISSUE_REFUSAL_KIND ? { subject: { nodeId: observed.subject.nodeId, revision: observed.subject.revision } } : {}) },
    // Repeats the caller's reader-port declarations for the public reads only; the job log has no reader and stays weak.
    readerDeclaredLive: [commandReceipt, runReceipt, workflowReceipt, activationWorkflowReceipt].every(r => r.reader.mode === 'live'),
    origin: { commandCommentId: postingResponse.id, runId: run.id, runNumber: run.run_number, runHeadSha: run.head_sha,
      executionSource: approved.runtimeSource, activationCommit: approved.activationCommit, workflowSha256: workflowReceipt.sha256, planLogSha256: planLog.sha256 },
    limits: [...ORIGIN_LIMITS,
      'the observation is the executor\'s subject state when it refused, not a later read: a public read cannot see an edit that restores the same body, and only a later provided admission recomputes the revision',
      'a refusal does not show that the body is CJK; that the activated runtime prints this receipt is a phase fact this code cannot certify'] };
}
export function refusalOrigin(args) { return boundRefusal(args, 'REFUSED_CJK', REFUSAL_KIND); }
export function issueRefusalOrigin(args) { return boundRefusal(args, 'REFUSED_CJK_SUBJECT', ISSUE_REFUSAL_KIND); }

// N1 for a literal CJK refusal: node and body come only from the public PR, the edit signals only from the refusal's
// observation, through the same revision parser as the result path. Node equality is required three ways.
export function refusalIdentitySnapshot({ origin, pullRequestReceipt, target }) {
  if (!exact(target, ['repository', 'number']) || !REPOSITORY.test(target.repository) || !positive(target.number)) return hold('TARGET_INVALID');
  if (origin?.status !== 'BOUND' || origin.kind !== REFUSAL_KIND) return hold('ORIGIN_KIND_MISMATCH');
  if (origin.target?.repository !== target.repository || origin.target.number !== target.number) return hold('TARGET_MISMATCH');
  const pr = pullRequestFrom(pullRequestReceipt, target);
  if (pr.status !== 'OK') return pr;
  const { pullRequest } = pr, observed = origin.planObservation;
  if (observed?.issueNodeId !== pullRequest.nodeId || typeof observed.subjectRevision !== 'string') return hold('EXECUTOR_IDENTITY_MISMATCH');
  const { snapshot, cause } = snapshotFromRevision(observed.subjectRevision, pullRequest, target.number);
  if (!snapshot) return hold(cause);
  return { status: 'VERIFIED', target: { ...target }, snapshot,
    readerDeclaredLive: origin.readerDeclaredLive === true && pullRequestReceipt.reader.mode === 'live',
    origin: { kind: REFUSAL_KIND, ...origin.origin } };
}

// N1 on the Issue route, JA branch: the Issue route's refusal origin and its approved origin Issue, plus the approved
// subject Issue. The subject snapshot comes only from the observation's subject pair; the origin pair binds the origin.
export function issueRefusalSubjectSnapshot({ origin, originIssueReceipt, subjectIssueReceipt, subjectTarget }) {
  if (!subjectTargetValid(subjectTarget)) return hold('TARGET_INVALID');
  if (origin?.status !== 'BOUND' || origin.kind !== ISSUE_REFUSAL_KIND || !targetValid(origin.target) || !Array.isArray(origin.limits)) return hold('ORIGIN_KIND_MISMATCH');
  const read = readIssues(originIssueReceipt, origin.target, subjectIssueReceipt, subjectTarget);
  if (read.status !== 'OK') return read;
  const observed = origin.planObservation;
  if (!exact(observed, ['issueNodeId', 'subjectRevision', 'subject']) || !exact(observed.subject, ['nodeId', 'revision'])) return hold('EXECUTOR_IDENTITY_MISMATCH');
  const bound = bindIssues(read, origin.target, subjectTarget, { nodeId: observed.issueNodeId, revision: observed.subjectRevision }, observed.subject);
  if (bound.status === 'HOLD') return bound;
  return { status: 'VERIFIED', subjectKind: 'issue', originTarget: bound.originTarget, target: bound.target, snapshot: bound.snapshot,
    readerDeclaredLive: origin.readerDeclaredLive === true && [originIssueReceipt, subjectIssueReceipt].every(r => r.reader.mode === 'live'),
    provenance: { kind: ISSUE_REFUSAL_KIND, originRevision: observed.subjectRevision, subjectTarget: { ...subjectTarget }, origin: { ...origin.origin },
      limits: [...origin.limits, READER_LIMIT] } };
}

const FIDELITY_MARKER = '<!-- semlint-fidelity-v1 -->';

// N-e: a fidelity record is taken only from the approved review ID on the approved PR, from one marked, closed JSON
// block that names the exact envelope digest and every projected check. The GitHub author is a shared account, so the
// R origin stays a caller-declared reference here; actual R identity is checked by the live-phase R readback.
// `rendering: true` (the projection carries a subject englishAuxiliary) requires the v2 block under the same marker, which
// adds only R's renderingVerdict; envelopeSha256 already binds the original body, its span and digest and the English text.
export function fidelityFromReview({ approved, reviewReceipt, envelopeSha256, checkIds, rendering = false }) {
  if (!exact(approved, ['repository', 'number', 'reviewId', 'rOrigin']) || !REPOSITORY.test(approved.repository) || !positive(approved.number)
    || !positive(approved.reviewId) || !exact(approved.rOrigin, ['session', 'goRef']) || !text(approved.rOrigin.session) || !text(approved.rOrigin.goRef)) {
    return hold('APPROVED_REVIEW_INVALID');
  }
  if (!/^[0-9a-f]{64}$/.test(envelopeSha256 ?? '') || !Array.isArray(checkIds) || !checkIds.length || new Set(checkIds).size !== checkIds.length
    || typeof rendering !== 'boolean') return hold('PROJECTION_INVALID');
  if (reviewReceipt?.status !== 'OK') return hold(inputCause(reviewReceipt));
  const review = okJson(reviewReceipt);
  if (review?.id !== approved.reviewId || typeof review.pull_request_url !== 'string'
    || !review.pull_request_url.endsWith(`/repos/${approved.repository}/pulls/${approved.number}`) || typeof review.body !== 'string') return hold('REVIEW_MISMATCH');
  const blocks = review.body.split(FIDELITY_MARKER);
  if (blocks.length !== 2) return hold(blocks.length > 2 ? 'FIDELITY_MARKER_DUPLICATE' : 'FIDELITY_MARKER_MISSING');
  const fenced = /^\s*```json\n([\s\S]*?)\n```/.exec(blocks[1]), value = fenced && parse(fenced[1]);
  if (!exact(value, ['schema', 'envelopeSha256', 'verdicts', ...(rendering ? ['renderingVerdict'] : [])])
    || value.schema !== (rendering ? 'ops.goal-evaluation.fidelity.v2' : 'ops.goal-evaluation.fidelity.v1')) return hold('FIDELITY_BLOCK_INVALID');
  if (value.envelopeSha256 !== envelopeSha256) return hold('FIDELITY_DIGEST_MISMATCH');
  if (!exact(value.verdicts, checkIds) || checkIds.some(id => !VERDICTS.includes(value.verdicts[id]))) return hold('FIDELITY_CHECKS_MISMATCH');
  if (rendering && !VERDICTS.includes(value.renderingVerdict)) return hold('FIDELITY_RENDERING_INVALID');
  return { status: 'RECORDED',
    record: { reviewRef: `https://github.com/${approved.repository}/pull/${approved.number}#pullrequestreview-${approved.reviewId}`,
      envelopeSha256, verdicts: { ...value.verdicts }, ...(rendering ? { renderingVerdict: value.renderingVerdict } : {}) },
    rOriginDeclared: { ...approved.rOrigin },
    limits: ['shared GitHub author; R origin is a caller-declared reference until the live R readback'] };
}

// Explicit finite native product caller; importing does not start an operation.
export { bindNativeProductCaller } from './native-caller.mjs';

// Local preparation only: preserve the complete projection beside its exact, optional command.
export function prepareMain(args = process.argv.slice(2)) {
  const [inputFile, outputDirectory, extra] = args;
  if (!inputFile || !outputDirectory || extra !== undefined) throw new Error('INVALID_PREPARE_ARGS');
  const input = JSON.parse(readFileSync(inputFile, 'utf8'));
  if (!exact(input, ['plan', 'subject']) && !exact(input, ['plan', 'subject', 'options'])) throw new Error('INVALID_PREPARE_INPUT');
  const options = input.options === undefined ? {} : input.options;
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new Error('INVALID_PREPARE_INPUT');
  const projection = project(input.plan, input.subject, options);
  const artifact = JSON.stringify(projection) + '\n';
  mkdirSync(outputDirectory, { mode: 0o700 });
  writeFileSync(join(outputDirectory, 'projection.json'), artifact, { flag: 'wx', mode: 0o600 });
  const commandWritten = projection.emittable === true;
  if (commandWritten) writeFileSync(join(outputDirectory, 'command.txt'), projection.envelope, { flag: 'wx', mode: 0o600 });
  return { status: projection.status, emittable: commandWritten, postingAuthorized: false,
    projectionBytes: Buffer.byteLength(artifact), commandBytes: commandWritten ? Buffer.byteLength(projection.envelope) : null,
    notProjected: projection.notProjected?.length ?? null, missing: projection.missing?.length ?? null };
}

if (!process.execArgv.some(arg => arg === '-e' || arg === '--eval' || arg.startsWith('--eval='))
  && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(prepareMain()) + '\n'); }
  catch (error) {
    const code = ['EEXIST', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOSPC'].includes(error?.code) ? error.code : 'INVALID_INPUT';
    process.stderr.write(JSON.stringify({ status: 'ERROR', cause: 'PREPARATION_FAILED', code }) + '\n');
    process.exitCode = 1;
  }
}
