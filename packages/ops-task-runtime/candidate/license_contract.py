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
    anchor_hash=binding['noticeMembershipSha256']
    assert coverage['noticeMembershipAnchorBlobSha256']==anchor_hash, 'external notice membership anchor'
    anchor=json.loads(blob(anchor_hash))
    assert anchor['acquisitionPlanSha256']==coverage['acquisitionPlanSha256']
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
        membership=anchor['native'][sid]
        assert membership['identity']==r['identity']
        assert membership['members']=={n['member']:n['blobSha256'] for n in r['notices']}, 'native source notice membership'
        assert len(r['notices'])==len(membership['members'])
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
    def notice_refs(notices):
        for n in notices:
            data=blob(n['blobSha256'])
            assert len(data)==n['bytes'] and n['offset']==0 and n['member'] and '..' not in Path(n['member']).parts
            if n['kind']=='upstream notice file':assert _sha(data)==n['sourceFileSha256']
        return [n['blobSha256'] for n in notices]
    for m in task['modules']:
        evidence=m['sourceEvidence']
        assert m['status']=='BINARY_H1_SOURCE_NOTICE_BYTES_RETAINED'
        assert (evidence['module'],evidence['version'])==(m['path'],m['version'])
        rows=json.loads(blob(evidence['fileManifestBlobSha256']))
        assert rows==sorted(rows) and len({n for n,h in rows})==len(rows)
        assert all('\n' not in n and re.fullmatch('[0-9a-f]{64}',h) for n,h in rows)
        h1='h1:'+base64.b64encode(hashlib.sha256(''.join(h+'  '+n+'\n' for n,h in rows).encode()).digest()).decode()
        assert h1==evidence['expectedH1']==evidence['actualH1']==m['h1'], 'binary h1 to actual module file set'
        file_hashes=dict(rows)
        assert m['noticeRefs']==notice_refs(evidence['notices']) and m['noticeRefs'], 'module notice coverage absent'
        for n in evidence['notices']:assert file_hashes[n['member']]==n['sourceFileSha256']==n['blobSha256'] and n['kind']=='upstream notice file', 'notice outside exact Go h1 source'
        if m['path']=='github.com/go-task/task/v3':
            assert roots['task']['blobSha256'] in m['noticeRefs']
            assert evidence['origin']['Hash'] in roots['task']['source']
    native_go=json.loads(blob(task['nativeModuleReceiptBlobSha256']))
    assert native_go['taskBinarySha256']==task['toolSha256'] and not native_go['missing']
    assert {(m['module'],m['version'],m['expectedSum'],m['native']['Sum']) for m in native_go['modules']}=={(m['path'],m['version'],m['h1'],m['h1']) for m in task['modules']}
    go_runtime=task['goRuntime']
    assert go_runtime['status']=='OFFICIAL_VERSION_ARCHIVE_NOTICE_BYTES_RETAINED' and go_runtime['version']==task['goVersion']
    assert go_runtime['origin']==native_go['toolchain'] and go_runtime['archiveSha256']==go_runtime['origin']['archive']['sha256']
    assert go_runtime['noticeRefs']==notice_refs(go_runtime['notices']) and any(n['member']=='go/LICENSE' for n in go_runtime['notices'])
    assert anchor['goRuntime']['archiveSha256']==go_runtime['archiveSha256']
    assert anchor['goRuntime']['members']=={n['member']:n['sourceFileSha256'] for n in go_runtime['notices']}, 'official Go archive notice membership'
    assert len(go_runtime['notices'])==len(anchor['goRuntime']['members'])
    assert all(n['blobSha256']==n['sourceFileSha256'] and n['kind']=='upstream notice file' for n in go_runtime['notices']), 'Go runtime actual notice bytes'
    graph=json.loads(blob(actrun['selectedGraphBlobSha256']))
    selected={(m['name'],m['version']) for m in graph['modules'] if m['source']['kind']=='registry'}
    assert len(selected)==26 and selected=={(m['name'],m['version']) for m in actrun['modules']}
    registry=json.loads(blob(actrun['registryReceiptBlobSha256']))
    assert registry['actrunSourceCommit']==actrun['sourceCommit']=='b2fc1c9d88c921b670fc2c2651728967b414a8c7'
    records={(m['name'],m['version']):m for m in registry['modules']}
    lock=json.loads(blob(actrun['flakeLockBlobSha256']))
    revs={n.get('locked',{}).get('rev') for n in lock['nodes'].values()}
    assert actrun['pinnedRegistryCommit']=='39743040d5e9fc28e90fad0ea280a4d30040543c' in revs
    assert actrun['overlayRecord']['sourceCommit']=='4ffc0aab45588a519342178cca9231be94c9bab0' in revs
    overlay=json.loads(blob(actrun['overlayRecord']['blobSha256']))
    assert overlay['version']=='v0.8.3+cd28f524e+c9ac7ee'
    blob(actrun['provenanceReviewBlobSha256'])
    for m in actrun['modules']:
        r=records[(m['name'],m['version'])]
        assert m['archiveSha256']==m['indexRow']['checksum']==r['sha256']==r['indexRow']['checksum']
        assert m['indexRow']==r['indexRow'] and m['url']==r['url']
        for key in ['currentIndexBlobSha256','historicalIndexBlobSha256']:
            rows=[json.loads(line) for line in blob(m[key]).splitlines() if line.strip()]
            matches=[row for row in rows if row.get('version')==m['version']]
            assert len(matches)==1 and matches[0]['checksum']==m['archiveSha256'], 'fixed registry checksum/source membership'
        assert m['historicalIndexCommit']==actrun['pinnedRegistryCommit']
        assert m['noticeRefs']==notice_refs(m['notices'])
        manifest=json.loads(blob(m['manifestBlobSha256']))
        assert (manifest['name'],manifest['version'])==(m['name'],m['version'])
        for ref in m['publisherReadmeRefs']:blob(ref)
        if 'publisherSource' in m:
            p=m['publisherSource'];publisher=json.loads(blob(p['manifestBlobSha256']))
            assert (publisher['name'],publisher['version'])==(m['name'],m['version'])
            assert p['registryManifestByteEqual']==(p['manifestBlobSha256']==m['manifestBlobSha256'])
        full=any(n['kind']=='upstream notice file' for n in m['notices'])
        assert m['fullLicenseTextRetained']==full
        if not full:
            p=m.get('publisherLicenseReference')
            assert p==anchor['publisherReferences'][m['name']], 'publisher reference independent component binding'
            assert (p['component'],p['version'],p['registryArchiveSha256'])==(m['name'],m['version'],m['archiveSha256'])
            assert p['references'] and p['existingNotices']
            for n in p['references']+p['existingNotices']:blob(n['blobSha256'])
            body=p['canonicalBody'];raw=blob(body['blobSha256'])
            assert body['licenseId']==p['licenseId'] and body['sha256']==_sha(raw) and body['bytes']==len(raw)
            assert body['source']=='https://raw.githubusercontent.com/spdx/license-list-data/'+body['upstreamGitCommit']+'/text/'+p['licenseId']+'.txt'
            assert p['codeCorrespondence']['differentCodeFiles']==[]
    assert actrun['fontFixtureNotices']==anchor['fontFixtureNotices'], 'font fixture notice binding'
    for row in actrun['fontFixtureNotices']['records']:
        for n in row['nameRecords']:blob(n['blobSha256'])
    body=actrun['fontFixtureNotices']['canonicalBody'];assert _sha(blob(body['blobSha256']))==body['sha256'] and body['licenseId']=='OFL-1.1'
    core=actrun['core'];assert core['version']=='0.1.20260310+cd28f524e' and core['archiveSha256']==core['indexRow']['checksum']
    notice_refs(core['notices']);assert {'LICENSE','NOTICE'}<=set(n['member'] for n in core['notices'])
    native=actrun['nativeRuntime'];notice_refs(native['notices'])
    assert native['origin']['commit']=='34489644a0c23b206426386e51932e12b436e03f' and any(Path(n['member']).name=='LICENSE' for n in native['notices'])
    assert native['unknownRevision'] is True, 'do not silently assert actual native C revision equivalence'
    unknowns=['actrun:native-C-runtime-exact-revision-not-measured-publisher-family-origin-only']
    assert coverage['unknowns']==unknowns
    assert sorted(set(missing))==sorted(coverage['missing'])==sorted(embedded['missing']+['upstream-notices:'+sid for sid,r in actual.items() if not r['notices']]), 'Missing license inventory mismatch'
    return {'status':'MISSING_LICENSE_BYTES' if missing else 'RETAINED_BYTES_TECHNICAL_COVERAGE_REVIEW_REQUIRED','paths':len(value['entries']),'sources':len(actual),'blobs':len(blobs),'packetSha256':binding['sha256'],'missing':sorted(missing),'unknowns':unknowns,'claim':value['claim'],'review':coverage['review']}

def verify_dependency_licenses(runtime, packet, blob_root=None):
    report=assess_dependency_licenses(runtime,packet,blob_root)
    if report['missing']:
        raise MissingLicenseBytes('MissingLicenseBytes: '+json.dumps(report['missing']))
    return report
