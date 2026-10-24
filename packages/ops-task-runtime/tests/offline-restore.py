"""Finite native Nix closure/Carrier/fresh namespace proof. No store inference."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

p = argparse.ArgumentParser()
p.add_argument('--runtime', type=Path, required=True)
p.add_argument('--repo', type=Path, required=True)
p.add_argument('--e2e', type=Path, required=True)
p.add_argument('--assets', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
p.add_argument('--nix-store', default='/run/current-system/sw/bin/nix-store')
a = p.parse_args()
a.repo = a.repo.resolve()
a.out.mkdir()
read = lambda f: json.loads(Path(f).read_text())
def digest(p):
    h = hashlib.sha256()
    with Path(p).open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()
def emit(p, x):
    Path(p).write_text(json.dumps(x, indent=2, sort_keys=True) + '\n')
def run(argv, **kwargs):
    return subprocess.run([str(x) for x in argv], check=True, **kwargs)
runtime = read(a.runtime)
for key, t in runtime['tools'].items():
    assert digest(t['path']) == t['sha256'], key
ro = [a.nix_store, '--extra-experimental-features', 'read-only-local-store', '--store', 'local?read-only=true']
roots = sorted({'/' + '/'.join(Path(t['path']).resolve().parts[1:4]) for t in runtime['tools'].values() if t['path'].startswith('/nix/store/')})
paths = subprocess.check_output([*ro, '--query', '--requisites', *roots], text=True).splitlines()
emit(a.out / 'closure-paths.json', paths)
export = a.out / 'runtime.export'
with export.open('wb') as f:
    run([*ro, '--export', *paths], stdout=f)
hashes = subprocess.check_output([*ro, '--query', '--hash', *paths], text=True).splitlines()
assert len(hashes) == len(paths)
emit(a.out / 'closure-identities.json', dict(zip(paths, hashes)))
print('whole runtime export', len(paths), export.stat().st_size, flush=True)
# Existing portable pack owns explicit payload bytes, not dependency inference.
spec = {'tools': [{'name': k, 'source': t['path']} for k, t in runtime['tools'].items()]}
first = spec['tools'][0]
first['files'] = [{'source': str(export), 'path': 'closure/runtime.export'}, {'source': str(a.out / 'closure-paths.json'), 'path': 'closure/paths.json'}, {'source': str(a.out / 'closure-identities.json'), 'path': 'closure/identities.json'}, {'source': str(a.runtime.resolve()), 'path': 'runtime.json'}]
license_paths = [a.assets / 'actrun.LICENSE.txt', a.assets / 'node.LICENSE.txt', a.assets / 'LICENSE', Path(runtime['tools']['python']['path']).resolve().parent.parent / 'lib/python3.13/LICENSE.txt']
for i, license_path in enumerate(license_paths):
    assert license_path.is_file(), license_path
    first['files'].append({'source': str(license_path.resolve()), 'path': f'licenses/{i}-{license_path.name}'})
# Hold the actual accepted package source and inputs, not an approximate checkout.
for route in ['direct', 'actrun']:
    for mode in ['success', 'failure']:
        invocation = read(a.e2e / f'{route}-{mode}/invocation.json')
        for i, record in enumerate(invocation['accepted']):
            first.setdefault('directories', []).append({'source': str(Path(record['dir']) / 'snapshot'), 'path': f'sources/{route}-{mode}-{i}'})
            accepted = Path(record['dir']) / 'accepted.json'
            first['files'].append({'source': str(accepted), 'path': f'accepted/{route}-{mode}-{i}.json'})
        first['files'].append({'source': str(a.e2e / f'{route}-{mode}/source.tar'), 'path': f'git-source/{route}-{mode}.tar'})
emit(a.out / 'tool-spec.json', spec)
pack = a.out / 'pack'
pack_cli = a.repo / 'packages/ops-portable-runtime-pack/bin/ops-portable-runtime-pack.py'
run([runtime['tools']['python']['path'], pack_cli, 'create', '--target-system', 'x86_64-linux', '--tool-spec', a.out / 'tool-spec.json', '--out-dir', pack], stdout=subprocess.DEVNULL)
run([runtime['tools']['python']['path'], pack_cli, 'validate', '--pack-dir', pack], stdout=subprocess.DEVNULL)
archive = a.out / 'payload.tar.gz'
with tarfile.open(archive, 'w:gz') as t:
    t.add(pack, arcname='.')
carrier = a.out / 'payload.b64.txt'
# Canonical one-line Base64, streamed on multiples of three bytes.
with archive.open('rb') as src, carrier.open('wb') as dst:
    for chunk in iter(lambda: src.read(3 * 1024 * 1024), b''):
        dst.write(base64.b64encode(chunk))
request = {'schema': 'carrier-job/1', 'request_id': 'task-candidate-offline', 'sources': [{'name': carrier.name, 'url': carrier.as_uri(), 'sha256': digest(carrier)}], 'carrier_name': carrier.name, 'payload_sha256': digest(archive)}
emit(a.out / 'carrier-request.json', request)
carrier_cli = a.repo / 'packages/chatgpt-capability/ingress/carrier-job.mjs'
materialized = a.out / 'materialized'
run([runtime['tools']['node']['path'], carrier_cli, 'materialize', '--request', a.out / 'carrier-request.json', '--out', materialized], stdout=subprocess.DEVNULL)
run([runtime['tools']['node']['path'], carrier_cli, 'verify', '--input', materialized, '--receipt', a.out / 'carrier-receipt.json'], stdout=subprocess.DEVNULL)
# Native Nix is a prepared-target prerequisite. Copy only its exact bootstrap
# closure, never the candidate Node/Python roots. Original host store is chrooted out.
native_nix = Path(a.nix_store).resolve().parent / 'nix-store'
nix_root = '/' + '/'.join(Path(a.nix_store).resolve().parts[1:4])
bootstrap = subprocess.check_output([*ro, '--query', '--requisites', nix_root], text=True).splitlines()
emit(a.out / 'bootstrap-paths.json', bootstrap)
root = a.out / 'fresh-root'
(root / 'nix/store').mkdir(parents=True)
for src in bootstrap:
    dest = root / src.lstrip('/')
    if Path(src).is_dir():
        shutil.copytree(src, dest, symlinks=True)
    else:
        shutil.copy2(src, dest)
for d in ['proc', 'etc', 'tmp', 'home', 'dev', 'bin', 'work', 'nix/var/nix/db', 'nix/var/nix/profiles', 'nix/var/nix/gcroots']:
    (root / d).mkdir(parents=True, exist_ok=True)
(root / 'etc/passwd').write_text('root:x:0:0:root:/home:/bin/sh\n')
(root / 'etc/group').write_text('root:x:0:\n')
(root / 'dev/null').touch()
for k in ['node', 'python']:
    assert not (root / Path(runtime['tools'][k]['path']).resolve().as_posix().lstrip('/')).exists(), 'target runtime already present'
restored = root / 'retained'
restored.mkdir()
with tarfile.open(materialized / 'payload.bin') as t:
    t.extractall(restored, filter='data')
# Verify every retained file again before import; pack validate does not need wrappers.
manifest = read(restored / 'MANIFEST.json')
for row in manifest['files']:
    assert digest(restored / row['path']) == row['sha256']
namespace = ['/run/current-system/sw/bin/unshare', '--user', '--map-root-user', '--mount', '--net', '--pid', '--fork', f'--mount-proc={root}/proc', '/run/current-system/sw/bin/chroot', root]
with (restored / 'closure/runtime.export').open('rb') as f, (a.out / 'import.stdout').open('wb') as stdout, (a.out / 'import.stderr').open('wb') as stderr:
    run([*namespace, native_nix, '--store', 'local', '--option', 'build-users-group', '', '--option', 'substituters', '', '--import'], stdin=f, stdout=stdout, stderr=stderr)
# Entire closure verification uses native Nix and retained expected NAR hashes.
with (a.out / 'verify.stdout').open('wb') as stdout, (a.out / 'verify.stderr').open('wb') as stderr:
    run([*namespace, native_nix, '--store', 'local', '--option', 'build-users-group', '', '--option', 'substituters', '', '--verify', '--check-contents'], stdout=stdout, stderr=stderr)
actual = subprocess.check_output([*namespace, native_nix, '--store', 'local', '--option', 'build-users-group', '', '--query', '--hash', *paths], text=True).splitlines()
assert actual == hashes, 'imported NAR identity mismatch'
(root / 'bin/sh').symlink_to(runtime['tools']['shell']['path'])
checks = []
for route in ['direct', 'actrun']:
    for mode in ['success', 'failure']:
        for i in range(2):
            label = f'{route}-{mode}-{i}'
            work = root / 'work' / label
            shutil.copytree(restored / 'sources' / label, work)
            accepted = read(restored / 'accepted' / f'{label}.json')
            for rel, expected in accepted['oracle']:
                assert digest(work / rel) == expected
            env = {'PATH': ':'.join([str(Path(runtime['tools'][k]['path']).parent) for k in ['shell', 'git', 'coreutils']]), 'HOME': f'/home/{label}', 'TMPDIR': f'/tmp/{label}', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1', 'OPS_CANDIDATE_NODE': str(Path(runtime['tools']['node']['path']).resolve()), 'OPS_CANDIDATE_PYTHON': str(Path(runtime['tools']['python']['path']).resolve()), 'OPS_CANDIDATE_TASK': '/retained/bin/task.real', 'OPS_CANDIDATE_X': accepted['x'], 'OPS_CANDIDATE_MODE': mode, 'OPS_CANDIDATE_WORK': f'/work/{label}'}
            for key in ['HOME', 'TMPDIR']:
                (root / env[key].lstrip('/')).mkdir()
            argv = ['/retained/bin/task.real', '--taskfile', f'/work/{label}/Taskfile.yml', '--dir', f'/work/{label}', f'candidate-{mode}']
            if route == 'actrun':
                argv = [runtime['tools']['loader']['path'], '/retained/bin/actrun.real', 'workflow', 'run', f'/work/{label}/candidate/workflow.yml', '--workspace-mode', 'local', '--no-nix', '--run-root', f'/tmp/{label}/runs']
            stdout = a.out / f'{label}.stdout'; stderr = a.out / f'{label}.stderr'
            with stdout.open('wb') as of, stderr.open('wb') as ef:
                r = subprocess.run([str(x) for x in [*namespace, runtime['tools']['coreutils']['path'], '-i', *[f'{k}={v}' for k, v in env.items()], *argv]], stdout=of, stderr=ef, timeout=40)
            assert (r.returncode == 0) == (mode == 'success'), (label, stderr.read_text())
            result = read(work / 'out' / ('result.json' if mode == 'success' else 'failure.json'))
            assert result['x'] == accepted['x'] and result['inputSha256'] == accepted['inputSha256']
            assert not (work / 'out/forbidden.json').exists()
            if mode == 'success':
                assert result['semantic'] == 'AB'
                left, right = [read(work / 'out' / f'{n}.json') for n in ['a', 'b']]
                assert max(left['start'], right['start']) < min(left['end'], right['end'])
                assert result['join'] >= max(left['end'], right['end'])
            else:
                assert result['errorClass'] == 'fixture-root-failure' and result['leafExit'] == 7
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
isolation = subprocess.check_output([str(x) for x in [*namespace, Path(runtime['tools']['python']['path']).resolve(), '-c', probe]], text=True)
emit(a.out / 'offline-receipt.json', {'schema': 'ops.taskCandidateOffline/1', 'status': 'PASS', 'closurePaths': len(paths), 'exportSha256': digest(export), 'payloadSha256': digest(archive), 'carrierSha256': digest(carrier), 'bootstrapPaths': bootstrap, 'isolation': json.loads(isolation), 'checks': checks, 'licenseStatus': 'ROOT_LICENSES_RETAINED_DEPENDENCY_AUDIT_PENDING'})
print('fresh whole runtime check PASS; dependency license audit and actual Actions still required', flush=True)
