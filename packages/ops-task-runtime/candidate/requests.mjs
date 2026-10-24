// Bounded opt-in proof caller. No queue, durable scheduler or second task DAG.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {processIdentity, discover, alive, stopTree} from './process.mjs';
export const sha = b => crypto.createHash('sha256').update(b).digest('hex');
export const read = p => JSON.parse(fs.readFileSync(p));
export function write(p, x) {
  fs.writeFileSync(`${p}.partial`, JSON.stringify(x, null, 2) + '\n', {flag: 'wx'});
  fs.renameSync(`${p}.partial`, p);
}
const fail = s => { throw Error(s); };
function git(repo, args) {
  const r = spawnSync(process.env.OPS_CANDIDATE_GIT || 'git', ['-C', repo, ...args], {maxBuffer: 64 * 1024 * 1024});
  if (r.status !== 0) fail(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}
export function inventory(root) {
  const rows = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name), stat = fs.lstatSync(p);
      if (stat.isDirectory()) walk(p);
      else if (stat.isFile()) rows.push([path.relative(root, p), sha(fs.readFileSync(p))]);
      else fail('non-regular snapshot asset');
    }
  }
  walk(root); return rows;
}
export function binding(file) {
  const x = read(file);
  if (x.schema !== 'ops.taskCandidateRuntime/1' || x.target !== 'linux-amd64') fail('runtime schema/target');
  for (const k of ['node', 'python', 'task', 'actrun', 'shell', 'loader', 'git', 'coreutils']) {
    const t = x.tools[k];
    if (!t || !path.isAbsolute(t.path) || sha(fs.readFileSync(t.path)) !== t.sha256) fail(`runtime identity: ${k}`);
  }
  if (fs.realpathSync(x.tools.node.path) !== fs.realpathSync(process.execPath)) fail('caller Node identity');
  // Candidate does not admit arbitrary lookalike task/actrun binaries.
  const source = read(new URL('../source.json', import.meta.url));
  if (x.tools.task.sha256 !== source.goTask.binarySha256 || x.tools.actrun.sha256 !== source.actrun.binarySha256) fail('upstream binary binding');
  return x;
}
export const declaredEnv = {LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', HOME: '<attempt>/home', TMPDIR: '<attempt>/tmp', PATH: '<bound task+shell+git+coreutils bins>', BASH_ENV: '', ENV: '', OPS_CANDIDATE_WORK: '<attempt>/work'};
export function inputIdentity(a) {
  return sha(JSON.stringify({commit: a.commit, tree: a.tree, oracle: a.oracle, runtimeIdentity: a.runtimeIdentity, mode: a.mode, target: a.target, declaredEnv: a.declaredEnv}));
}
export async function execute(a, runtime) {
  const work = path.join(a.dir, 'work');
  const env = {LANG: declaredEnv.LANG, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', BASH_ENV: '', ENV: '', PATH: [path.dirname(runtime.tools.task.path), path.dirname(runtime.tools.shell.path), path.dirname(runtime.tools.git.path), path.dirname(runtime.tools.coreutils.path)].join(':'), HOME: path.join(a.dir, 'home'), TMPDIR: path.join(a.dir, 'tmp'), OPS_CANDIDATE_NODE: runtime.tools.node.path, OPS_CANDIDATE_PYTHON: runtime.tools.python.path, OPS_CANDIDATE_TASK: runtime.tools.task.path, OPS_CANDIDATE_X: a.x, OPS_CANDIDATE_MODE: a.mode, OPS_CANDIDATE_WORK: work};
  const argv = ['--taskfile', path.join(work, 'Taskfile.yml'), '--dir', work, `candidate-${a.mode}`];
  const executable = a.route === 'direct' ? runtime.tools.task.path : runtime.tools.loader.path;
  const actualArgv = a.route === 'direct' ? argv : [runtime.tools.actrun.path, 'workflow', 'run', path.join(work, 'candidate', 'workflow.yml'), '--workspace-mode', 'local', '--no-nix', '--run-root', path.join(a.dir, 'actrun'), '--artifact-root', path.join(a.dir, 'artifacts'), '--cache-root', path.join(a.dir, 'cache'), '--github-action-cache-root', path.join(a.dir, 'action-cache'), '--registry-root', path.join(a.dir, 'registry')];
  const stdout = fs.openSync(path.join(a.dir, 'stdout'), 'wx'), stderr = fs.openSync(path.join(a.dir, 'stderr'), 'wx');
  const child = spawn(executable, actualArgv, {cwd: work, env, stdio: ['ignore', stdout, stderr], detached: true});
  fs.closeSync(stdout); fs.closeSync(stderr);
  const resultPromise = new Promise(resolve => {
    child.once('error', e => resolve({exit: null, error: e.message}));
    child.once('exit', (exit, signal) => resolve({exit, signal}));
  });
  const root = child.pid ? processIdentity(child.pid) : null;
  let descendants = root ? [root] : [], cancelled = false, stopping = null;
  write(path.join(a.dir, 'process.json'), {root, descendants, executable, argv: actualArgv});
  const started = Date.now();
  const monitor = setInterval(() => {
    descendants = discover(root, descendants);
    write(path.join(a.dir, 'process.json'), {root, descendants, executable, argv: actualArgv});
    if ((a.mode === 'cancel' && fs.existsSync(path.join(work, 'out', 'descendant.json'))) || Date.now() - started > 30000) {
      if (!stopping) { cancelled = true; stopping = stopTree(root, descendants); }
    }
  }, 20);
  let result;
  try {
    result = await resultPromise;
    if (stopping) descendants = await stopping;
    descendants = discover(root, descendants);
    if (descendants.some(alive)) descendants = await stopTree(root, descendants);
  } finally { clearInterval(monitor); }
  write(path.join(a.dir, 'process-final.json'), {root, descendants, allStopped: !descendants.some(alive)});
  const oracleIntact = JSON.stringify(inventory(path.join(a.dir, 'snapshot'))) === JSON.stringify(a.oracle);
  const workIntact = a.oracle.every(([rel, digest]) => sha(fs.readFileSync(path.join(work, rel))) === digest);
  const receipt = {...a, ...result, argv, actualExecutable: executable, actualArgv, oracleIntact, workIntact, cancelled, status: 'OBSERVED'};
  write(path.join(a.dir, 'receipt.json'), receipt);
  return receipt;
}
export async function requests(args) {
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--repo', '--request-file', '--runtime-manifest', '--evidence-dir'].includes(args[i]) || args[i + 1] === undefined || opts[args[i]]) fail('unique option/value required');
    opts[args[i]] = args[i + 1];
  }
  for (const k of ['--repo', '--request-file', '--runtime-manifest', '--evidence-dir']) if (!opts[k]) fail(`missing ${k}`);
  const repo = path.resolve(opts['--repo']), out = path.resolve(opts['--evidence-dir']);
  const runtime = binding(opts['--runtime-manifest']), req = read(opts['--request-file']);
  if (req.schema !== 'ops.taskCandidateRequests/1' || !Array.isArray(req.requests) || !req.requests.length || req.requests.length > 32) fail('requests schema/bound');
  const ids = new Set();
  for (const r of req.requests) {
    if (typeof r.eventId !== 'string' || !r.eventId || ids.has(r.eventId)) fail('unique eventId required');
    ids.add(r.eventId);
    if (!['success', 'failure', 'cancel'].includes(r.mode) || typeof r.inputBase64 !== 'string' || !['direct', 'actrun'].includes(r.route)) fail('request fields');
    if (Buffer.from(r.inputBase64, 'base64').toString('base64') !== r.inputBase64) fail('noncanonical input');
  }
  if (git(repo, ['status', '--porcelain', '--untracked-files=all']).length) fail('dirty source refused');
  const commit = git(repo, ['rev-parse', 'HEAD']).toString().trim(), tree = git(repo, ['rev-parse', 'HEAD^{tree}']).toString().trim();
  fs.mkdirSync(out, {recursive: false});
  const prefix = 'packages/ops-task-runtime/';
  const archive = git(repo, ['archive', '--format=tar', commit, prefix]);
  const source = path.join(out, 'retained-source');
  fs.mkdirSync(source);
  const extracted = spawnSync(runtime.tools.python.path, ['-c', "import io,tarfile,sys; t=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())); t.extractall(sys.argv[1],filter='data')", source], {input: archive});
  if (extracted.error || extracted.status !== 0) fail('source archive extraction failed');
  fs.writeFileSync(path.join(out, 'source.tar'), archive);
  const packageSource = path.join(source, prefix);
  const accepted = [], rejected = [];
  for (const r of req.requests) {
    if (accepted.length >= 2) { rejected.push({eventId: r.eventId, status: 'REJECTED_CAPACITY', queued: false}); continue; }
    const input = Buffer.from(r.inputBase64, 'base64'), runId = crypto.randomUUID(), attemptId = crypto.randomUUID(), dir = path.join(out, runId, attemptId);
    fs.mkdirSync(dir, {recursive: true});
    for (const d of ['snapshot', 'work', 'tmp', 'home']) fs.mkdirSync(path.join(dir, d));
    fs.cpSync(packageSource, path.join(dir, 'snapshot'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'snapshot', 'input.bin'), input, {mode: 0o444});
    const oracle = inventory(path.join(dir, 'snapshot'));
    fs.cpSync(path.join(dir, 'snapshot'), path.join(dir, 'work'), {recursive: true});
    if (JSON.stringify(inventory(path.join(dir, 'work'))) !== JSON.stringify(oracle)) fail('copy mismatch');
    const runtimeIdentity = Object.fromEntries(Object.entries(runtime.tools).sort().map(([k, v]) => [k, v.sha256]));
    const record = {schema: 'ops.taskCandidateAttempt/1', eventId: r.eventId, runId, attemptId, commit, tree, inputSha256: sha(input), runtimeIdentity, target: runtime.target, declaredEnv, mode: r.mode, route: r.route, dir, oracle, status: 'ACCEPTED'};
    record.x = inputIdentity(record);
    write(path.join(dir, 'accepted.json'), record); accepted.push(record);
  }
  write(path.join(out, 'admission.json'), {schema: 'ops.taskCandidateAdmission/1', bound: 2, boundScope: 'one invocation', accepted: accepted.map(({eventId, runId, attemptId, x}) => ({eventId, runId, attemptId, x})), rejected});
  const receipts = await Promise.all(accepted.map(a => execute(a, runtime)));
  write(path.join(out, 'invocation.json'), {schema: 'ops.taskCandidateInvocation/1', commit, tree, accepted: receipts, rejected});
  process.stdout.write(JSON.stringify({evidence: out, accepted: accepted.length, rejected: rejected.length}) + '\n');
}
