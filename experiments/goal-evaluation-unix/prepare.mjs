// Caller-local real-input preparation: acquisition receipts, executor-identity subject snapshot and a faithful
// v14 provided-request projection. No client, auth, model, posting or Core change; readers are caller-owned ports.
import { createHash } from 'node:crypto';
import { REQUEST_PREFIX, RESULT_PREFIX, COMMAND_OBSERVATION, subjectRevision } from '../../packages/jev-review/github-comment.mjs';
import { EXECUTOR_LOGIN } from '../../packages/jev-review/issue-executor.mjs';
import { exact } from '../../packages/jev-review/semlint-entry.mjs';
import { checkPlan, unquotedGoalText } from './core.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hold = (cause, extra = {}) => ({ status: 'HOLD', cause, emittable: false, ...extra });
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SCOPE = 'entire body of the approved pull request at the observed revision';
const MAX_CHECKS = 6;
const VERDICTS = ['FAITHFUL', 'UNFAITHFUL', 'UNKNOWN'];

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

// N1: the subject snapshot comes only from the existing executor's admitted old-literal result for the caller's
// own expected command/run/runtime. Author, marker, closed envelope, identity and body digest are all checked.
// readerDeclaredLive repeats the caller's reader declaration; it is not evidence that an actual read happened.
export function executorIdentitySnapshot({ commentsReceipt, pullRequestReceipt, target, expected }) {
  if (!exact(target, ['repository', 'number']) || !REPOSITORY.test(target.repository) || !positive(target.number)) return hold('TARGET_INVALID');
  if (!exact(expected, ['commandCommentId', 'runId', 'executionSource']) || !positive(expected.commandCommentId) || !positive(expected.runId)
    || typeof expected.executionSource !== 'string' || !/^[0-9a-f]{40}$/.test(expected.executionSource)) return hold('EXPECTED_ORIGIN_MISSING');
  const pr = pullRequestFrom(pullRequestReceipt, target);
  if (pr.status !== 'OK') return pr;
  if (commentsReceipt?.status !== 'OK' || commentsReceipt.complete !== true) return hold('INPUT_' + (commentsReceipt?.status === 'OK' ? 'INCOMPLETE' : commentsReceipt?.status ?? 'MISSING'));
  const comments = parse(commentsReceipt.content);
  if (!Array.isArray(comments)) return hold('COMMENTS_UNREADABLE');
  const results = comments.filter(c => c?.user?.login === EXECUTOR_LOGIN && typeof c.body === 'string' && c.body.startsWith(RESULT_PREFIX))
    .map(c => ({ comment: c, envelope: parse(c.body.slice(RESULT_PREFIX.length)) }))
    .filter(({ envelope }) => envelope?.identity?.commentId === expected.commandCommentId);
  if (results.length !== 1) return hold(results.length ? 'EXECUTOR_RESULT_AMBIGUOUS' : 'REVISION_UNOBSERVED');
  const [{ comment, envelope }] = results, id = envelope.identity, { pullRequest } = pr;
  if (!exact(envelope, ['schema', 'requestDigest', 'identity', 'authority', 'result']) || envelope.schema !== 'ops.jev.issue-result.v1'
    || envelope.authority !== false || id?.repository !== target.repository || id.issue !== target.number || id.targetKind !== 'pull-request'
    || id.observation !== COMMAND_OBSERVATION || id.run?.id !== expected.runId || id.executionSource !== expected.executionSource
    || id.issueNodeId !== pullRequest.nodeId || typeof id.subjectRevision !== 'string') return hold('EXECUTOR_IDENTITY_MISMATCH');
  const parts = id.subjectRevision.split('|');
  if (parts.length !== 5 || parts[0] !== pullRequest.nodeId) return hold('EXECUTOR_IDENTITY_MISMATCH');
  if (parts[1] !== 'sha256:' + sha256(pullRequest.body)) return hold('SUBJECT_DRIFT');
  if (!(parts[2] === 'unedited' || Number.isFinite(Date.parse(parts[2]))) || !/^(0|[1-9][0-9]*)$/.test(parts[3]) || !['true', 'false'].includes(parts[4])) {
    return hold('EXECUTOR_IDENTITY_MISMATCH');
  }
  const snapshot = { number: target.number, nodeId: pullRequest.nodeId, body: pullRequest.body, lastEditedAt: parts[2] === 'unedited' ? null : parts[2],
    includesCreatedEdit: parts[4] === 'true', userContentEditsTotal: Number(parts[3]) };
  if (subjectRevision(snapshot) !== id.subjectRevision) return hold('EXECUTOR_IDENTITY_MISMATCH');
  return { status: 'VERIFIED', target: { ...target }, snapshot,
    readerDeclaredLive: [commentsReceipt, pullRequestReceipt].every(r => r.reader.mode === 'live'),
    origin: { resultCommentId: comment.id, requestDigest: envelope.requestDigest, runId: expected.runId, commandCommentId: expected.commandCommentId } };
}

const unit = (fields, content) => ({ ...fields, content, sha256: sha256(content),
  evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(content, 'utf8') }, englishAuxiliary: null });

// The wire question always asks whether the problem criterion holds, so true=problem and false=ok cannot invert
// a question phrased in the ok direction. The plan's own question is quoted, not reworded.
const problemQuestion = q => `Does the problem criterion hold for this target, rather than the ok criterion? Original question: ${q.question}`;

// Fidelity is R's record about exact envelope bytes, supplied from outside; this code never assigns a verdict.
function fidelityOf(record, envelopeSha256, ids) {
  if (record === undefined) return { verdicts: Object.fromEntries(ids.map(id => [id, 'UNREVIEWED'])), allFaithful: false };
  if (!exact(record, ['reviewRef', 'envelopeSha256', 'verdicts']) || !text(record.reviewRef) || record.envelopeSha256 !== envelopeSha256
    || !exact(record.verdicts, ids) || ids.some(id => !VERDICTS.includes(record.verdicts[id]))) throw new Error('FIDELITY_RECORD_MISMATCH');
  return { reviewRef: record.reviewRef, verdicts: { ...record.verdicts }, allFaithful: ids.every(id => record.verdicts[id] === 'FAITHFUL') };
}

// Faithful binary projection of obligation-bound questions without needs. Goal and clause text stay local:
// the wire carries only the subject and the English predicates; a CJK Goal is kept as ref and digest.
export function project(planValue, subject, { fidelity, ...planLimits } = {}) {
  const value = checkPlan(planValue, planLimits);
  const checks = [], mapping = [], notProjected = [];
  for (const q of value.questions) {
    if (q.needs.length) { notProjected.push({ id: q.id, reason: 'INCOMPLETE', needs: q.needs, clauseIds: q.clauseIds }); continue; }
    if (checks.length === MAX_CHECKS) { notProjected.push({ id: q.id, reason: 'LIMIT', clauseIds: q.clauseIds }); continue; }
    checks.push({ id: q.id, axis: 'Aligned', concern: `Goal-derived question ${q.id}.`, requiredRoles: [], crossLinks: [],
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
    goal: { ref: goal.ref, sha256: sha256(goal.content), onWire: !CJK.test(goal.content) } };
  if (!value.clauses.some(c => c.kind === 'obligation')) return hold('NEED_CLARIFICATION', base);
  if (subject?.status !== 'VERIFIED' || !exact(subject.target, ['repository', 'number']) || !REPOSITORY.test(subject.target.repository)
    || subject.target.number !== subject.snapshot?.number) return hold(subject?.cause ?? 'REVISION_UNOBSERVED', base);
  if (!checks.length) return hold('NOTHING_PROJECTED', base);
  const { snapshot, target } = subject;
  const input = { schema: 'ops.semlint.input.v14',
    subject: unit({ kind: 'log-entry', ref: `https://github.com/${target.repository}/pull/${target.number}`, revision: subjectRevision(snapshot), scope: SCOPE }, snapshot.body),
    context: base.goal.onWire ? [unit({ role: 'goal', ref: goal.ref, revision: 'sha256:' + base.goal.sha256 }, goal.content)] : [],
    checks };
  if (CJK.test(JSON.stringify(input))) return { status: 'UNSUPPORTED_CJK', emittable: false, ...base };
  const envelope = REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: [{ id: 'pull-request', input }] });
  const envelopeSha256 = sha256(envelope);
  const review = fidelityOf(fidelity, envelopeSha256, checks.map(c => c.id));
  return { status: 'ELIGIBLE', emittable: subject.readerDeclaredLive === true && review.allFaithful, ...base, envelope, envelopeSha256,
    fidelity: review, postingAuthorized: false };
}
