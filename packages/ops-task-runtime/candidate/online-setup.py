"""Actual Actions online setup through native signed Nix cache; no publication."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import urllib.request
from license_contract import verify_dependency_licenses, assess_dependency_licenses

p = argparse.ArgumentParser()
p.add_argument('--profile', type=Path, required=True)
p.add_argument('--assets', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
p.add_argument('--verify-existing', action='store_true', help='local identity check only; no online/cache proof')
p.add_argument('--nix-store', default='nix-store')
a = p.parse_args()
a.assets.mkdir(parents=True, exist_ok=True)
a.out.mkdir()
profile = json.loads(a.profile.read_text())
source = json.loads((Path(__file__).parent.parent / 'source.json').read_text())
def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def run(cmd, name):
    with (a.out / name).open('wb') as f:
        subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, check=True, timeout=600)
if not a.verify_existing:
    run(['nix', '--extra-experimental-features', 'nix-command', 'copy', '--from', 'https://cache.nixos.org', '--option', 'require-sigs', 'true', *profile['nativeRoots']], 'nix-copy.log')
    run(['nix', '--extra-experimental-features', 'nix-command', 'store', 'verify', '--recursive', '--sigs-needed', '1', *profile['nativeRoots']], 'nix-signatures-and-contents.log')
    for filename, key in [('task_linux_amd64.tar.gz', 'goTask'), ('actrun-linux-x64.tar.gz', 'actrun')]:
        entry = source[key]
        url = f"https://github.com/{entry['repository']}/releases/download/{entry['tag']}/{filename}"
        with urllib.request.urlopen(url, timeout=60) as response, (a.assets / filename).open('xb') as f:
            while chunk := response.read(1048576):
                f.write(chunk)
for filename, key, binary in [('task_linux_amd64.tar.gz', 'goTask', 'task'), ('actrun-linux-x64.tar.gz', 'actrun', 'actrun')]:
    archive = a.assets / filename
    assert digest(archive) == source[key]['archiveSha256']
    with tarfile.open(archive) as t:
        for member in t.getmembers():
            assert not member.name.startswith('/') and '..' not in Path(member.name).parts
            assert not member.issym() and not member.islnk()
        t.extractall(a.assets, filter='data')
    assert digest(a.assets / binary) == source[key]['binarySha256']
runtime = copy.deepcopy(profile)
for tool, row in runtime['tools'].items():
    row['path'] = row['path'].replace('@ASSETS@', str(a.assets.resolve()))
    assert digest(row['path']) == row['sha256'], f'actual binary mismatch: {tool}'
paths = [r['path'] for r in profile['closure']]
query = [a.nix_store]
if a.verify_existing:
    query += ['--extra-experimental-features', 'read-only-local-store', '--store', 'local?read-only=true']
actual = subprocess.check_output([*query, '--query', '--hash', *paths], text=True).splitlines()
assert actual == [r['narHash'] for r in profile['closure']], 'actual native closure identity'
assert hashlib.sha256(json.dumps(profile['closure'], separators=(',', ':')).encode()).hexdigest() == profile['closureSha256']
license_root = a.out / 'licenses'
license_root.mkdir()
license_receipts = []
for row in profile['licenses']:
    if row['tool'] == 'python':
        data = (Path(runtime['tools']['python']['path']).parent.parent / 'lib/python3.13/LICENSE.txt').read_bytes()
    elif row['tool'] == 'task':
        data = (a.assets / 'LICENSE').read_bytes()
    elif a.verify_existing:
        data = (a.assets / row['fileName']).read_bytes()
    else:
        with urllib.request.urlopen(row['source'], timeout=60) as response:
            data = response.read()
    assert hashlib.sha256(data).hexdigest() == row['sha256'], 'root license byte mismatch: ' + row['tool']
    (license_root / (row['tool'] + '.LICENSE.txt')).write_bytes(data)
    license_receipts.append(row)
dependency_receipt = assess_dependency_licenses(profile, Path(__file__).parent / 'dependency-licenses.json')
(a.out / 'dependency-license-receipt.json').write_text(json.dumps(dependency_receipt, indent=2) + '\n')
verify_dependency_licenses(profile, Path(__file__).parent / 'dependency-licenses.json')
(a.out / 'root-license-receipt.json').write_text(json.dumps({'status': 'ROOT_BYTES_VERIFIED_NATIVE_DEPENDENCY_DECLARATIONS_BOUND', 'licenses': license_receipts}, indent=2) + '\n')
(a.out / 'runtime.json').write_text(json.dumps(runtime, indent=2) + '\n')
(a.out / 'setup-receipt.json').write_text(json.dumps({'schema': 'ops.taskCandidateOnlineSetup/1', 'status': 'LOCAL_IDENTITY_ONLY' if a.verify_existing else 'PASS', 'runtimeClosureSha256': profile['closureSha256'], 'profileSha256': digest(a.profile), 'nativeRoots': profile['nativeRoots'], 'signedCache': None if a.verify_existing else 'https://cache.nixos.org', 'provider': {'runId': os.environ.get('GITHUB_RUN_ID'), 'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'workflowSha': os.environ.get('GITHUB_SHA')}}, indent=2) + '\n')
print(a.out / 'runtime.json')
