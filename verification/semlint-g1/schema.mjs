// Closed row shapes for the semlint G1 ledgers (roccho-dev/adrs#635 comments 6313476031, 6313494258).
// Rows hold hashes, times, lane IDs and counts only; sealed content never enters a ledger.
// Each validator returns a list of error strings; an empty list means the row is valid.

export const SEAL_KINDS = ['no-jev', 'sys2-direct', 'with-jev', 'answer-key', 'deadline', 'rubric'];
export const LANE_KINDS = ['no-jev', 'sys2-direct', 'with-jev'];
export const LANE_GUESSES = [...LANE_KINDS, 'unsure'];
export const SCORERS = ['R', 'W'];
export const COUNT_ITEMS = ['falseFinding', 'duplicate', 'inconsistency', 'omission'];
export const BURDEN_KINDS = ['input-authoring', 'reading', 'recovery', 'round-trip'];
export const BURDEN_UNITS = ['bytes', 'seconds', 'count'];
export const THETA_FILE = 'packages/jev-review/github-comment.mjs';
export const UNCERTAIN_BAND = { low: 0.3, high: 0.7 };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isNat = (v) => Number.isSafeInteger(v) && v >= 0;
const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isTime = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const isCase = (v) => typeof v === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(v);
const isRepo = (v) => typeof v === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v);

function keys(row, expected, errors) {
  if (!isObj(row)) { errors.push('row is not an object'); return false; }
  const got = Object.keys(row).sort(), want = [...expected].sort();
  if (got.join() !== want.join()) errors.push(`keys must be exactly [${want.join(', ')}], got [${got.join(', ')}]`);
  return true;
}

export function validateSeal(row) {
  const e = [];
  if (!keys(row, ['schema', 'caseRef', 'kind', 'laneId', 'sha256', 'sealedAt', 'evidence'], e)) return e;
  if (row.schema !== 'ops.semlint.g1.seal.v1') e.push('schema');
  if (!isCase(row.caseRef)) e.push('caseRef');
  if (!SEAL_KINDS.includes(row.kind)) e.push('kind');
  if (LANE_KINDS.includes(row.kind) ? !isStr(row.laneId) : row.laneId !== null) e.push('laneId (lane seals carry one, others null)');
  if (!isHash(row.sha256)) e.push('sha256');
  if (!isTime(row.sealedAt)) e.push('sealedAt');
  const ev = row.evidence;
  if (!isObj(ev) || Object.keys(ev).sort().join() !== 'commentId,repository' || !isRepo(ev.repository)
    || !Number.isSafeInteger(ev.commentId) || ev.commentId <= 0) e.push('evidence {repository, commentId}');
  return e;
}

export function validateJudgment(row) {
  const e = [];
  if (!keys(row, ['schema', 'caseRef', 'scorer', 'blindId', 'rubricSha256', 'counts', 'requiredKept', 'laneGuess', 'judgedAt'], e)) return e;
  if (row.schema !== 'ops.semlint.g1.judgment.v1') e.push('schema');
  if (!isCase(row.caseRef)) e.push('caseRef');
  if (!SCORERS.includes(row.scorer)) e.push('scorer');
  if (!isStr(row.blindId)) e.push('blindId');
  if (!isHash(row.rubricSha256)) e.push('rubricSha256');
  const c = row.counts;
  if (!isObj(c) || Object.keys(c).sort().join() !== [...COUNT_ITEMS].sort().join() || !COUNT_ITEMS.every((k) => isNat(c[k]))) e.push('counts');
  const k = row.requiredKept;
  if (!isObj(k) || Object.keys(k).sort().join() !== 'kept,required' || !isNat(k.kept) || !isNat(k.required) || k.kept > k.required) {
    e.push('requiredKept {kept <= required}');
  }
  if (!LANE_GUESSES.includes(row.laneGuess)) e.push('laneGuess');
  if (!isTime(row.judgedAt)) e.push('judgedAt');
  return e;
}

export function validateBurden(row) {
  const e = [];
  if (!keys(row, ['schema', 'caseRef', 'laneId', 'kind', 'quantity', 'evidence', 'observedAt'], e)) return e;
  if (row.schema !== 'ops.semlint.g1.burden.v1') e.push('schema');
  if (!isCase(row.caseRef)) e.push('caseRef');
  if (!(row.laneId === null || isStr(row.laneId))) e.push('laneId');
  if (!BURDEN_KINDS.includes(row.kind)) e.push('kind');
  const q = row.quantity;
  // UNKNOWN is null; it is never replaced by zero.
  if (!isObj(q) || Object.keys(q).sort().join() !== 'unit,value' || !BURDEN_UNITS.includes(q.unit) || !(q.value === null || isNat(q.value))) {
    e.push('quantity {unit, value: nonnegative integer or null}');
  }
  if (!(row.evidence === null || (isStr(row.evidence) && row.evidence.startsWith('https://')))) e.push('evidence');
  if (!isTime(row.observedAt)) e.push('observedAt');
  return e;
}

export function validateTheta(row) {
  const e = [];
  if (!keys(row, ['schema', 'file', 'constant', 'value', 'band', 'recordedAt'], e)) return e;
  if (row.schema !== 'ops.semlint.g1.theta.v1') e.push('schema');
  if (row.file !== THETA_FILE) e.push(`file must be ${THETA_FILE}`);
  if (typeof row.constant !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(row.constant)) e.push('constant');
  if (typeof row.value !== 'number' || !(row.value >= 0 && row.value <= 1)) e.push('value in [0,1]');
  const b = row.band;
  if (!isObj(b) || Object.keys(b).sort().join() !== 'high,low' || b.low !== UNCERTAIN_BAND.low || b.high !== UNCERTAIN_BAND.high) {
    e.push('band must be the official 0.30-0.70');
  }
  if (!isTime(row.recordedAt)) e.push('recordedAt');
  return e;
}

const VALIDATORS = {
  'ops.semlint.g1.seal.v1': validateSeal,
  'ops.semlint.g1.judgment.v1': validateJudgment,
  'ops.semlint.g1.burden.v1': validateBurden,
  'ops.semlint.g1.theta.v1': validateTheta,
};

export function parseLedger(text) {
  const rows = [], errors = [];
  text.split('\n').forEach((raw, i) => {
    if (raw === '') return;
    let row;
    try { row = JSON.parse(raw); } catch { errors.push({ line: i + 1, errors: ['not JSON'] }); return; }
    const validate = VALIDATORS[row?.schema];
    const errs = validate ? validate(row) : ['unknown schema'];
    if (errs.length) errors.push({ line: i + 1, errors: errs });
    else rows.push(row);
  });
  return { rows, errors };
}
