"""Bounded negative tests of the exact restore binding assertions; no import replay."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile

module_path = Path(__file__).parents[1] / 'candidate/restore_contract.py'
spec = importlib.util.spec_from_file_location('restore_contract', module_path)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
profile = json.loads((module_path.parent / 'native-profile.json').read_text())
passed = []
def reject(name, f):
    try:
        f()
    except (AssertionError, KeyError, ValueError):
        passed.append(name)
        return
    raise AssertionError('false PASS: ' + name)
c.closure_binding(profile, profile['closureSha256'])
observed={r['path']:r['narHash'] for r in profile['closure']}
c.verify_native_closure(profile,observed,list(observed))
reject('missing-native-root-reference',lambda:c.verify_native_closure(profile,observed,list(observed)[1:]))
reject('extra-native-root-reference',lambda:c.verify_native_closure(profile,observed,[*observed,'/nix/store/unexpected']))
wrong=observed.copy();wrong[next(iter(wrong))]='wrong'
reject('wrong-actual-native-nar',lambda:c.verify_native_closure(profile,wrong,list(wrong)))
bad = copy.deepcopy(profile); bad['closure'][0]['narHash'] += 'wrong'
reject('closure-record-change-with-unchanged-external-digest', lambda: c.closure_binding(bad, profile['closureSha256']))
bad['closureSha256'] = c.sha(json.dumps(bad['closure'], separators=(',', ':')).encode())
reject('self-consistent-closure-versus-external-digest', lambda: c.closure_binding(bad, profile['closureSha256']))
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp); assets = root / 'assets'; assets.mkdir()
    fixture = {'tools': {}}
    for name in profile['tools']:
        f = assets / (name + '.real') if name in ['task','actrun'] else root / name
        f.write_bytes(name.encode())
        fixture['tools'][name] = {'path': '/' + name, 'sha256': c.sha(name.encode())}
    c.verify_tool_hashes(fixture, {k:v['sha256'] for k,v in fixture['tools'].items()})
    for name in profile['tools']:
        f = assets / (name + '.real') if name in ['task','actrun'] else root / name
        original = f.read_bytes(); f.write_bytes(b'changed')
        reject('actual-restored-' + name, lambda: c.verify_tool_hashes(fixture, {k:c.sha((assets/(k+'.real') if k in ['task','actrun'] else root/k).read_bytes()) for k in fixture['tools']}))
        f.write_bytes(original)
        hashes={k:v['sha256'] for k,v in fixture['tools'].items()};hashes[name]='0'*64
        reject('namespace-tool-hash-'+name,lambda:c.verify_tool_hashes(fixture,hashes))
    archive = root / 'source.tar'
    with tarfile.open(archive, 'w') as t:
        data = b'{"exact":"source"}'
        member = tarfile.TarInfo('packages/ops-task-runtime/source.json'); member.size=len(data)
        t.addfile(member, io.BytesIO(data))
    oracle = root / 'oracle.json'
    oracle.write_text(json.dumps({'commit':'a'*40,'tree':'b'*40,'archiveSha256':c.sha(archive.read_bytes()),'oracle':[['source.json',c.sha(data)]]}))
    external = c.sha(oracle.read_bytes())
    c.source_binding(archive, oracle, external, 'a'*40) # No original repo exists.
    reject('source-external-oracle-mismatch', lambda:c.source_binding(archive, oracle, '0'*64,'a'*40))
    archive.write_bytes(archive.read_bytes()+b'changed')
    reject('retained-source-byte-mismatch',lambda:c.source_binding(archive,oracle,external,'a'*40))
accepted={'declaredEnv':c.DECLARED_ENV,'x':'test','mode':'success'}
env=c.execution_env(profile,accepted,'test')
assert env['PATH'].split(':')[0]=='/retained/bin' and env['BASH_ENV']==env['ENV']==''
for field in ['PATH','BASH_ENV','ENV']:
    bad=copy.deepcopy(accepted);bad['declaredEnv'][field]='changed'
    reject('declared-env-'+field,lambda:c.execution_env(profile,bad,'test'))
print(json.dumps({'status':'PASS','negativeCases':passed,'positive':['closure','all-tool-bytes','retained-source-with-no-original-repo','declared-env']}))

license_spec = importlib.util.spec_from_file_location('license_contract', module_path.parent/'license_contract.py')
lc = importlib.util.module_from_spec(license_spec); license_spec.loader.exec_module(lc)
packet = module_path.parent/'dependency-licenses.json'
assessment=lc.assess_dependency_licenses(profile,packet)
assert assessment['paths']==151
if assessment['missing']:
    reject('required-embedded-license-bytes-missing',lambda:lc.verify_dependency_licenses(profile,packet))
else:
    lc.verify_dependency_licenses(profile,packet)
with tempfile.TemporaryDirectory() as tmp:
    changed=Path(tmp)/'packet.json'; value=json.loads(packet.read_text())
    value['entries'][0]['narHash']='wrong';changed.write_text(json.dumps(value))
    reject('dependency-license-packet-byte-change',lambda:lc.verify_dependency_licenses(profile,changed))
    altered=copy.deepcopy(profile);altered['dependencyLicenses']['sha256']=c.sha(changed.read_bytes())
    reject('dependency-license-self-consistent-wrong-closure',lambda:lc.verify_dependency_licenses(altered,changed))
print(json.dumps({'status':'PASS','dependencyLicenseNegatives':passed[-2:]}))
