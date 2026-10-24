"""Verify pinned upstream bytes and record existing native runtime bindings."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile

p = argparse.ArgumentParser()
p.add_argument('--assets', type=Path, required=True)
p.add_argument('--node', required=True)
p.add_argument('--python', required=True)
p.add_argument('--shell', required=True)
p.add_argument('--loader', required=True)
p.add_argument('--git', required=True)
p.add_argument('--coreutils', required=True)
p.add_argument('--out', type=Path, required=True)
p.add_argument('--nix-store', default='/run/current-system/sw/bin/nix-store')
a = p.parse_args()
source = json.loads((Path(__file__).parent.parent / 'source.json').read_text())
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
for filename, key, binary in [('task_linux_amd64.tar.gz', 'goTask', 'task'), ('actrun-linux-x64.tar.gz', 'actrun', 'actrun')]:
    archive = a.assets / filename
    assert sha(archive) == source[key]['archiveSha256'], filename
    with tarfile.open(archive) as t:
        t.extractall(a.assets, filter='data')
    assert sha(a.assets / binary) == source[key]['binarySha256'], binary
paths = dict(node=a.node, python=a.python, shell=a.shell, loader=a.loader, git=a.git, coreutils=a.coreutils, task=str(a.assets.resolve() / 'task'), actrun=str(a.assets.resolve() / 'actrun'))
value = {'schema': 'ops.taskCandidateRuntime/1', 'target': 'linux-amd64', 'tools': {k: {'path': str(Path(v).resolve()), 'sha256': sha(v)} for k, v in paths.items()}}
native_roots = sorted({'/' + '/'.join(Path(t['path']).resolve().parts[1:4]) for t in value['tools'].values() if t['path'].startswith('/nix/store/')})
ro = [a.nix_store, '--extra-experimental-features', 'read-only-local-store', '--store', 'local?read-only=true']
closure_paths = subprocess.check_output([*ro, '--query', '--requisites', *native_roots], text=True).splitlines()
hashes = subprocess.check_output([*ro, '--query', '--hash', *closure_paths], text=True).splitlines()
assert len(closure_paths) == len(hashes)
value['closure'] = sorted([{'path': p, 'narHash': h} for p, h in zip(closure_paths, hashes)], key=lambda r: r['path'])
value['closureSha256'] = hashlib.sha256(json.dumps(value['closure'], separators=(',', ':')).encode()).hexdigest()
value['profile'] = 'candidate-user-task-SAME-v5.1'
value['admission'] = 'NOT_ADOPTED'
a.out.write_text(json.dumps(value, indent=2) + '\n')
subprocess.run([paths['task'], '--version'], check=True)
subprocess.run([paths['loader'], paths['actrun'], '--help'], check=True, stdout=subprocess.DEVNULL)
print(a.out)
