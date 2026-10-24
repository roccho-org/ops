"""Candidate restore assertions shared by the native check and bounded negatives."""
import hashlib
import io
import json
from pathlib import Path
import tarfile

DECLARED_ENV = {'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1', 'HOME': '<attempt>/home', 'TMPDIR': '<attempt>/tmp', 'PATH': '<bound task+shell+git+coreutils bins>', 'BASH_ENV': '', 'ENV': '', 'OPS_CANDIDATE_WORK': '<attempt>/work'}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def closure_binding(runtime, external):
    rows = runtime['closure']
    assert rows and rows == sorted(rows, key=lambda r: r['path'])
    assert len({r['path'] for r in rows}) == len(rows)
    assert all(set(r) == {'path', 'narHash'} for r in rows)
    assert sha(json.dumps(rows, separators=(',', ':')).encode()) == runtime['closureSha256'] == external, 'closure digest binding'
    return {r['path']: r['narHash'] for r in rows}

def source_binding(archive, oracle, external_sha, commit):
    assert sha(oracle.read_bytes()) == external_sha, 'external retained source oracle'
    expected = json.loads(oracle.read_text())
    assert expected['commit'] == commit
    data = archive.read_bytes()
    assert sha(data) == expected['archiveSha256'], 'retained source archive'
    rows = []
    source = None
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        for m in t.getmembers():
            assert not m.name.startswith('/') and '..' not in Path(m.name).parts
            if m.isfile():
                content = t.extractfile(m).read()
                rel = m.name.removeprefix('packages/ops-task-runtime/')
                rows.append([rel, sha(content)])
                if rel == 'source.json':
                    source = json.loads(content)
    assert sorted(rows) == expected['oracle'] and source is not None
    return expected, source

def execution_env(runtime, accepted, label):
    assert accepted['declaredEnv'] == DECLARED_ENV, 'declared environment contract'
    # Binding-relative bins are equivalent; absolute attempt/assets locators are
    # the predeclared normalization, never changes to tool bytes or bin order.
    bins = ['/retained/bin'] + [str(Path(runtime['tools'][k]['path']).parent) for k in ['shell', 'git', 'coreutils']]
    return {'PATH': ':'.join(bins), 'HOME': f'/home/{label}', 'TMPDIR': f'/tmp/{label}', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1', 'BASH_ENV': '', 'ENV': '', 'OPS_CANDIDATE_NODE': runtime['tools']['node']['path'], 'OPS_CANDIDATE_PYTHON': runtime['tools']['python']['path'], 'OPS_CANDIDATE_TASK': '/retained/bin/task', 'OPS_CANDIDATE_X': accepted['x'], 'OPS_CANDIDATE_MODE': accepted['mode'], 'OPS_CANDIDATE_WORK': f'/work/{label}'}

def verify_tool_hashes(runtime, observed):
    assert set(observed) == set(runtime['tools'])
    for name, row in runtime['tools'].items():
        assert observed[name] == row['sha256'], 'restored namespace actual tool: ' + name

def verify_native_closure(runtime, observed, requisites):
    expected = {r['path']:r['narHash'] for r in runtime['closure']}
    assert observed == expected, 'restored actual NAR identities'
    assert set(requisites) == set(expected), 'native required root references differ'
