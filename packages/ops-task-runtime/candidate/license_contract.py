"""Retained byte/provenance assertions. Completeness needs independent review."""
import base64
import hashlib
import json
from pathlib import Path
import re

class MissingLicenseBytes(AssertionError):
    pass

def _sha(data):
    return hashlib.sha256(data).hexdigest()

def _hash_bytes(value):
    if value.startswith('sha256-'):
        data=base64.b64decode(value[7:],validate=True)
    elif re.fullmatch('[0-9a-f]{64}',value):
        data=bytes.fromhex(value)
    elif re.fullmatch('[0123456789abcdfghijklmnpqrsvwxyz]{52}',value):
        alphabet='0123456789abcdfghijklmnpqrsvwxyz';n=0
        for c in value:n=n*32+alphabet.index(c)
        data=n.to_bytes(32,'little')
    else:
        raise AssertionError('unsupported source hash format')
    assert len(data)==32
    return data

def assess_dependency_licenses(runtime, packet, blob_root=None):
    """Validate bytes first; return explicit Missing without granting a PASS."""
    packet=Path(packet);data=packet.read_bytes();binding=runtime['dependencyLicenses']
    assert _sha(data)==binding['sha256'], 'dependency license packet bytes'
    value=json.loads(data)
    assert value['runtimeClosureSha256']==runtime['closureSha256']
    assert [{'path':r['path'],'narHash':r['narHash']} for r in value['entries']]==runtime['closure'], 'dependency license exact closure'
    coverage=value.get('byteCoverage')
    if not coverage:
        return {'status':'MISSING_LICENSE_BYTES','paths':len(value['entries']),'missing':['retained-license-byte-coverage'],'claim':'declarations alone are insufficient'}
    root=Path(blob_root) if blob_root else packet.parent/'license-bytes'
    blobs={}
    for h,row in coverage['blobs'].items():
        assert re.fullmatch('[0-9a-f]{64}',h) and row['file']==h, 'confined license byte path'
        p=root/h
        assert p.is_file() and not p.is_symlink(), 'required license bytes missing: '+h
        raw=p.read_bytes()
        assert len(raw)==row['bytes'] and _sha(raw)==h, 'required license bytes changed: '+h
        blobs[h]=raw
    def blob(h):
        assert h in blobs, 'required license blob reference missing: '+h
        return blobs[h]
    plan_data=blob(coverage['acquisitionPlanBlobSha256'])
    assert _sha(plan_data)==coverage['acquisitionPlanSha256']
    plan=json.loads(plan_data)
    assert plan['runtimeClosureSha256']==runtime['closureSha256']
    plan_components={c['outputPath']:c for c in plan['components']}
    assert len(plan_components)==len(plan['components'])==len(runtime['closure'])
    assert set(plan_components)=={r['path'] for r in runtime['closure']}
    components=coverage['components']
    assert set(components)==set(plan_components), 'missing license component coverage'
    planned={s['id']:s for s in plan['sources']}
    actual=coverage['sourceMetadata']
    assert len(planned)==len(plan['sources']) and set(actual)==set(planned), 'missing exact source provenance'
    missing=[]
    for sid,s in planned.items():
        r=actual[sid]
        assert r['path']==s['path'] and r['origins']==s['origins'] and r['resolvedHttpsUrls']==s['resolvedHttpsUrls']
        identity=r['identity']
        if s['outputHash']:
            assert _hash_bytes(identity['expected'])==_hash_bytes(identity['actual'])==_hash_bytes(s['outputHash']), 'fixed source identity mismatch'
            assert identity['mode']==s['outputHashMode']
        else:
            assert identity['expected']==identity['actual']==s['localSha256'], 'native source identity mismatch'
        for notice in r['notices']:
            blob(notice['blobSha256'])
            assert notice['member'] and not notice['member'].startswith('/') and '..' not in Path(notice['member']).parts
        if not r['notices']:missing.append('upstream-notices:'+sid)
    for row in value['entries']:
        c=components[row['path']];expected=plan_components[row['path']]
        assert all(c[k]==v for k,v in expected.items()), 'component/source/patch coverage mismatch'
        assert c['narHash']==row['narHash'] and c['nixpkgsSource']==row['source'] and c['nixpkgsSourceNarHash']==row['sourceNarHash']
        assert c['definitionSha256']==row['definitionSha256']==_sha(blob(c['definitionBlobSha256'])), 'retained source definition bytes'
        assert c['upstreamSourceIds'] and all(sid in actual for sid in c['upstreamSourceIds']+c['patchSourceIds'])
    assert set(coverage['definitionSources'])==set(value['sourceNarHashes'])
    for source,row in coverage['definitionSources'].items():
        assert row['sourceNarHash']==value['sourceNarHashes'][source] and row['member']=='COPYING'
        blob(row['blobSha256'])
    roots=coverage['rootTools']
    assert set(roots)=={r['tool'] for r in runtime['licenses']}
    for row in runtime['licenses']:
        r=roots[row['tool']]
        assert r['toolSha256']==runtime['tools'][row['tool']]['sha256']
        assert r['source']==row['source'] and _sha(blob(r['blobSha256']))==row['sha256']
        for match in r['upstreamMatches']:
            assert any(n['member']==match['member'] and n['blobSha256']==r['blobSha256'] for n in actual[match['sourceId']]['notices'])
    embedded=coverage['embedded']
    for row in embedded['provenanceFiles']:
        assert _sha(blob(row['blobSha256']))==row['sha256']
    task=embedded['tools']['task'];actrun=embedded['tools']['actrun']
    assert task['toolSha256']==runtime['tools']['task']['sha256'] and actrun['toolSha256']==runtime['tools']['actrun']['sha256']
    buildinfo=blob(task['buildInfoBlobSha256'])
    assert _sha(buildinfo)==task['buildInfoSha256']
    modules=[line.split('\t')[1:] for line in buildinfo.decode().splitlines() if line.startswith(('dep\t','mod\t'))]
    assert modules==[[m[k] for k in ['path','version','h1']] for m in task['modules']], 'embedded module inventory differs from binary build information'
    for m in task['modules']:
        if m['path']=='github.com/go-task/task/v3':
            assert m['status']=='ROOT_PROJECT_NOTICE' and m['noticeRefs']==[roots['task']['blobSha256']]
            blob(m['noticeRefs'][0])
        else:
            # This packet version captures observed pending identities. It has
            # no evidence format admitting a generic/root notice for a third
            # party module; source-h1 verified integration must precede closure.
            assert m['status']=='MISSING_MODULE_NOTICE_BYTES' and not m['noticeRefs'], 'embedded module needs exact source evidence, not a substituted root notice'
            missing.append('task:module:'+m['path']+'@'+m['version'])
    assert task['goRuntime']['status']=='MISSING_EXACT_GO_RUNTIME_LICENSE_NOTICES' and not task['goRuntime'].get('noticeRefs'), 'Go runtime source notice evidence not yet integrated'
    missing.append('task:go-runtime:'+task['goVersion'])
    assert not actrun.get('exactResolutionBlobRefs') and not actrun.get('noticeRefs'), 'actrun exact embedded resolution cannot be admitted by metadata edits'
    missing.append('actrun:exact-embedded-resolution-and-notices')
    assert sorted(set(missing))==sorted(coverage['missing'])==sorted(embedded['missing']+['upstream-notices:'+sid for sid,r in actual.items() if not r['notices']]), 'Missing license inventory mismatch'
    return {'status':'MISSING_LICENSE_BYTES' if missing else 'RETAINED_BYTES_TECHNICAL_COVERAGE_REVIEW_REQUIRED','paths':len(value['entries']),'sources':len(actual),'blobs':len(blobs),'packetSha256':binding['sha256'],'missing':sorted(missing),'claim':value['claim'],'review':coverage['review']}

def verify_dependency_licenses(runtime, packet, blob_root=None):
    report=assess_dependency_licenses(runtime,packet,blob_root)
    if report['missing']:
        raise MissingLicenseBytes('MissingLicenseBytes: '+json.dumps(report['missing']))
    return report
