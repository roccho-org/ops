// A decision over existing scored evidence, not an executor or another budget ledger.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {compare} from './run.mjs';

export function next(best, candidate = null) {
  const calls = r => r.accounting?.expectedMaxCalls ?? r.total;
  if (!best || best.mode !== 'live' || best.status !== 'EVALUATED'
      || best.errors !== 0 || best.actualCalls !== calls(best)) throw Error('INCOMPLETE_LIVE_RESULT');
  let comparison = null;
  if (candidate) {
    if (candidate.errors !== 0 || candidate.actualCalls !== calls(candidate)) throw Error('INCOMPLETE_LIVE_RESULT');
    comparison = compare(best, candidate);
    const riskIncreased = candidate.falsePositives > best.falsePositives || candidate.falseNegatives > best.falseNegatives;
    if (riskIncreased) comparison = {...comparison,best:best.candidateDigest,targetReached:false,riskIncreased:true};
    if (comparison.best === candidate.candidateDigest) best = candidate;
  }
  return {
    action: best.targetReached ? 'STOP_TARGET' : candidate ? 'STOP_BUDGET' : 'PROPOSE_ONE_CANDIDATE',
    best: best.candidateDigest,
    comparison,
    qualityAdoptionAuthorized: false,
    independentQuality: 'NOT_PROVEN',
    autonomousSys2Resume: 'NOT_PROVEN',
    scope: 'one paired development trial; same cases, Gold, evaluator and model; no automatic refill'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [before, after, extra] = process.argv.slice(2);
    if (!before || extra) throw Error('INVALID_COMMAND');
    const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log(JSON.stringify(next(read(before), after ? read(after) : null)));
  } catch {
    console.error('SYS1_NEXT_STOP: incomplete or changed evidence; read back the same run, do not retry inference');
    process.exitCode = 2;
  }
}
