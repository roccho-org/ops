#!/usr/bin/env node
// Order, pin and theta checks for the semlint G1 comparison (roccho-dev/adrs#635 comments 6313476031, 6313494258).
// Pure functions take already-read data; the git readers and the CLI read a real checkout at exact SHAs.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COUNT_ITEMS, LANE_KINDS, SCORERS, parseLedger, validateJudgment, validateSeal, validateTheta } from './schema.mjs';

// Sealed per case before the run. The rubric is sealed once for the whole series (any caseRef) and is fixed.
export const PRE_RUN_SEALS = ['no-jev', 'sys2-direct', 'answer-key', 'deadline'];
export const PHASES = ['pre-run', 'post-run'];
export const PIN_DIFF_ALLOWED = ['.github/workflows/jev-issue-comment.yml', 'packages/jev-review/issue-actions.json'];

const result = (errors) => ({ ok: errors.length === 0, errors });
const isSealRow = (r) => r?.schema === 'ops.semlint.g1.seal.v1';

// The single series rubric seal, or the reason there is none.
function seriesRubric(rows) {
  const rubrics = rows.filter((r) => isSealRow(r) && r.kind === 'rubric');
  for (const r of rubrics) {
    const errs = validateSeal(r);
    if (errs.length) return { errors: [`invalid rubric seal: ${errs.join('; ')}`] };
  }
  if (rubrics.length !== 1) return { errors: [`rubric: expected exactly 1 across all cases, found ${rubrics.length}`] };
  return { rubric: rubrics[0], errors: [] };
}

// pre-run (cutoff = planned run start): the four case seals and the series rubric exist exactly once and are strictly
// before it; no with-Jev seal yet. post-run (cutoff = actual run start): the same, plus exactly one with-Jev seal
// strictly after it. Equal times are not "before". Invalid rows refuse the whole check; the phase must be named.
export function checkSealOrder(rows, { caseRef, runStartedAt, phase }) {
  const errors = [];
  if (!PHASES.includes(phase)) return result([`phase must be one of ${PHASES.join(', ')}`]);
  const run = Date.parse(runStartedAt);
  if (typeof runStartedAt !== 'string' || Number.isNaN(run)) return result(['runStartedAt is not a time']);
  const mine = rows.filter((r) => r?.caseRef === caseRef);
  for (const r of mine) {
    const errs = validateSeal(r);
    if (errs.length) errors.push(`invalid seal row: ${errs.join('; ')}`);
  }
  if (errors.length) return result(errors);
  const before = (r, kind) => {
    if (!(Date.parse(r.sealedAt) < run)) errors.push(`${kind}: sealed ${r.sealedAt}, not before run ${runStartedAt}`);
  };
  for (const kind of PRE_RUN_SEALS) {
    const found = mine.filter((r) => r.kind === kind);
    if (found.length !== 1) { errors.push(`${kind}: expected exactly 1, found ${found.length}`); continue; }
    before(found[0], kind);
  }
  const rubric = seriesRubric(rows);
  errors.push(...rubric.errors);
  if (rubric.rubric) before(rubric.rubric, 'rubric');
  const withJev = mine.filter((r) => r.kind === 'with-jev');
  const want = phase === 'post-run' ? 1 : 0;
  if (withJev.length !== want) errors.push(`with-jev: expected exactly ${want}, found ${withJev.length}`);
  for (const r of withJev) {
    if (!(Date.parse(r.sealedAt) > run)) errors.push(`with-jev: sealed ${r.sealedAt}, not after run ${runStartedAt}`);
  }
  return result(errors);
}

export function checkPinDiff(changedPaths) {
  const outside = [...new Set(changedPaths)].filter((p) => !PIN_DIFF_ALLOWED.includes(p)).sort();
  return result(outside.map((p) => `outside allowed pin diff: ${p}`));
}

// Exactly one `export const NAME = <numeric literal>;` line and no other assignment to NAME.
export function extractNumericConstant(source, name) {
  const esc = name.replace(/[$]/g, '\\$&');
  const assignments = source.match(new RegExp(`(^|[^.\\w$])${esc}\\s*=(?!=)`, 'gm')) ?? [];
  if (assignments.length === 0) return { status: 'ABSENT' };
  if (assignments.length > 1) return { status: 'AMBIGUOUS' };
  const m = source.match(new RegExp(`^export const ${esc} = (-?(?:0|[1-9]\\d*)(?:\\.\\d+)?);$`, 'm'));
  return m ? { status: 'FOUND', value: Number(m[1]) } : { status: 'NOT_NUMERIC_LITERAL' };
}

// The ledger theta is only a copy: it must equal the constant in the display code at the pinned SHA.
// No constant (W1 not merged yet, or removed) is THETA_CONSTANT_ABSENT and never a pass.
export function checkTheta(thetaRow, sourceAtPin) {
  const errs = validateTheta(thetaRow);
  if (errs.length) return result([`invalid theta row: ${errs.join('; ')}`]);
  const where = `${thetaRow.constant} in ${thetaRow.file}`;
  if (typeof sourceAtPin !== 'string') return result([`THETA_CONSTANT_ABSENT: ${where}`]);
  const found = extractNumericConstant(sourceAtPin, thetaRow.constant);
  if (found.status === 'ABSENT') return result([`THETA_CONSTANT_ABSENT: ${where}`]);
  if (found.status !== 'FOUND') return result([`THETA_CONSTANT_${found.status}: ${where}`]);
  if (found.value !== thetaRow.value) return result([`THETA_MISMATCH: ledger ${thetaRow.value}, code ${found.value} (${where})`]);
  return result([]);
}

// Two blind votes (R and W) per blind ID, each on the single sealed series rubric. Items compared: the four counts and kept.
export function summarizeJudgments(rows, { caseRef, unblind, seals }) {
  const errors = [];
  if (!Array.isArray(seals)) return { ok: false, errors: ['seals are required to bind votes to the sealed rubric'] };
  const sealed = seriesRubric(seals);
  if (!sealed.rubric) return { ok: false, errors: sealed.errors };
  const mine = rows.filter((r) => r?.schema === 'ops.semlint.g1.judgment.v1' && r.caseRef === caseRef);
  for (const r of mine) {
    const errs = validateJudgment(r);
    if (errs.length) errors.push(`invalid judgment row: ${errs.join('; ')}`);
  }
  if (errors.length) return { ok: false, errors };
  for (const r of mine) {
    if (r.rubricSha256 !== sealed.rubric.sha256) errors.push(`${r.blindId}/${r.scorer}: rubricSha256 is not the sealed rubric`);
  }
  const ids = [...new Set(mine.map((r) => r.blindId))].sort();
  if (ids.length === 0) errors.push('no votes');
  for (const id of ids) {
    for (const s of SCORERS) {
      const n = mine.filter((r) => r.blindId === id && r.scorer === s).length;
      if (n !== 1) errors.push(`${id}: expected 1 vote by ${s}, found ${n}`);
    }
    if (!LANE_KINDS.includes(unblind?.[id])) errors.push(`${id}: not in the unblinding map`);
  }
  if (errors.length) return { ok: false, errors };
  let items = 0, agreed = 0;
  const disagreements = [];
  const guess = Object.fromEntries(SCORERS.map((s) => [s, { hits: 0, misses: 0, unsure: 0 }]));
  for (const id of ids) {
    const [r, w] = SCORERS.map((s) => mine.find((x) => x.blindId === id && x.scorer === s));
    const pairs = [...COUNT_ITEMS.map((k) => [k, r.counts[k], w.counts[k]]), ['kept', r.requiredKept.kept, w.requiredKept.kept]];
    for (const [item, a, b] of pairs) {
      items += 1;
      if (a === b) agreed += 1; else disagreements.push({ blindId: id, item, R: a, W: b });
    }
    for (const v of [r, w]) {
      const g = guess[v.scorer];
      if (v.laneGuess === 'unsure') g.unsure += 1; else if (v.laneGuess === unblind[id]) g.hits += 1; else g.misses += 1;
    }
  }
  return { ok: true, errors: [], agreement: { items, agreed, rate: agreed / items }, disagreements, guess };
}

export function gitChangedPaths(repo, fromSha, toSha) {
  const out = execFileSync('git', ['-C', repo, 'diff', '--no-renames', '--name-only', fromSha, toSha, '--'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

export function gitShow(repo, sha, file) {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${sha}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function readLedger(file) {
  const parsed = parseLedger(fs.readFileSync(file, 'utf8'));
  if (parsed.errors.length) throw new Error(`ledger ${file}: ${JSON.stringify(parsed.errors)}`);
  return parsed.rows;
}

const USAGE = `usage:
  verify.mjs seal-order <ledger.jsonl> <caseRef> <runStartedAt> <pre-run|post-run>
  verify.mjs pin-diff <repo> <previousPinSha> <nextPinSha>
  verify.mjs theta <repo> <ledger.jsonl> <pinSha>
  verify.mjs judgments <ledger.jsonl> <caseRef> <unblind.json>`;

function main([cmd, ...a]) {
  let res;
  if (cmd === 'seal-order' && a.length === 4) {
    res = checkSealOrder(readLedger(a[0]).filter(isSealRow), { caseRef: a[1], runStartedAt: a[2], phase: a[3] });
  }
  else if (cmd === 'pin-diff' && a.length === 3) res = checkPinDiff(gitChangedPaths(a[0], a[1], a[2]));
  else if (cmd === 'theta' && a.length === 3) {
    const rows = readLedger(a[1]).filter((r) => r.schema === 'ops.semlint.g1.theta.v1');
    res = rows.length === 1 ? checkTheta(rows[0], gitShow(a[0], a[2], rows[0].file))
      : { ok: false, errors: [`expected exactly 1 theta row, found ${rows.length}`] };
  } else if (cmd === 'judgments' && a.length === 3) {
    const rows = readLedger(a[0]);
    res = summarizeJudgments(rows, { caseRef: a[1], unblind: JSON.parse(fs.readFileSync(a[2], 'utf8')), seals: rows.filter(isSealRow) });
  } else {
    console.error(USAGE);
    return 2;
  }
  console.log(JSON.stringify(res));
  return res.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) process.exit(main(process.argv.slice(2)));
