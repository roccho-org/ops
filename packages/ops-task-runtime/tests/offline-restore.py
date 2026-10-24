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
p.add_argument('--reuse-closure-pack', type=Path, help='explicit verified retained bytes; target is still fresh and offline')
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
if a.reuse_closure_pack:
    old = a.reuse_closure_pack.resolve()
    old_manifest = read(old / 'MANIFEST.json')
    retained_files = {r['path']: r for r in old_manifest['files']}
    for rel in ['closure/runtime.export', 'closure/paths.json', 'closure/identities.json', 'runtime.json', 'bootstrap/target-nix.tar.gz', 'bootstrap/identity.json']:
        assert digest(old / rel) == retained_files[rel]['sha256'], 'retained byte mismatch: ' + rel
    assert read(old / 'runtime.json')['closureSha256'] == runtime['closureSha256']
    assert sorted([{'path': p, 'narHash': h} for p, h in read(old / 'closure/identities.json').items()], key=lambda r:r['path']) == runtime['closure']
    shutil.copyfile(old / 'closure/runtime.export', export)
else:
    with export.open('wb') as f:
        run([*ro, '--export', *paths], stdout=f)
hashes = subprocess.check_output([*ro, '--query', '--hash', *paths], text=True).splitlines()
assert len(hashes) == len(paths)
emit(a.out / 'closure-identities.json', dict(zip(paths, hashes)))
print('whole runtime export', len(paths), export.stat().st_size, flush=True)
# Existing portable pack owns explicit payload bytes, not dependency inference.
native_nix = Path(a.nix_store).resolve().parent / 'nix-store'
nix_root = '/' + '/'.join(native_nix.parts[1:4])
bootstrap_paths = subprocess.check_output([*ro, '--query', '--requisites', nix_root], text=True).splitlines()
emit(a.out / 'bootstrap-identity.json', {'nixStore': str(native_nix), 'paths': bootstrap_paths, 'authority': 'prepared target native Nix bootstrap; not preinstalled candidate runtime'})
if a.reuse_closure_pack:
    assert read(a.reuse_closure_pack / 'bootstrap/identity.json')['nixStore'] == str(native_nix)
    shutil.copyfile(a.reuse_closure_pack / 'bootstrap/target-nix.tar.gz', a.out / 'target-nix.tar.gz')
else:
    with tarfile.open(a.out / 'target-nix.tar.gz', 'w:gz', compresslevel=1) as t:
        for src in bootstrap_paths:
            t.add(src, arcname='nix/store/' + Path(src).name)
emit(a.out / 'closure-retention.json', {'retainedPack': str(a.reuse_closure_pack) if a.reuse_closure_pack else None, 'exportSha256': digest(export), 'closureSha256': runtime['closureSha256'], 'freshTargetRequired': True})
spec = {'tools': [{'name': k, 'source': t['path']} for k, t in runtime['tools'].items()]}
first = spec['tools'][0]
first['files'] = [{'source': str(export), 'path': 'closure/runtime.export'}, {'source': str(a.out / 'closure-paths.json'), 'path': 'closure/paths.json'}, {'source': str(a.out / 'closure-identities.json'), 'path': 'closure/identities.json'}, {'source': str(a.runtime.resolve()), 'path': 'runtime.json'}, {'source': str(a.out / 'target-nix.tar.gz'), 'path': 'bootstrap/target-nix.tar.gz'}, {'source': str(a.out / 'bootstrap-identity.json'), 'path': 'bootstrap/identity.json'}]
license_paths = [a.assets / 'Node.LICENSE.txt', a.assets / 'actrun.LICENSE.txt', a.assets / 'LICENSE', Path(runtime['tools']['python']['path']).resolve().parent.parent / 'lib/python3.13/LICENSE.txt']
for row, license_path in zip(runtime.get('licenses', []), license_paths):
    assert digest(license_path) == row['sha256'], 'declared root license byte mismatch'
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
with tarfile.open(archive, 'w:gz', compresslevel=1) as t:
    t.add(pack, arcname='.')
request = {'schema': 'carrier-job/2', 'request_id': 'task-candidate-offline', 'sources': [{'name': archive.name, 'url': archive.as_uri(), 'bytes': archive.stat().st_size, 'sha256': digest(archive)}], 'payload': {'source': archive.name, 'codec': 'raw'}}
emit(a.out / 'carrier-request.json', request)
carrier_cli = a.repo / 'packages/chatgpt-capability/ingress/carrier-job.mjs'
materialized = a.out / 'materialized'
run([runtime['tools']['node']['path'], carrier_cli, 'materialize', '--request', a.out / 'carrier-request.json', '--out', materialized], stdout=subprocess.DEVNULL)
run([runtime['tools']['node']['path'], carrier_cli, 'verify', '--input', materialized, '--receipt', a.out / 'carrier-receipt.json'], stdout=subprocess.DEVNULL)
recovered = a.out / 'recovered-pack'
with tarfile.open(materialized / 'files' / archive.name) as t:
    t.extractall(recovered, filter='data')
# Use the transported and independently verified bytes, never the build pack.
# Use the same retained-pack native restore check locally and on actual Actions.
commit = read(a.e2e / 'direct-success/invocation.json')['commit']
run([runtime['tools']['python']['path'], a.repo / 'packages/ops-task-runtime/candidate/restore-check.py', '--pack', recovered, '--target', a.out / 'fresh-root', '--evidence', a.out / 'restored-check', '--expected-commit', commit, '--expected-runtime-closure', runtime['closureSha256'], '--source-repo', a.repo], env={**os.environ, 'OPS_CANDIDATE_GIT': runtime['tools']['git']['path']})
print('full Carrier and fresh native restore check PASS', flush=True)
