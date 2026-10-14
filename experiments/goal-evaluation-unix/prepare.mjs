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

const SHA1 = /^[0-9a-f]{40}$/;
const okJson = receipt => receipt?.status === 'OK' ? parse(receipt.content) : undefined;
const inputCause = receipt => 'INPUT_' + (receipt?.status ?? 'MISSING');

// The plan-stage receipt the existing executor prints to its job log (one JSON object per line, after the runner's
// timestamp). Logs are not publicly readable and carry no provider digest, so these bytes are a P transport that
// is only checked for internal digest consistency here; they never stand alone as proof.
function planStageReceipt(log) {
  if (!exact(log, ['ref', 'route', 'observedAt', 'bytes', 'sha256', 'content', 'providerDigest']) || log.route !== 'p-transported-job-log'
    || log.providerDigest !== null || typeof log.content !== 'string' || log.sha256 !== sha256(log.content)
    || log.bytes !== Buffer.byteLength(log.content, 'utf8')) return { cause: 'PLAN_LOG_RECEIPT_INVALID' };
  const plans = log.content.split(/\r?\n/).map(line => parse(line.slice(Math.max(line.indexOf('{'), 0))))
    .filter(x => x?.schema === 'ops.jev.issue-actions-receipt.v1' && x.stage === 'plan');
  if (plans.length !== 1) return { cause: plans.length ? 'PLAN_RECEIPT_AMBIGUOUS' : 'PLAN_RECEIPT_MISSING' };
  const [p] = plans;
  if (p.outcome !== 'PLANNED' || !positive(p.commentId) || !exact(p.run, ['id', 'number', 'attempt', 'workflowId'])
    || !/^[0-9a-f]{64}$/.test(p.requestDigest ?? '')) return { cause: 'PLAN_RECEIPT_NOT_PLANNED' };
  return { plan: p };
}

// Each step's `with:` block, as {repository, ref} (null when absent), read by indentation; nothing else is interpreted.
function withBlocks(workflow) {
  const lines = workflow.split(/\r?\n/), blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)with:\s*$/.exec(lines[i]);
    if (!open) continue;
    const block = { repository: null, ref: null };
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || /^\s*/.exec(lines[j])[0].length > open[1].length); j++) {
      const kv = /^\s*(repository|ref):\s*(\S+)\s*$/.exec(lines[j]);
      if (kv) block[kv[1]] = kv[2];
    }
    blocks.push(block);
  }
  return blocks;
}

// N-a: the expected old-literal origin is derived only when four observations agree: the approved posting response,
// the public readback of that command comment, the public run metadata and the workflow file at the run's exact
// head_sha, all tied to the executor's own plan receipt (commentId and run). Actor, time proximity or the final
// result's self-identity are never used to bind a run to a command. The code certifies consistency only.
export function expectedOrigin({ approved, postingResponse, commandReceipt, runReceipt, workflowReceipt, planLog }) {
  if (!exact(approved, ['repository', 'number', 'principal', 'commandBody', 'workflowId', 'workflowPath', 'runRange', 'runtimeSource'])
    || !REPOSITORY.test(approved.repository) || !positive(approved.number) || !text(approved.principal) || !text(approved.commandBody)
    || !positive(approved.workflowId) || !text(approved.workflowPath) || !exact(approved.runRange, ['first', 'last'])
    || !positive(approved.runRange.first) || !(approved.runRange.last >= approved.runRange.first) || !SHA1.test(approved.runtimeSource)) return hold('APPROVED_ORIGIN_INVALID');
  if (!exact(postingResponse, ['id']) || !positive(postingResponse.id)) return hold('POSTING_RESPONSE_MISSING');
  const { plan, cause } = planStageReceipt(planLog);
  if (!plan) return hold(cause);
  for (const receipt of [commandReceipt, runReceipt, workflowReceipt]) if (receipt?.status !== 'OK') return hold(inputCause(receipt));
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
  if (workflowReceipt.url !== `https://raw.githubusercontent.com/${approved.repository}/${run.head_sha}/${approved.workflowPath}`) return hold('WORKFLOW_NOT_AT_RUN_HEAD');
  // The checkout pin counts only inside a with: block that checks out the approved repository; any other
  // checkout repository, or a ref pin without one, is not the approved runtime.
  const blocks = withBlocks(workflowReceipt.content);
  if (blocks.some(b => b.repository !== null && b.repository !== approved.repository) || blocks.some(b => b.ref !== null && b.repository === null)) {
    return hold('CHECKOUT_REPOSITORY_MISMATCH');
  }
  const pins = [...blocks.filter(b => b.ref !== null).map(b => b.ref),
    ...[...workflowReceipt.content.matchAll(/^\s*runtime_source=(\S+)\s*$/gm)].map(m => m[1])];
  if (pins.length !== 2 || pins.some(pin => pin !== approved.runtimeSource)) return hold('RUNTIME_PIN_MISMATCH');
  return { status: 'BOUND', expected: { commandCommentId: postingResponse.id, runId: run.id, executionSource: approved.runtimeSource },
    origin: { runNumber: run.run_number, runHeadSha: run.head_sha, planLogSha256: planLog.sha256, planRequestDigest: plan.requestDigest },
    limits: ['plan receipt bytes are a P-transported job log without a provider digest; they are only cross-checked here'] };
}

const FIDELITY_MARKER = '<!-- semlint-fidelity-v1 -->';

// N-e: a fidelity record is taken only from the approved review ID on the approved PR, from one marked, closed JSON
// block that names the exact envelope digest and every projected check. The GitHub author is a shared account, so the
// R origin stays a caller-declared reference here; actual R identity is checked by the live-phase R readback.
export function fidelityFromReview({ approved, reviewReceipt, envelopeSha256, checkIds }) {
  if (!exact(approved, ['repository', 'number', 'reviewId', 'rOrigin']) || !REPOSITORY.test(approved.repository) || !positive(approved.number)
    || !positive(approved.reviewId) || !exact(approved.rOrigin, ['session', 'goRef']) || !text(approved.rOrigin.session) || !text(approved.rOrigin.goRef)) {
    return hold('APPROVED_REVIEW_INVALID');
  }
  if (!/^[0-9a-f]{64}$/.test(envelopeSha256 ?? '') || !Array.isArray(checkIds) || !checkIds.length || new Set(checkIds).size !== checkIds.length) return hold('PROJECTION_INVALID');
  if (reviewReceipt?.status !== 'OK') return hold(inputCause(reviewReceipt));
  const review = okJson(reviewReceipt);
  if (review?.id !== approved.reviewId || typeof review.pull_request_url !== 'string'
    || !review.pull_request_url.endsWith(`/repos/${approved.repository}/pulls/${approved.number}`) || typeof review.body !== 'string') return hold('REVIEW_MISMATCH');
  const blocks = review.body.split(FIDELITY_MARKER);
  if (blocks.length !== 2) return hold(blocks.length > 2 ? 'FIDELITY_MARKER_DUPLICATE' : 'FIDELITY_MARKER_MISSING');
  const fenced = /^\s*```json\n([\s\S]*?)\n```/.exec(blocks[1]), value = fenced && parse(fenced[1]);
  if (!exact(value, ['schema', 'envelopeSha256', 'verdicts']) || value.schema !== 'ops.goal-evaluation.fidelity.v1') return hold('FIDELITY_BLOCK_INVALID');
  if (value.envelopeSha256 !== envelopeSha256) return hold('FIDELITY_DIGEST_MISMATCH');
  if (!exact(value.verdicts, checkIds) || checkIds.some(id => !VERDICTS.includes(value.verdicts[id]))) return hold('FIDELITY_CHECKS_MISMATCH');
  return { status: 'RECORDED',
    record: { reviewRef: `https://github.com/${approved.repository}/pull/${approved.number}#pullrequestreview-${approved.reviewId}`,
      envelopeSha256, verdicts: { ...value.verdicts } },
    rOriginDeclared: { ...approved.rOrigin },
    limits: ['shared GitHub author; R origin is a caller-declared reference until the live R readback'] };
}
