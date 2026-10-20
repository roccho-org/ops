import { createHash } from 'node:crypto';
import { ENTRY_LIMITS, preparePlan, entryLimits, digest, exact, snapshotJson, validateOwnerResult } from './semlint-entry.mjs';
import { JEV_MODEL } from './core.mjs';

export const REQUEST_PREFIX = '/jev-evaluate\n';
export const RESULT_PREFIX = '<!-- ops-jev-result-v1 -->\n';
const RESULT_BYTE_CAP = 32768;
const REPORT_EXPLANATION = "Jev supplies the model observations shown here; semlint formats and posts this report. The tool that prepared the checks is not recorded here. See the linked request for the questions and conditions.\n\n";
const EVIDENCE_OPEN = '<details>\n<summary>Execution evidence</summary>\n\n```json\n';
const EVIDENCE_CLOSE = '```\n</details>\n';
const resultJSON = envelope => RESULT_PREFIX + JSON.stringify(envelope) + '\n';
const code = value => '<code>' + String(value).replace(/[^A-Za-z0-9 .-]/gu,
  char => '&#' + char.codePointAt(0) + ';') + '</code>';

// Display only the already public, bound result. A model observation is not a verified finding.
function resultComment(envelope, explain = true) {
  const identity = envelope.identity;
  if (identity.observation !== PROVIDED_COMMAND_OBSERVATION) return resultJSON(envelope);
  const origin = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository)
    && Number.isSafeInteger(identity.issue) && identity.issue > 0
    && Number.isSafeInteger(identity.commentId) && identity.commentId > 0
    ? `[Request and evaluation conditions](https://github.com/${identity.repository}/issues/${identity.issue}#issuecomment-${identity.commentId})`
    : `Request: ${code(envelope.requestDigest)}`;
  const rows = envelope.result.cases.flatMap(row => row.result.records.map(record =>
    `| ${code(row.id)} / ${code(record.rule)} | ${code(record.question)} | ${code(record.status)} | ${code(record.noul ?? 'not observed')} |`));
  return '### semlint: bounded evaluation\n\n' + origin + '\n\n'
    + (explain ? REPORT_EXPLANATION : '')
    + `Evaluated revision: ${code(identity.subject?.revision ?? identity.subjectRevision ?? 'not recorded')}\n\n`
    + '| Case / check | Axis | Status | Jev value |\n|---|---|---|---|\n' + rows.join('\n') + '\n\n'
    + 'OBSERVED means a model response was recorded, not that a claim is true or a change is required. '
    + 'Read the linked question, criteria and source scope before deciding what to change. '
    + 'Unobserved checks remain unresolved. No automatic approval or modification.\n\n'
    + EVIDENCE_OPEN + resultJSON(envelope) + EVIDENCE_CLOSE;
}

// Legacy JSON remains readable. The new display must match its evidence exactly;
// arbitrary prose, extra markers and modified summaries are not stripped or trusted.
export function parseResultComment(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > RESULT_BYTE_CAP) return null;
  try {
    if (body.startsWith(RESULT_PREFIX)) return JSON.parse(body.slice(RESULT_PREFIX.length));
    const marker = body.indexOf(RESULT_PREFIX);
    if (marker < 0 || !body.endsWith(EVIDENCE_CLOSE)) return null;
    const envelope = JSON.parse(body.slice(marker + RESULT_PREFIX.length, -EVIDENCE_CLOSE.length));
    return resultComment(envelope) === body || resultComment(envelope, false) === body ? envelope : null;
  } catch { return null; }
}
const sha = (x) => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const positive = (x) => Number.isSafeInteger(x) && x > 0;
const text = (x) => typeof x === 'string' && x.trim().length > 0;
const reject = (cause) => ({ status: 'NOT_ADMITTED', cause, authority: false });
const requests = new WeakSet();
const nonnegative = (x) => Number.isFinite(x) && x >= 0;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Semlint result editions the comment composer binds exactly (v1 and the v14 bundle); all others are refused at admission.
const COMPOSABLE_RESULTS = Object.freeze(['ops.semlint.result.v1', 'ops.semlint.result.v14']);

const baseConfigValid = (config, keys) => exact(config, keys)
  && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) && positive(config.issue)
  && Array.isArray(config.requesters) && config.requesters.length > 0 && config.requesters.every(text)
  && new Set(config.requesters).size === config.requesters.length && sha(config.executionSource);

// Config is an independently supplied trusted grant, never merged with comment JSON.
export async function admitIssueComment(eventValue, configValue) {
  let event, config, limits;
  try {
    event = snapshotJson(eventValue); config = snapshotJson(configValue);
    if (!baseConfigValid(config, ['repository', 'issue', 'requesters', 'executionSource', 'limits'])) return reject('INVALID_TRUSTED_CONFIG');
    limits = entryLimits(config.limits);
    if (!exact(event, ['repository', 'issue', 'action', 'comment'])
      || !exact(event.comment, ['id', 'author', 'revision', 'body']) || !positive(event.comment.id)
      || !text(event.comment.author) || !text(event.comment.revision) || typeof event.comment.body !== 'string') return reject('INVALID_EVENT');
  } catch { return reject('INVALID_EVENT_OR_CONFIG'); }
  if (event.repository !== config.repository || event.issue !== config.issue) return reject('TARGET_NOT_AUTHORIZED');
  if (event.action !== 'created') return reject('ACTION_NOT_AUTHORIZED');
  return admitBody(config, limits, event.comment.author, event.comment.body, (planDigest) => ({
    repository: event.repository, issue: event.issue, commentId: event.comment.id,
    author: event.comment.author, revision: event.comment.revision, bodyDigest: digest(event.comment.body),
    executionSource: config.executionSource, configDigest: digest(config), planDigest }));
}

// Shared requester/body/plan/size admission for webhook events and API snapshots.
async function admitBody(config, limits, author, body, identityOf) {
  if (!config.requesters.includes(author)) return reject('REQUESTER_NOT_AUTHORIZED');
  const parsed = await prepareIssueRequest(body, limits);
  if (parsed.cause) return reject(parsed.cause);
  return finishRequest(parsed.prepared, identityOf);
}

async function prepareIssueRequest(body, limits, validatePayload = null) {
  if (!body.startsWith(REQUEST_PREFIX)) return { cause: 'NOT_A_REQUEST' };
  if (Buffer.byteLength(body, 'utf8') > limits.maxInputBytes) return { cause: 'REQUEST_TOO_LARGE' };
  let prepared;
  try {
    const payload = JSON.parse(body.slice(REQUEST_PREFIX.length));
    if (!exact(payload, ['schema', 'cases']) || payload.schema !== 'ops.jev.issue-request.v1') return { cause: 'INVALID_REQUEST' };
    if (validatePayload !== null && !validatePayload(payload)) return { cause: 'INVALID_PROVIDED_REQUEST' };
    prepared = await preparePlan({ schema: 'ops.semlint.real-input.v1', cases: payload.cases }, limits);
  } catch { return { cause: 'INVALID_REQUEST_OR_ADMISSION' }; }
  return { prepared };
}

// Shared result-size admission and registration of an admitted request, for every admission path.
// subjectAuxiliary is true only for a provided request already matched to the granted target's observed snapshot.
function finishRequest(prepared, identityOf, subjectAuxiliary = false) {
  // Only result editions this composer binds exactly may be admitted; anything else is refused before any paid call.
  if (prepared.expected.some((x) => !COMPOSABLE_RESULTS.includes(x.resultSchema))) return reject('RESULT_EDITION_NOT_COMPOSABLE');
  // The runtime cannot verify an English rendering. Outside a granted provided request, any v14 English auxiliary
  // needs the frozen owner route; context auxiliaries are never accepted from a comment.
  // Checked on the Core-admitted snapshot, before identity, claim, owner, provider or comment.
  if (prepared.plan.cases.some(({ input }) => input.schema === 'ops.semlint.input.v14'
    && ((!subjectAuxiliary && input.subject.englishAuxiliary !== null)
      || input.context.some((row) => row.englishAuxiliary !== null)))) return reject('AUDITED_AUXILIARY_REQUIRES_OWNER_ROUTE');
  const identity = Object.freeze(identityOf(prepared.planDigest));
  const request = Object.freeze({ status: 'ADMITTED', identity, requestDigest: digest(identity), prepared, authority: false });
  // Known repeated record/identity strings plus a conservative scalar/accounting reserve per case.
  // This is size admission only, not a synthetic result or execution receipt.
  const projection = { schema: 'ops.jev.issue-result.v1', requestDigest: request.requestDigest, identity,
    authority: false, result: { schema: 'ops.semlint.real-result.v3', model: JEV_MODEL, planDigest: prepared.planDigest,
      cases: prepared.expected.map((x) => ({ id: x.id, result: { schema: x.resultSchema,
        inputDigest: x.inputDigest, questionDigest: x.questionDigest, records: x.records.map((r) => ({ ...r, noul: null })),
        counts: {}, accounting: {}, claimCeiling: 'BOUNDED_EVIDENCE_NOT_SEMANTIC_TRUTH_OR_AUTHORITY',
        ...(x.projection ? { projection: x.projection } : {}) }, provider: {},
        elapsedMs: Number.MAX_VALUE })), // longest finite clock rendering; size only, not a measurement
      accounting: {}, claimCeiling: 'BOUNDED_EVIDENCE_NOT_SEMANTIC_TRUTH_OR_AUTHORITY' } };
  // 3072 bytes covers canonical scalar/accounting plus the closed native receipt's enums,
  // SHA256 and counters (including up to three finite usage counters); 1024 covers totals.
  // No response body, arbitrary model string or answers are repeated in the receipt.
  const recordCount = prepared.expected.reduce((total, row) => total + row.records.length, 0);
  const maxOutputBytes = Buffer.byteLength(resultComment(projection), 'utf8')
    + 1024 + 3072 * prepared.plan.cases.length
    + (identity.observation === PROVIDED_COMMAND_OBSERVATION ? 256 * recordCount : 0);
  if (maxOutputBytes > RESULT_BYTE_CAP) return reject('RESULT_WOULD_EXCEED_COMMENT_CAP');
  requests.add(request);
  return request;
}

// Trusted Actions settings (reviewed source). Requester allowlist is never read from Issue data.
// Org Secret projection/target is outside this source; no executable, argv or program selector.
export const ACTIONS_CONFIG_KEYS = ['trustedCallers', 'allowedChecks', 'context', 'subjectScope', 'limits', 'runRanges', 'targets', 'provider'];
const RANGE_KEYS = ['repository', 'workflowId', 'path', 'first', 'last', 'reservedCallsPerRun'];
// Retired provided targets never regain a grant (legacy PR511, ended trial PR520, replaced PR522).
const RETIRED_PROVIDED = Object.freeze([511, 520, 522]);
// An optional range target is one closed {issue} or {pullRequest} of the range's own repository.
const rangeTarget = (t) => exact(t, ['issue']) && positive(t.issue) || exact(t, ['pullRequest']) && positive(t.pullRequest);
const scopes = (r, kind, number) => (Object.hasOwn(r.target, 'pullRequest')
  ? kind === 'pull-request' && r.target.pullRequest === number : kind === 'issue' && r.target.issue === number);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPO_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const freezeDeep = (x) => { if (x && typeof x === 'object') { Object.values(x).forEach(freezeDeep); Object.freeze(x); } return x; };
const databaseId = (x) => typeof x === 'string' && /^[1-9][0-9]*$/.test(x);
// An Issue target may name one read-only public subject Issue that is evaluated instead of the origin body. The
// subject is not an execution target or provider-receipt member: Org, command, range, claim, key and result sink stay
// with the origin. It may not be the origin Issue itself.
const subjectGrantValid = (s, origin) => exact(s, ['repository', 'repositoryId', 'kind', 'number'])
  && REPOSITORY.test(s.repository) && databaseId(s.repositoryId) && s.kind === 'issue' && positive(s.number)
  && !((s.repository === origin.repository || s.repositoryId === origin.repositoryId) && s.number === origin.issue);
function providerValid(value) {
  if (value === null) return true;
  if (!exact(value, ['repository', 'revision', 'path', 'receipt']) || !REPOSITORY.test(value.repository) || !sha(value.revision)
    || value.path !== 'handoffs/dev-jev-api.github-actions.json') return false;
  const r = value.receipt, t = r?.target;
  return exact(r, ['kind', 'source', 'binding', 'controller', 'created_at', 'operation', 'target', 'readback', 'provider_use'])
    && r.kind === 'envs.orgSecretProjectionReceipt.v1' && sha(r.source) && r.binding === 'jev-api.github-actions'
    && typeof r.controller === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(r.controller)
    && typeof r.created_at === 'string' && r.created_at.endsWith('Z') && Number.isFinite(Date.parse(r.created_at))
    && r.operation === 'github_org_secret_put' && r.readback === 'SECRET_NAME_AND_SELECTED_REPOSITORY_IDS' && r.provider_use === 'NOT_RUN'
    && exact(t, ['provider', 'organization', 'organization_id', 'secret_name', 'repositories', 'repository_ids'])
    && t.provider === 'github-org-secret' && typeof t.organization === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(t.organization)
    && value.repository === `${t.organization}/envs` && databaseId(t.organization_id)
    && t.secret_name === ['JEV', 'API', 'KEY'].join('_')
    && Array.isArray(t.repositories) && t.repositories.length > 0 && t.repositories.length <= 100
    && t.repositories.every((repo) => REPOSITORY.test(repo) && repo.startsWith(`${t.organization}/`))
    && new Set(t.repositories).size === t.repositories.length && Array.isArray(t.repository_ids)
    && t.repository_ids.length === t.repositories.length && t.repository_ids.every(databaseId)
    && new Set(t.repository_ids).size === t.repository_ids.length;
}
export function validateActionsConfig(value) {
  let config;
  try { config = snapshotJson(value); entryLimits(config.limits); } catch { throw new Error('INVALID_ACTIONS_CONFIG'); }
  const ranges = config.runRanges;
  if (!exact(config, [...ACTIONS_CONFIG_KEYS, ...(Object.hasOwn(config, 'providedRequestTargets') ? ['providedRequestTargets'] : [])]) || !text(config.subjectScope)
    || !Array.isArray(config.trustedCallers) || !config.trustedCallers.every((x) => typeof x === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(x))
    || new Set(config.trustedCallers).size !== config.trustedCallers.length
    || !Array.isArray(config.allowedChecks) || !config.allowedChecks.length || !config.allowedChecks.every(text)
    || new Set(config.allowedChecks).size !== config.allowedChecks.length
    || !Array.isArray(config.context) || !config.context.every((c) => exact(c, ['role', 'path']) && text(c.role) && REPO_PATH.test(c.path))
    || new Set(config.context.map((c) => JSON.stringify([c.role, c.path]))).size !== config.context.length
    || !providerValid(config.provider)
    || !Array.isArray(config.targets) || !config.targets.every((target) =>
      ((exact(target, ['repository', 'repositoryId', 'issue'])
        || exact(target, ['repository', 'repositoryId', 'issue', 'subject']) && subjectGrantValid(target.subject, target)) && positive(target.issue)
        || exact(target, ['repository', 'repositoryId', 'pullRequest']) && positive(target.pullRequest))
      && REPOSITORY.test(target.repository) && databaseId(target.repositoryId))
    || new Set(config.targets.map((target) => JSON.stringify(Object.hasOwn(target, 'pullRequest')
      ? [target.repository, 'pull-request', target.pullRequest] : [target.repository, 'issue']))).size !== config.targets.length
    || config.targets.filter((target) => Object.hasOwn(target, 'pullRequest')).length > 2
    || !Array.isArray(ranges) || !ranges.every((r) => (exact(r, RANGE_KEYS) || exact(r, [...RANGE_KEYS, 'target']) && rangeTarget(r.target)
      || exact(r, [...RANGE_KEYS, 'target', 'budgetClaimCommentId']) && rangeTarget(r.target)
        && positive(r.budgetClaimCommentId)
        && r.reservedCallsPerRun === 1 && config.limits.maxCalls === 1)
      && REPOSITORY.test(r.repository) && positive(r.workflowId)
      && WORKFLOW_PATH.test(r.path) && positive(r.first) && positive(r.last) && r.first <= r.last
      && positive(r.reservedCallsPerRun) && r.reservedCallsPerRun <= ENTRY_LIMITS.maxCalls)) throw new Error('INVALID_ACTIONS_CONFIG');
  for (const target of config.targets) {
    if (Object.hasOwn(target, 'pullRequest') && (target.repository.split('/')[1] !== 'ops'
      || config.targets.some((candidate) => Object.hasOwn(candidate, 'pullRequest')
        && (candidate.repository !== target.repository || candidate.repositoryId !== target.repositoryId)))) {
      throw new Error('INVALID_ACTIONS_CONFIG');
    }
    if (Object.hasOwn(target, 'pullRequest') && !config.targets.some((candidate) => candidate.repository === target.repository
      && candidate.repositoryId === target.repositoryId && Object.hasOwn(candidate, 'issue'))) throw new Error('INVALID_ACTIONS_CONFIG');
    if (config.targets.some((candidate) => (candidate.repository === target.repository) !== (candidate.repositoryId === target.repositoryId))) {
      throw new Error('INVALID_ACTIONS_CONFIG');
    }
  }
  // At most one provided grant in total: a PR body, or an origin Issue whose own subject grant (and so its own scoped
  // range) names the evaluated Issue. Retirement numbers are PR numbers and apply to the PR form only.
  if (Object.hasOwn(config, 'providedRequestTargets') && (!Array.isArray(config.providedRequestTargets)
    || config.providedRequestTargets.length > 1 || !config.providedRequestTargets.every((grant) =>
      exact(grant, ['repository', 'repositoryId', 'pullRequest']) && positive(grant.pullRequest)
      && !RETIRED_PROVIDED.includes(grant.pullRequest)
      && config.targets.some((target) => Object.hasOwn(target, 'pullRequest')
        && target.repository === grant.repository && target.repositoryId === grant.repositoryId
        && target.pullRequest === grant.pullRequest)
      || exact(grant, ['repository', 'repositoryId', 'issue']) && positive(grant.issue)
      && config.targets.some((target) => Object.hasOwn(target, 'subject')
        && target.repository === grant.repository && target.repositoryId === grant.repositoryId
        && target.issue === grant.issue)))) throw new Error('INVALID_ACTIONS_CONFIG');
  // A scoped range binds an already configured target of its own repository; it never creates a target.
  if (ranges.some((r) => Object.hasOwn(r, 'target') && !config.targets.some((t) => t.repository === r.repository
    && (Object.hasOwn(r.target, 'pullRequest') ? t.pullRequest === r.target.pullRequest : t.issue === r.target.issue)))) {
    throw new Error('INVALID_ACTIONS_CONFIG');
  }
  // A subject-bearing target runs only within its own target-scoped range, never an unscoped legacy range.
  if (config.targets.some((t) => Object.hasOwn(t, 'subject') && !ranges.some((r) => r.repository === t.repository
    && Object.hasOwn(r, 'target') && r.target.issue === t.issue))) throw new Error('INVALID_ACTIONS_CONFIG');
  // Reservations never overlap for one native workflow identity, so a run number is admitted by at most one.
  for (const a of ranges) for (const b of ranges) {
    if (a !== b && a.repository === b.repository && a.workflowId === b.workflowId && a.first <= b.last && b.first <= a.last) throw new Error('INVALID_ACTIONS_CONFIG');
  }
  if (config.provider !== null && config.targets.some((t) => {
    const target = config.provider.receipt.target;
    const i = target.repositories.indexOf(t.repository);
    return i < 0 || target.repository_ids[i] !== t.repositoryId;
  })) throw new Error('INVALID_ACTIONS_CONFIG');
  return freezeDeep(config);
}

export function selectActionsTarget(config, repository, number, targetKind = 'issue') {
  if (!['issue', 'pull-request'].includes(targetKind)) return undefined;
  const field = targetKind === 'pull-request' ? 'pullRequest' : 'issue';
  return config.targets.find((target) => target.repository === repository && target[field] === number);
}

// Hard aggregate bound on attempted consumer provider calls: a provider call is planned only for a
// first-attempt run whose native repository/workflow id/path/run number fall in one reviewed range, and
// each run is capped at min(range.reservedCallsPerRun, limits.maxCalls). Total <= sum(width x reserved).
// Once a repository has a target-scoped range, every run there needs the caller's independently observed
// {kind, number} target (event or snapshot, never the range): a scoped range admits only its target, and a
// target with a scoped range is never admitted by an unscoped legacy range.
export function selectRunRange(config, run, target) {
  if (!exact(run, ['repository', 'workflowId', 'path', 'number', 'attempt', 'id'])
    || !positive(run.workflowId) || !positive(run.number) || !positive(run.attempt) || !positive(run.id)) return { cause: 'RUN_UNKNOWN' };
  if (run.attempt !== 1) return { cause: 'RERUN_NOT_PAID' };
  const hits = config.runRanges.filter((r) => r.repository === run.repository && r.workflowId === run.workflowId
    && r.path === run.path && r.first <= run.number && run.number <= r.last);
  if (hits.length !== 1) return { cause: 'NO_RANGE' };
  const scoped = config.runRanges.filter((r) => Object.hasOwn(r, 'target') && r.repository === run.repository);
  if (scoped.length) {
    if (!exact(target, ['kind', 'number']) || !['issue', 'pull-request'].includes(target.kind) || !positive(target.number)) {
      return { cause: 'RANGE_TARGET_UNKNOWN' };
    }
    if (Object.hasOwn(hits[0], 'target') ? !scopes(hits[0], target.kind, target.number)
      : scoped.some((r) => scopes(r, target.kind, target.number))) return { cause: 'RANGE_TARGET_MISMATCH' };
  }
  return { range: hits[0], callsPerRun: Math.min(hits[0].reservedCallsPerRun, config.limits.maxCalls) };
}

// Subject revision from the exact full body and the provider's body-edit signals; generic updatedAt is not
// used, so unrelated activity is not a revision change. Not a claim of complete or immutable edit history.
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const time = (x) => text(x) && Number.isFinite(Date.parse(x));
const editSignals = (x) => (x.lastEditedAt === null || time(x.lastEditedAt)) && typeof x.includesCreatedEdit === 'boolean'
  && Number.isSafeInteger(x.userContentEditsTotal) && x.userContentEditsTotal >= 0;
export const ISSUE_KEYS = ['number', 'nodeId', 'body', 'lastEditedAt', 'includesCreatedEdit', 'userContentEditsTotal'];
export const COMMAND_KEYS = ['databaseId', 'nodeId', 'author', 'body', 'lastEditedAt', 'includesCreatedEdit', 'userContentEditsTotal'];
// A granted subject snapshot: the Issue keys plus the repository identity observed in the same read.
export const SUBJECT_KEYS = ['repository', 'repositoryId', 'isPrivate', ...ISSUE_KEYS];
export function subjectRevision(issue) {
  return [issue.nodeId, 'sha256:' + sha256(issue.body), issue.lastEditedAt ?? 'unedited',
    String(issue.userContentEditsTotal), String(issue.includesCreatedEdit)].join('|');
}

// Trusted literal-command admission. The guard matched Org/body/Issue at the event; this re-checks the
// observed command against the event, builds the existing semlint input (log-entry subject = exact full Issue
// body; context = declared repository files at the run's source SHA) and plans with the run's call ceiling.
export const COMMAND_OBSERVATION = 'ACTIONS_TRUSTED_LITERAL_COMMAND';
export const PROVIDED_COMMAND_OBSERVATION = 'ACTIONS_TRUSTED_PROVIDED_REQUEST';

// The subject may carry one English rendering of the whole observed body ({text, sourceSha256}, CJK-free). The runtime
// checks bytes only; fidelity of the rendering stays with the trusted requester's owner route and posting decision.
// CJK may appear only in the original subject content; every other field, including the English, stays CJK-free.
// `expected` is the evaluated text {ref, revision, scope, body}: the PR body itself, or the granted subject Issue.
function providedPayloadMatches(payload, expected) {
  if (!Array.isArray(payload.cases) || payload.cases.length !== 1) return false;
  const value = payload.cases[0]?.input, subject = value?.subject;
  const aux = subject?.englishAuxiliary;
  if (!(aux === null || exact(aux, ['text', 'sourceSha256']) && text(aux.text) && aux.sourceSha256 === sha256(expected.body))) return false;
  const { content, ...outsideOriginal } = subject;
  return value?.schema === 'ops.semlint.input.v14' && subject?.kind === 'log-entry'
    && subject.ref === expected.ref && subject.revision === expected.revision && subject.scope === expected.scope
    && content === expected.body && subject.sha256 === sha256(expected.body)
    && subject.evaluationSpan?.startByte === 0 && subject.evaluationSpan.endByte === Buffer.byteLength(expected.body, 'utf8')
    && Array.isArray(value.context) && value.context.every((row) => row?.englishAuxiliary === null)
    && Array.isArray(value.checks) && value.checks.length > 0 && value.checks.length <= 6
    && !CJK.test(JSON.stringify({ ...value, subject: outsideOriginal }));
}

export async function admitIssueCommand(inputValue, configValue) {
  let config, input;
  try { config = validateActionsConfig(configValue); } catch (error) { return reject(error.message); }
  try {
    input = snapshotJson(inputValue);
    const subject = input.subject;
    if (!exact(input, ['repository', 'owner', 'sha', 'eventBody', 'run', 'issue', 'command', 'context',
      ...(Object.hasOwn(input, 'targetKind') ? ['targetKind'] : []), ...(Object.hasOwn(input, 'subject') ? ['subject'] : [])])
      || (Object.hasOwn(input, 'subject') && (!exact(subject, SUBJECT_KEYS) || !REPOSITORY.test(subject.repository)
        || !databaseId(subject.repositoryId) || typeof subject.isPrivate !== 'boolean' || !positive(subject.number)
        || !text(subject.nodeId) || typeof subject.body !== 'string' || !editSignals(subject)))
      || (Object.hasOwn(input, 'targetKind') && input.targetKind !== 'pull-request')
      || !REPOSITORY.test(input.repository) || !text(input.owner) || !sha(input.sha) || !text(input.eventBody)
      || !exact(input.issue, ISSUE_KEYS) || !positive(input.issue.number) || !text(input.issue.nodeId)
      || typeof input.issue.body !== 'string' || !editSignals(input.issue)
      || !exact(input.command, COMMAND_KEYS) || !positive(input.command.databaseId) || !text(input.command.nodeId)
      || !text(input.command.author) || typeof input.command.body !== 'string' || !editSignals(input.command)
      || !Array.isArray(input.context) || input.context.length !== config.context.length
      || !input.context.every((c, i) => exact(c, ['role', 'path', 'content']) && c.role === config.context[i].role
        && c.path === config.context[i].path && typeof c.content === 'string')) return reject('INPUT_UNKNOWN');
  } catch { return reject('INPUT_UNKNOWN'); }
  const { issue, command } = input;
  const targetKind = input.targetKind ?? 'issue';
  const pullRequest = targetKind === 'pull-request';
  const target = selectActionsTarget(config, input.repository, issue.number, targetKind);
  if (!target) return reject('TARGET_NOT_AUTHORIZED');
  // Only the reviewed target names a subject; the snapshot must be that exact public Issue in that exact repository.
  const grant = target.subject, subject = input.subject;
  if (!grant !== !subject) return reject(grant ? 'SUBJECT_UNKNOWN' : 'SUBJECT_NOT_GRANTED');
  if (grant && (subject.repository !== grant.repository || subject.repositoryId !== grant.repositoryId
    || subject.number !== grant.number || subject.isPrivate !== false)) return reject('SUBJECT_MISMATCH');
  if (!config.trustedCallers.includes(command.author)) return reject('COMMAND_NOT_AUTHORIZED');
  const provided = input.eventBody.startsWith(REQUEST_PREFIX);
  // Only an explicit Issue provided grant lets a provided request evaluate the origin's granted subject Issue.
  const issueGranted = !pullRequest && grant !== undefined && config.providedRequestTargets?.some((g) =>
    g.repository === input.repository && g.issue === issue.number) === true;
  if (provided && grant && !issueGranted) return reject('PROVIDED_WITH_SUBJECT_UNSUPPORTED');
  if (input.eventBody !== '/jev-evaluate' && !provided) return reject('NOT_A_REQUEST');
  const granted = pullRequest && config.providedRequestTargets?.some((grant) =>
    grant.repository === input.repository && grant.pullRequest === issue.number) === true;
  if (provided && !granted && !issueGranted) return reject('PROVIDED_REQUEST_NOT_AUTHORIZED');
  if (command.body !== input.eventBody) return reject('COMMAND_DRIFT');
  if (command.lastEditedAt !== null || command.includesCreatedEdit || command.userContentEditsTotal !== 0) return reject('EDITED');
  const selected = selectRunRange(config, { ...input.run, repository: input.repository }, { kind: targetKind, number: issue.number });
  if (!selected.range) return reject(selected.cause);
  // The top-level identity keeps describing the origin Issue (issue, issueNodeId, subjectRevision). With a grant, the
  // evaluated Issue is the subject: the semlint input and identity.subject carry its ref and revision instead.
  const revision = subjectRevision(issue);
  const evaluatedRevision = grant ? subjectRevision(subject) : revision;
  const semlintInput = { schema: 'ops.semlint.input.v1',
    subject: { kind: 'log-entry', ref: grant ? `https://github.com/${grant.repository}/issues/${grant.number}`
      : `https://github.com/${input.repository}/${pullRequest ? 'pull' : 'issues'}/${issue.number}`, revision: evaluatedRevision,
      scope: pullRequest ? 'entire body of the approved pull request at the observed revision' : config.subjectScope,
      content: grant ? subject.body : issue.body, sha256: sha256(grant ? subject.body : issue.body) },
    context: input.context.map((c) => ({ role: c.role, ref: `${c.path}@${input.sha}`, revision: input.sha, content: c.content, sha256: sha256(c.content) })),
    checks: [...config.allowedChecks] };
  let prepared;
  if (provided) {
    // The provided subject must be the evaluated text: the PR body, or on the Issue route the granted subject Issue at its
    // own revision and the configured scope. The origin body, revision or digest never stand in for it.
    const expected = issueGranted
      ? { ref: `https://github.com/${grant.repository}/issues/${grant.number}`, revision: evaluatedRevision, scope: config.subjectScope, body: subject.body }
      : { ref: `https://github.com/${input.repository}/pull/${issue.number}`, revision,
        scope: 'entire body of the approved pull request at the observed revision', body: issue.body };
    const parsed = await prepareIssueRequest(command.body, { ...config.limits, maxCases: 1, maxCalls: Math.min(1, selected.callsPerRun) },
      (payload) => providedPayloadMatches(payload, expected));
    if (parsed.cause) return reject(parsed.cause);
    prepared = parsed.prepared;
    if (prepared.expected[0].sendable !== prepared.plan.cases[0].input.checks.length) return reject('PROVIDED_CONTEXT_INCOMPLETE');
  } else {
    // A literal v1 request sends the original text unrendered; on a target granted the provided route, CJK input
    // is refused here rather than evaluated unsupported. Legacy literal targets keep their behavior. The refusal
    // keeps this admission snapshot's subject identity (node ID and exact revision, no body text). CJK anywhere in
    // the input refuses, so the observation names the subject; it does not say the body itself is CJK. On the Issue route
    // the origin pair is joined by the evaluated subject's own pair; a subject grant alone keeps the legacy passthrough.
    if ((granted || issueGranted) && CJK.test(JSON.stringify(semlintInput))) {
      return { ...reject('UNSUPPORTED_CJK'), observed: { issueNodeId: issue.nodeId, subjectRevision: revision,
        ...(issueGranted ? { subject: { nodeId: subject.nodeId, revision: evaluatedRevision } } : {}) } };
    }
    try {
      prepared = await preparePlan({ schema: 'ops.semlint.real-input.v1', cases: [{ id: targetKind, input: semlintInput }] },
        { ...config.limits, maxCalls: selected.callsPerRun });
    } catch { return reject('INVALID_REQUEST_OR_ADMISSION'); }
  }
  return finishRequest(prepared, (planDigest) => ({
    repository: input.repository, issue: issue.number, issueNodeId: issue.nodeId, subjectRevision: revision,
    ...(grant ? { subject: { repository: grant.repository, repositoryId: grant.repositoryId, kind: 'issue', number: grant.number,
      nodeId: subject.nodeId, revision: evaluatedRevision } } : {}),
    ...(pullRequest ? { targetKind } : {}),
    commentId: command.databaseId, nodeId: command.nodeId, author: command.author, bodyDigest: digest(command.body),
    observation: provided ? PROVIDED_COMMAND_OBSERVATION : COMMAND_OBSERVATION, executionSource: input.sha, configDigest: digest(config),
    run: { id: input.run.id, number: input.run.number, attempt: input.run.attempt, workflowId: input.run.workflowId },
    planDigest }), provided);
}

// Pure prior derivation from provider-native state only: claim reactions of the source-constant kind on the
// request comment, and result comments on the Issue. No persistence; observed counts are never a budget.
export function deriveIssuePrior(request, observationValue, executorLogin) {
  const unrecognized = { requestDigest: request?.requestDigest ?? '', state: 'UNRECOGNIZED' };
  if (!requests.has(request) || !text(executorLogin)) return unrecognized;
  let obs;
  try { obs = snapshotJson(observationValue); } catch { return unrecognized; }
  if (!exact(obs, ['claims', 'results']) || !Array.isArray(obs.claims) || !Array.isArray(obs.results)) return unrecognized;
  const ours = obs.claims.filter((x) => x === executorLogin).length;
  // Only executorLogin's reaction is a claim. A known other login is not a claim and grants no principal
  // migration, so it is ignored; an unattributable reaction (null/deleted user) or a duplicate is held.
  if (ours > 1 || obs.claims.some((x) => !text(x))) return unrecognized;
  // Only results authored by executorLogin can deliver; anyone else's copies are ignored.
  const matching = obs.results.filter((r) => {
    if (r?.author !== executorLogin) return false;
    return parseResultComment(r.body)?.requestDigest === request.requestDigest;
  });
  if (!matching.length) return ours ? { requestDigest: request.requestDigest, state: 'STARTED' } : null;
  const [r] = matching;
  if (matching.length === 1 && ours === 1 && verifyResultReadback(request, r.body, { repository: request.identity.repository,
    issue: request.identity.issue, id: r.databaseId, author: r.author, body: r.body }, executorLogin, r.databaseId)) {
    return { requestDigest: request.requestDigest, state: 'APPENDED' };
  }
  return unrecognized;
}

// Prior state must come from a serialized real executor. This decision has no persistence or effects.
// A failed/unknown paid call is never converted to a free retry; existing result delivery is separate.
export function nextIssueEffect(request, prior = null) {
  if (!requests.has(request)) return { effect: 'NONE', cause: 'REQUEST_NOT_ADMITTED' };
  if (prior === null) return { effect: 'EVALUATE', cause: 'NO_PRIOR_ATTEMPT' };
  if (!exact(prior, ['requestDigest', 'state']) || prior.requestDigest !== request.requestDigest) return { effect: 'NONE', cause: 'STATE_IDENTITY_MISMATCH' };
  if (prior.state === 'EVALUATED') return { effect: 'APPEND_EXISTING_RESULT', cause: 'NO_PROVIDER_RECALL' };
  if (prior.state === 'APPENDED') return { effect: 'READBACK_ONLY', cause: 'NO_DUPLICATE_APPEND' };
  return { effect: 'NONE', cause: 'ATTEMPT_REQUIRES_RECONCILIATION' };
}

export function composeResultComment(request, resultValue) {
  if (!requests.has(request)) throw new Error('REQUEST_NOT_ADMITTED');
  const output = validateOwnerResult(request.prepared, resultValue);
  const body = resultComment({ schema: 'ops.jev.issue-result.v1', requestDigest: request.requestDigest,
    identity: request.identity, authority: false, result: output });
  if (Buffer.byteLength(body, 'utf8') > RESULT_BYTE_CAP) throw new Error('RESULT_COMMENT_TOO_LARGE');
  return body;
}

// Compare exact append evidence, not merely HTTP success or a comment URL.
export function verifyResultReadback(request, expectedBody, observedValue, trustedResultAuthor, expectedCommentId) {
  if (!requests.has(request) || typeof expectedBody !== 'string') return false;
  let observed;
  try {
    observed = snapshotJson(observedValue);
    const envelope = parseResultComment(expectedBody);
    if (!exact(envelope, ['schema', 'requestDigest', 'identity', 'authority', 'result'])
      || envelope.schema !== 'ops.jev.issue-result.v1' || envelope.requestDigest !== request.requestDigest
      || envelope.authority !== false || JSON.stringify(envelope.identity) !== JSON.stringify(request.identity)
      || (composeResultComment(request, envelope.result) !== expectedBody && resultJSON(envelope) !== expectedBody)) return false;
  } catch { return false; }
  return exact(observed, ['repository', 'issue', 'id', 'author', 'body']) && positive(expectedCommentId) && observed.id === expectedCommentId
    && observed.repository === request.identity.repository && observed.issue === request.identity.issue
    && text(trustedResultAuthor) && observed.author === trustedResultAuthor && observed.body === expectedBody;
}
