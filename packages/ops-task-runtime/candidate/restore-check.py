"""Restore a verified proof pack with native Nix in a fresh offline user namespace."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

p = argparse.ArgumentParser()
p.add_argument('--pack', type=Path, required=True)
p.add_argument('--target', type=Path, required=True)
p.add_argument('--evidence', type=Path, required=True)
p.add_argument('--expected-commit', required=True)
a = p.parse_args()
read = lambda p: json.loads(Path(p).read_text())
def digest(p):
    h = hashlib.sha256()
    with Path(p).open('rb') as f:
        for chunk in iter(lambda: f.read(1048576), b''):
            h.update(chunk)
    return h.hexdigest()
def emit(p, x):
    Path(p).write_text(json.dumps(x, indent=2, sort_keys=True) + '\n')
a.evidence.mkdir(exist_ok=True)
a.target.mkdir()
manifest = read(a.pack / 'MANIFEST.json')
for row in manifest['files']:
    assert digest(a.pack / row['path']) == row['sha256'], row['path']
runtime = read(a.pack / 'runtime.json')
assert runtime['profile'] == 'candidate-user-task-SAME-v5.1' and runtime['admission'] == 'NOT_ADOPTED'
root = a.target
with tarfile.open(a.pack / 'bootstrap/target-nix.tar.gz') as t:
    # Exact bootstrap archive is manifest verified. Preserve canonical absolute
    # Nix symlinks inside the fresh root; reject every member traversal.
    for m in t.getmembers():
        assert not m.name.startswith('/') and '..' not in Path(m.name).parts
        if m.issym():
            assert m.linkname.startswith('/nix/store/') or not m.linkname.startswith('/')
    t.extractall(root, filter='fully_trusted')
bootstrap = read(a.pack / 'bootstrap/identity.json')
for d in ['proc', 'etc', 'tmp', 'home', 'dev', 'bin', 'work', 'nix/var/nix/db', 'nix/var/nix/profiles', 'nix/var/nix/gcroots']:
    (root / d).mkdir(parents=True, exist_ok=True)
(root / 'etc/passwd').write_text('root:x:0:0:root:/home:/bin/sh\n')
(root / 'etc/group').write_text('root:x:0:\n')
(root / 'dev/null').touch()
for k in ['node', 'python']:
    assert not (root / runtime['tools'][k]['path'].lstrip('/')).exists(), 'target runtime already present'
# Only retained bytes are made available to the target. No host store bind mount.
shutil.copytree(a.pack, root / 'retained', symlinks=True)
namespace = ['unshare', '--user', '--map-root-user', '--mount', '--net', '--pid', '--fork', f'--mount-proc={root}/proc', 'chroot', str(root)]
native_nix = bootstrap['nixStore']
with (root / 'retained/closure/runtime.export').open('rb') as f, (a.evidence / 'import.stdout').open('wb') as of, (a.evidence / 'import.stderr').open('wb') as ef:
    subprocess.run([*namespace, native_nix, '--store', 'local', '--option', 'build-users-group', '', '--option', 'substituters', '', '--import'], stdin=f, stdout=of, stderr=ef, check=True)
with (a.evidence / 'verify.stdout').open('wb') as of, (a.evidence / 'verify.stderr').open('wb') as ef:
    subprocess.run([*namespace, native_nix, '--store', 'local', '--option', 'build-users-group', '', '--option', 'substituters', '', '--verify', '--check-contents'], stdout=of, stderr=ef, check=True)
paths = read(a.pack / 'closure/paths.json')
expected = read(a.pack / 'closure/identities.json')
actual = subprocess.check_output([*namespace, native_nix, '--store', 'local', '--option', 'build-users-group', '', '--query', '--hash', *paths], text=True).splitlines()
assert dict(zip(paths, actual)) == expected
assert sorted([{'path': k, 'narHash': v} for k, v in expected.items()], key=lambda r: r['path']) == runtime['closure']
(root / 'bin/sh').symlink_to(runtime['tools']['shell']['path'])
checks = []
for route in ['direct', 'actrun']:
    for mode in ['success', 'failure']:
        for i in range(2):
            label = f'{route}-{mode}-{i}'
            work = root / 'work' / label
            shutil.copytree(a.pack / 'sources' / label, work)
            accepted = read(a.pack / 'accepted' / f'{label}.json')
            assert accepted['commit'] == a.expected_commit
            identity = {k: accepted[k] for k in ['commit', 'tree', 'oracle', 'runtimeIdentity', 'mode', 'target', 'declaredEnv']}
            assert hashlib.sha256(json.dumps(identity, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest() == accepted['x']
            expected_runtime = {k: v['sha256'] for k, v in sorted(runtime['tools'].items())}
            expected_runtime['closure'] = runtime['closureSha256']
            assert accepted['runtimeIdentity'] == expected_runtime
            assert hashlib.sha256((work / 'input.bin').read_bytes()).hexdigest() == accepted['inputSha256']
            for rel, expected_hash in accepted['oracle']:
                assert digest(work / rel) == expected_hash
            env = {'PATH': ':'.join(str(Path(runtime['tools'][k]['path']).parent) for k in ['shell', 'git', 'coreutils']), 'HOME': f'/home/{label}', 'TMPDIR': f'/tmp/{label}', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1', 'OPS_CANDIDATE_NODE': runtime['tools']['node']['path'], 'OPS_CANDIDATE_PYTHON': runtime['tools']['python']['path'], 'OPS_CANDIDATE_TASK': '/retained/bin/task.real', 'OPS_CANDIDATE_X': accepted['x'], 'OPS_CANDIDATE_MODE': mode, 'OPS_CANDIDATE_WORK': f'/work/{label}'}
            for key in ['HOME', 'TMPDIR']:
                (root / env[key].lstrip('/')).mkdir()
            argv = ['/retained/bin/task.real', '--taskfile', f'/work/{label}/Taskfile.yml', '--dir', f'/work/{label}', f'candidate-{mode}']
            if route == 'actrun':
                argv = [runtime['tools']['loader']['path'], '/retained/bin/actrun.real', 'workflow', 'run', f'/work/{label}/candidate/workflow.yml', '--workspace-mode', 'local', '--no-nix', '--run-root', f'/tmp/{label}/runs', '--artifact-root', f'/tmp/{label}/artifacts', '--cache-root', f'/tmp/{label}/cache', '--github-action-cache-root', f'/tmp/{label}/actions', '--registry-root', f'/tmp/{label}/registry']
            with (a.evidence / f'{label}.stdout').open('wb') as of, (a.evidence / f'{label}.stderr').open('wb') as ef:
                r = subprocess.run([*namespace, runtime['tools']['coreutils']['path'], '-i', *[f'{k}={v}' for k, v in env.items()], *argv], stdout=of, stderr=ef, timeout=40)
            assert (r.returncode == 0) == (mode == 'success'), (label, (a.evidence / f'{label}.stderr').read_text())
            result = read(work / 'out' / ('result.json' if mode == 'success' else 'failure.json'))
            assert result['x'] == accepted['x'] and result['inputSha256'] == accepted['inputSha256']
            assert not (work / 'out/forbidden.json').exists()
            if mode == 'success':
                assert result['semantic'] == 'AB'
                leaf = read(a.evidence / f'{label}.stdout' if route == 'direct' else root / f'tmp/{label}/runs/run-1/tasks/pure-check__step_1.stdout.log')
                assert leaf['schema'] == 'ops.taskRuntimeStaticReceipt/1' and leaf['status'] == 'PASS'
                left, right = [read(work / 'out' / f'{n}.json') for n in ['a', 'b']]
                assert max(left['start'], right['start']) < min(left['end'], right['end'])
                assert result['join'] >= max(left['end'], right['end'])
            else:
                assert result['errorClass'] == 'fixture-root-failure' and result['leafExit'] == 7
            for rel, expected_hash in accepted['oracle']:
                assert digest(work / rel) == expected_hash
            checks.append({'route': route, 'mode': mode, 'inputSha256': accepted['inputSha256'], 'x': accepted['x'], 'exit': r.returncode, 'result': result})
probe = """import os,socket,json
assert not os.path.exists('/work/repos/ops.git')
assert not os.path.exists('/nix/var/nix/daemon-socket/socket')
try:
 s=socket.socket(); s.settimeout(1); code=s.connect_ex(('140.82.112.3',443))
except OSError as e:
 code=e.errno
assert code != 0
print(json.dumps({'originalStoreHidden':True,'daemonUnavailable':True,'networkConnectError':code}))
"""
isolation = subprocess.check_output([*namespace, runtime['tools']['python']['path'], '-c', probe], text=True)
emit(a.evidence / 'offline-receipt.json', {'schema': 'ops.taskCandidateOffline/1', 'status': 'PASS', 'commit': a.expected_commit, 'closurePaths': len(paths), 'exportSha256': digest(a.pack / 'closure/runtime.export'), 'runtimeClosureSha256': runtime['closureSha256'], 'bootstrap': bootstrap, 'isolation': json.loads(isolation), 'checks': checks, 'licenseStatus': 'ROOT_LICENSES_RETAINED_DEPENDENCY_AUDIT_PENDING', 'executionHost': {'provider': 'github-actions' if os.environ.get('GITHUB_ACTIONS') == 'true' else 'local', 'runId': os.environ.get('GITHUB_RUN_ID'), 'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'workflowRef': os.environ.get('GITHUB_WORKFLOW_REF')}})
print('fresh full runtime check PASS; dependency license audit remains separately required')
