"""Deterministic HEAD movement using real Git objects and real task execution.

The query observer forwards every command to the bound native Git unchanged.
It changes only this disposable fixture's HEAD after returning commit A's bytes;
no task/actrun/runtime result is mocked and no auth/config owner is changed.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile

p = argparse.ArgumentParser()
p.add_argument('--source-archive', type=Path, required=True)
p.add_argument('--runtime', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
a.out.mkdir()
runtime = json.loads(a.runtime.read_text())
git = runtime['tools']['git']['path']
node = runtime['tools']['node']['path']
fixture = a.out / 'repo'
fixture.mkdir()
with tarfile.open(a.source_archive) as t:
    t.extractall(fixture, filter='data')
def real_git(*args):
    return subprocess.check_output([git, '-c', 'user.name=CI source-race fixture', '-c', 'user.email=ci-proof@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-C', str(fixture), *args], stderr=subprocess.PIPE).decode().strip()
real_git('init', '--initial-branch=proof')
marker = fixture / 'packages/ops-task-runtime/candidate/head-race-input.txt'
marker.write_text('A\n')
real_git('add', '.')
real_git('commit', '-m', 'Source race fixture A')
commit_a = real_git('rev-parse', 'HEAD')
tree_a = real_git('rev-parse', commit_a + '^{tree}')
marker.write_text('B\n')
real_git('add', '.')
real_git('commit', '-m', 'Source race fixture B')
commit_b = real_git('rev-parse', 'HEAD')
real_git('checkout', '--detach', commit_a)
package_oracle = []
package = fixture / 'packages/ops-task-runtime'
for f in sorted(package.rglob('*')):
    if f.is_file():
        package_oracle.append([f.relative_to(package).as_posix(), hashlib.sha256(f.read_bytes()).hexdigest()])
observer = a.out / 'observe-native-git.py'
observed = a.out / 'head-moved.json'
observer.write_text('#!' + runtime['tools']['python']['path'] + '\n' + f'''import pathlib,subprocess,sys,json
native={git!r}
args=sys.argv[1:]
r=subprocess.run([native,*args],capture_output=True)
marker=pathlib.Path({str(observed)!r})
if args[-2:]==['rev-parse','HEAD'] and not marker.exists():
 subprocess.run([native,'-C',{str(fixture)!r},'checkout','--detach',{commit_b!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
 marker.write_text(json.dumps({{'returnedCommit':r.stdout.decode().strip(),'headAfterMove':{commit_b!r}}}))
sys.stdout.buffer.write(r.stdout)
sys.stderr.buffer.write(r.stderr)
raise SystemExit(r.returncode)
''')
observer.chmod(0o755)
request = {'eventId': 'head-move-after-bind', 'inputBase64': base64.b64encode(b'HEAD race\n').decode(), 'mode': 'success', 'route': 'direct'}
(a.out / 'request.json').write_text(json.dumps({'schema': 'ops.taskCandidateRequests/1', 'requests': [request]}))
cli = package / 'bin/ops-task-runtime.mjs'
with (a.out / 'cli.stdout').open('wb') as of, (a.out / 'cli.stderr').open('wb') as ef:
    subprocess.run([node, str(cli), 'candidate', 'requests', '--repo', str(fixture), '--request-file', str(a.out / 'request.json'), '--runtime-manifest', str(a.runtime), '--evidence-dir', str(a.out / 'invocation')], env={**os.environ, 'OPS_CANDIDATE_GIT': str(observer)}, stdout=of, stderr=ef, check=True, timeout=30)
invocation = json.loads((a.out / 'invocation/invocation.json').read_text())
assert invocation['commit'] == commit_a and invocation['tree'] == tree_a
assert real_git('rev-parse', 'HEAD') == commit_b
attempt = Path(invocation['accepted'][0]['dir'])
assert (attempt / 'snapshot/candidate/head-race-input.txt').read_text() == 'A\n'
identity = {k: v['sha256'] for k, v in sorted(runtime['tools'].items())}
identity['closure'] = runtime['closureSha256']
expected = {'commit': commit_a, 'tree': tree_a, 'packageOracle': package_oracle, 'runtimeIdentity': identity, 'requests': [request]}
(a.out / 'expected.json').write_text(json.dumps(expected))
with (a.out / 'readback.json').open('wb') as f:
    subprocess.run([node, str(package / 'candidate/readback.mjs'), str(a.out / 'invocation'), '--expect', str(a.out / 'expected.json')], stdout=f, check=True)
assert json.loads((a.out / 'readback.json').read_text())['status'] == 'PASS'
(a.out / 'head-race.json').write_text(json.dumps({'schema': 'ops.taskCandidateHeadRace/1', 'status': 'PASS', 'acceptedCommit': commit_a, 'acceptedTree': tree_a, 'headAfterAccept': commit_b, 'snapshotMarker': 'A', 'realGitObserver': str(observer), 'runtimeMocks': False}, indent=2) + '\n')
