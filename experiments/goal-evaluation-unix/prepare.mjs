// Caller-local real-input preparation: acquisition receipts, executor-identity subject snapshot and a faithful
// v14 provided-request projection. No client, auth, model, posting or Core change; readers are caller-owned ports.
import { createHash } from 'node:crypto';
import { REQUEST_PREFIX, RESULT_PREFIX, COMMAND_OBSERVATION, subjectRevision } from '../../packages/jev-review/github-comment.mjs';
import { EXECUTOR_LOGIN } from '../../packages/jev-review/issue-executor.mjs';
import { exact } from '../../packages/jev-review/semlint-entry.mjs';
import { checkPlan } from './core.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hold = (cause, extra = {}) => ({ status: 'HOLD', cause, emittable: false, ...extra });
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SCOPE = 'entire body of the approved pull request at the observed revision';
const MAX_CHECKS = 6;

// One receipt per acquisition. Only HTTP 200 with non-empty text is OK; 404 is NOT_FOUND; anything else,
// including 403/429/5xx, a thrown reader or an empty body, is UNKNOWN. A receipt is an observation, not a fact.
export async function acquire({ ref, url }, reader, now = () => new Date().toISOString()) {
  if (!text(ref) || !text(url) || !reader || !text(reader.id) || !['live', 'test-double'].includes(reader.mode) || typeof reader.get !== 'function') {
    throw new Error('INVALID_READER');
  }
  const base = { ref, url, reader: { id: reader.id, mode: reader.mode }, observedAt: now() };
  let response;
  try { response = await reader.get(url); } catch { return { ...base, httpStatus: null, status: 'UNKNOWN', bytes: null, sha256: null, content: null }; }
  const httpStatus = Number.isSafeInteger(response?.status) ? response.status : null;
  const body = typeof response?.text === 'string' ? response.text : null;
  const status = httpStatus === 200 && text(body) ? 'OK' : httpStatus === 404 ? 'NOT_FOUND' : 'UNKNOWN';
  return { ...base, httpStatus, status, ...(status === 'OK'
    ? { bytes: Buffer.byteLength(body, 'utf8'), sha256: sha256(body), content: body }
    : { bytes: null, sha256: null, content: null }) };
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
// own expected command/run/runtime. Author, marker, closed envelope, identity and body digest are all checked;
// emittable additionally requires live readers. Labels or self-declared provenance never make it emittable.
export function executorIdentitySnapshot({ commentsReceipt, pullRequestReceipt, target, expected }) {
  if (!exact(expected, ['commandCommentId', 'runId', 'executionSource']) || !positive(expected.commandCommentId) || !positive(expected.runId)
    || typeof expected.executionSource !== 'string' || !/^[0-9a-f]{40}$/.test(expected.executionSource)) return hold('EXPECTED_ORIGIN_MISSING');
  const pr = pullRequestFrom(pullRequestReceipt, target);
  if (pr.status !== 'OK') return pr;
  if (commentsReceipt?.status !== 'OK') return hold('INPUT_' + (commentsReceipt?.status ?? 'MISSING'));
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
  return { status: 'VERIFIED', emittable: [commentsReceipt, pullRequestReceipt].every(r => r.reader.mode === 'live'), snapshot,
    origin: { resultCommentId: comment.id, requestDigest: envelope.requestDigest, runId: expected.runId, commandCommentId: expected.commandCommentId } };
}

const unit = (fields, content) => ({ ...fields, content, sha256: sha256(content),
  evaluationSpan: { startByte: 0, endByte: Buffer.byteLength(content, 'utf8') }, englishAuxiliary: null });

// Faithful binary projection: an obligation-bound question without needs becomes predicate problem->true, ok->false.
// The unknown criterion is never lowered; nothing is translated; the whole case is checked for CJK.
export function project(planValue, subject, { repository, ...planLimits }) {
  const value = checkPlan(planValue, planLimits);
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('INVALID_REPOSITORY');
  if (!value.clauses.some(c => c.kind === 'obligation')) return hold('NEED_CLARIFICATION');
  if (subject?.status !== 'VERIFIED') return hold(subject?.cause ?? 'REVISION_UNOBSERVED');
  const checks = [], mapping = [], notProjected = [];
  for (const q of value.questions) {
    if (q.needs.length) { notProjected.push({ id: q.id, reason: 'INCOMPLETE', needs: q.needs }); continue; }
    if (checks.length === MAX_CHECKS) { notProjected.push({ id: q.id, reason: 'LIMIT' }); continue; }
    checks.push({ id: q.id, axis: 'Aligned', concern: `Goal-derived question ${q.id} for clauses ${q.clauseIds.join(', ')}.`,
      requiredRoles: [], crossLinks: [], predicate: { question: q.question, true: q.criteria.problem, false: q.criteria.ok } });
    mapping.push({ id: q.id, clauses: value.clauses.filter(c => q.clauseIds.includes(c.id)), true: 'problem', false: 'ok',
      notLowered: { unknown: q.criteria.unknown }, fidelity: 'UNREVIEWED' });
  }
  const base = { checks, mapping, notProjected };
  if (!checks.length) return hold('NOTHING_PROJECTED', base);
  const goal = value.request.goal, used = value.clauses.filter(c => mapping.some(m => m.clauses.includes(c)));
  const { snapshot } = subject;
  const input = { schema: 'ops.semlint.input.v14',
    subject: unit({ kind: 'log-entry', ref: `https://github.com/${repository}/pull/${snapshot.number}`, revision: subjectRevision(snapshot), scope: SCOPE }, snapshot.body),
    context: [unit({ role: 'goal', ref: goal.ref, revision: 'sha256:' + sha256(goal.content) }, goal.content),
      unit({ role: 'goalClauses', ref: goal.ref + '#clauses', revision: 'sha256:' + sha256(JSON.stringify(used)) }, JSON.stringify(used))],
    checks };
  if (CJK.test(JSON.stringify(input))) return { status: 'UNSUPPORTED_CJK', emittable: false, ...base };
  const envelope = REQUEST_PREFIX + JSON.stringify({ schema: 'ops.jev.issue-request.v1', cases: [{ id: 'pull-request', input }] });
  return { status: 'ELIGIBLE', emittable: subject.emittable, ...base, envelope, envelopeSha256: sha256(envelope),
    fidelity: 'UNREVIEWED', postingAuthorized: false };
}
