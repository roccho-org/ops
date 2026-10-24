"""Bind exact native output identities to evaluated upstream license declarations.

No legal adjudication or new distribution permission. Metadata must come from the
retained native Nix expression; this tool never guesses licenses from names.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess

def integrate_retained(a):
    import tarfile, zipfile
    plan_bytes=a.plan.read_bytes()
    assert sha(plan_bytes)==a.expected_plan_sha256, 'external acquisition plan identity'
    plan=json.loads(plan_bytes); receipt=json.loads(a.acquired.read_text())
    assert receipt['planSha256']==a.expected_plan_sha256 and not receipt['missing'], 'acquisition is not complete'
    sources={s['id']:s for s in plan['sources']}; acquired={r['sourceId']:r for r in receipt['sources']}
    assert set(sources)==set(acquired)
    value=json.loads(a.base_packet.read_text()); profile=json.loads(a.profile.read_text())
    assert plan['runtimeClosureSha256']==value['runtimeClosureSha256']==profile['closureSha256']
    out=a.out.parent/'license-bytes';out.mkdir(exist_ok=True)
    blobs={}
    def keep(data):
        h=sha(data);f=out/h
        if f.exists():assert f.read_bytes()==data
        else:f.write_bytes(data)
        blobs[h]={'file':h,'bytes':len(data)}
        return h
    def member_set(source):
        f=Path(acquired[source['id']]['retainedSourcePath'])
        if source['outputHash']:
            expected=subprocess.check_output(['/run/current-system/sw/bin/nix','--extra-experimental-features','nix-command','hash','convert','--hash-algo',source['outputHashAlgo'] or 'sha256','--to','sri',source['outputHash']],text=True).strip()
            if source['outputHashMode']=='flat':actual='sha256-'+base64.b64encode(hashlib.sha256(f.read_bytes()).digest()).decode()
            else:actual=subprocess.check_output(['/run/current-system/sw/bin/nix','--extra-experimental-features','nix-command','hash','path','--sri',str(f)],text=True).strip()
            assert actual==expected, 'retained source differs: '+source['path']
        else:
            assert f.is_file() and sha(f.read_bytes())==source['localSha256']
            expected=actual=source['localSha256']
        def wanted(name):
            n=Path(name).name.lower()
            return any(x in n for x in ['license','copying','copyright','notice','artistic']) or n.startswith('readme') or n.endswith(('.pm','.pod'))
        if f.is_dir():
            files=((p.relative_to(f).as_posix(),p.read_bytes()) for p in sorted(f.rglob('*')) if p.is_file() and not p.is_symlink() and wanted(p.name))
        elif zipfile.is_zipfile(f):
            z=zipfile.ZipFile(f);files=((n,z.read(n)) for n in sorted(z.namelist()) if not n.endswith('/') and wanted(n))
        else:
            try:
                t=tarfile.open(f);files=((m.name,t.extractfile(m).read()) for m in t if m.isfile() and wanted(m.name))
            except tarfile.ReadError:files=[('<exact native patch>',f.read_bytes())]
        notices=[]
        for name,data in files:
            assert not name.startswith('/') and '..' not in Path(name).parts
            n=Path(name).name.lower();parts=Path(name).parts
            # Retain real legal files throughout upstream source, including
            # bundled components. Root README and Perl source carry inline grants.
            legal=any(x in n for x in ['license','copying','copyright','notice','artistic'])
            root_readme=n.startswith('readme') and len(parts)<=2 and any(x in data.lower() for x in [b'copyright',b'license',b'licence'])
            pod=n.endswith(('.pm','.pod')) and b'copyright' in data.lower() and any(x in data.lower() for x in [b'license',b'licence',b'terms',b'redistribut',b'permission'])
            if legal or root_readme or pod or name=='<exact native patch>':
                notices.append({'member':name,'blobSha256':keep(data),'selection':'legal-named source file' if legal else 'root README or inline copyright/grant; technical sufficiency review required'})
        return {'identity':{'expected':expected,'actual':actual,'mode':source['outputHashMode'] or 'native-Nixpkgs-file'},'notices':notices}
    primary={i for c in plan['components'] for i in c['upstreamSourceIds']}
    retained={};missing=[]
    for identity,s in sources.items():
        assert acquired[identity]['status'].startswith('BYTES_VERIFIED')
        r=member_set(s)
        retained[identity]={'path':s['path'],'origins':s['origins'],'resolvedHttpsUrls':s['resolvedHttpsUrls'],**r}
        if not r['notices']:missing.append('upstream-notices:'+identity)
    components={}
    for c in plan['components']:
        definition=Path(c['definition'].rsplit(':',1)[0]);data=definition.read_bytes();assert sha(data)==c['definitionSha256']
        assert c['outputPath'] not in components
        components[c['outputPath']]={**c,'definitionBlobSha256':keep(data)}
    definition_sources={}
    for source,nar in value['sourceNarHashes'].items():
        definition_sources[source]={'sourceNarHash':nar,'member':'COPYING','blobSha256':keep((Path(source)/'COPYING').read_bytes())}
    roots={}
    for row in profile['licenses']:
        if row['tool']=='python':f=Path(profile['tools']['python']['path']).parent.parent/'lib/python3.13/LICENSE.txt'
        else:f=a.assets/row['fileName']
        data=f.read_bytes();assert sha(data)==row['sha256']
        roots[row['tool']]={'toolSha256':profile['tools'][row['tool']]['sha256'],'source':row['source'],'blobSha256':keep(data),'coverage':'exact root/aggregate bundled notice; component sufficiency requires independent review'}
    embedded=json.loads(a.embedded.read_text())
    task_data=(a.assets/'task').read_bytes()
    assert sha(task_data)==profile['tools']['task']['sha256']
    offset=task_data.index(b'\xff Go buildinf:')
    assert task_data[offset+15]&2, 'expected inline Go build information'
    def go_string(pos):
        n=shift=0
        while True:
            part=task_data[pos];pos+=1;n|=(part&127)<<shift
            if not part&128:break
            shift+=7
        return task_data[pos:pos+n],pos+n
    go_version,pos=go_string(offset+32);go_mod,pos=go_string(pos)
    assert go_version.decode()==embedded['tools']['task']['goVersion']
    assert go_mod[16:-16]==Path(embedded['tools']['task']['buildInfoLocalPath']).read_bytes()
    actual_modules=[line.split('\t')[1:] for line in go_mod[16:-16].decode().splitlines() if line.startswith(('dep\t','mod\t'))]
    assert actual_modules==[[m[k] for k in ['path','version','h1']] for m in embedded['tools']['task']['modules']]
    embedded['tools']['task']['buildInfoBinaryOffset']=offset
    for m in embedded['tools']['task']['modules']:
        if m['status']=='ROOT_PROJECT_NOTICE':m['noticeRefs']=[roots['task']['blobSha256']]
    for tool,row in roots.items():
        row['upstreamMatches']=[{'sourceId':sid,'member':n['member']} for sid,s in retained.items() for n in s['notices'] if n['blobSha256']==row['blobSha256']]
    for record in embedded['provenanceFiles']:
        data=Path(record.pop('localPath')).read_bytes();assert sha(data)==record['sha256'];record['blobSha256']=keep(data)
    for record in embedded['tools'].values():
        if 'buildInfoLocalPath' in record:
            data=Path(record.pop('buildInfoLocalPath')).read_bytes();assert sha(data)==record['buildInfoSha256'];record['buildInfoBlobSha256']=keep(data)
    missing.extend(embedded['missing'])
    value['byteCoverage']={'schema':'ops.taskCandidateLicenseBytes/1','acquisitionPlanSha256':a.expected_plan_sha256,'acquisitionPlanBlobSha256':keep(plan_bytes),'acquisitionReceiptSha256':sha(a.acquired.read_bytes()),'sourceMetadata':retained,'components':components,'definitionSources':definition_sources,'rootTools':roots,'embedded':embedded,'blobs':blobs,'missing':missing,'review':'REQUIRED; filenames are extraction aids, never a legal or technical completeness verdict'}
    value['status']='MISSING_LICENSE_BYTES' if missing else 'RETAINED_BYTES_TECHNICAL_COVERAGE_REVIEW_REQUIRED'
    value['claim']='Exact retained license/notice bytes and provenance; Missing is fail-closed; no legal verdict or implicit User acceptance'
    a.out.write_text(json.dumps(value,indent=2)+'\n')
    print(json.dumps({'status':value['status'],'sources':len(retained),'outputs':len(components),'blobs':len(blobs),'bytes':sum(r['bytes'] for r in blobs.values()),'missing':len(missing)}))

def integrate_embedded(a):
    import tarfile,zipfile
    value=json.loads(a.base_packet.read_text());coverage=value['byteCoverage'];embedded=coverage['embedded'];profile=json.loads(a.profile.read_text());out=a.out.parent/'license-bytes';blobs=coverage['blobs']
    def keep(data):
        h=sha(data);p=out/h
        if p.exists():assert p.read_bytes()==data
        else:p.write_bytes(data)
        blobs[h]={'file':h,'bytes':len(data)}
        return h
    def legal(name):
        n=Path(name).name.lower()
        return n!='licenserc.toml' and any(k in n for k in ['license','licence','copying','notice','copyright','artistic','patents'])
    def notice(name,data,headers=False):
        if legal(name):return {'member':name,'sourceFileSha256':sha(data),'blobSha256':keep(data),'offset':0,'bytes':len(data),'kind':'upstream notice file'}
        if headers and name.endswith(('.mbt','.c','.h')):
            # Preserve literal leading comment bytes, never synthesize a license.
            lines=data.splitlines(keepends=True);prefix=[]
            for line in lines:
                stripped=line.lstrip()
                if stripped.startswith((b'//',b'/*',b'*',b'*/')) or not stripped.strip():prefix.append(line)
                else:break
            raw=b''.join(prefix)
            if b'copyright' in raw.lower() or b'licensed under' in raw.lower():return {'member':name,'sourceFileSha256':sha(data),'blobSha256':keep(raw),'offset':0,'bytes':len(raw),'kind':'literal upstream source copyright/license header'}
        return None
    def zip_notices(path,headers=False):
        result=[]
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                if name.endswith('/'):continue
                if not (legal(name) or headers and name.endswith(('.mbt','.c','.h'))):continue
                assert not name.startswith('/') and '..' not in Path(name).parts
                n=notice(name,z.read(name),headers)
                if n:result.append(n)
        return result
    go=json.loads(a.go_receipt.read_text());assert go['taskBinarySha256']==profile['tools']['task']['sha256'] and not go['missing']
    task=embedded['tools']['task'];assert go['goVersion']==task['goVersion']
    native={(m['module'],m['version']):m for m in go['modules']};assert len(native)==len(task['modules'])==124
    for m in task['modules']:
        r=native[(m['path'],m['version'])];assert r['expectedSum']==r['native']['Sum']==m['h1']
        path=Path(r['native']['Zip']);file_hashes=[]
        with zipfile.ZipFile(path) as z:
            names=z.namelist();assert len(set(names))==len(names) and all('\n' not in n for n in names)
            for name in sorted(names):file_hashes.append([name,sha(z.read(name))])
        actual='h1:'+base64.b64encode(hashlib.sha256(''.join(h+'  '+n+'\n' for n,h in file_hashes).encode()).digest()).decode()
        assert actual==m['h1'], 'actual Go module ZIP h1: '+m['path']
        notices=zip_notices(path)
        assert notices,'Go module notice bytes absent: '+m['path']
        m.update(status='BINARY_H1_SOURCE_NOTICE_BYTES_RETAINED',noticeRefs=[n['blobSha256'] for n in notices],sourceEvidence={'module':m['path'],'version':m['version'],'expectedH1':m['h1'],'actualH1':actual,'zipSha256':sha(path.read_bytes()),'origin':r['native'].get('Origin'),'fileManifestBlobSha256':keep(json.dumps(file_hashes,separators=(',',':')).encode()),'notices':notices})
    archive=a.go_receipt.parent/go['toolchain']['archive']['filename'];assert sha(archive.read_bytes())==go['toolchain']['archive']['sha256'];stdlib=[]
    with tarfile.open(archive) as t:
        version=t.extractfile('go/VERSION').read().decode().splitlines()[0];assert version==task['goVersion']
        for member in t:
            if member.isfile() and legal(member.name) and '/src/cmd/' not in member.name:
                n=notice(member.name,t.extractfile(member).read())
                if n:stdlib.append(n)
    assert any(n['member']=='go/LICENSE' for n in stdlib)
    task['goRuntime']={'status':'OFFICIAL_VERSION_ARCHIVE_NOTICE_BYTES_RETAINED','version':task['goVersion'],'origin':go['toolchain'],'archiveSha256':sha(archive.read_bytes()),'notices':stdlib,'noticeRefs':[n['blobSha256'] for n in stdlib],'scope':'Go runtime/stdlib and bundled source notices; compiler-only src/cmd excluded'}
    task['nativeModuleReceiptBlobSha256']=keep(a.go_receipt.read_bytes())
    moon=a.moon_root;r=json.loads((moon/'registry-source-receipt.json').read_text());tree=json.loads((moon/'native-tree.stdout').read_text());selected=[m for m in tree['modules'] if m['source']['kind']=='registry'];assert len(selected)==26
    records={(m['name'],m['version']):m for m in r['modules']};actrun=embedded['tools']['actrun'];modules=[];missing=[]
    git=profile['tools']['git']['path'];historical='39743040d5e9fc28e90fad0ea280a4d30040543c'
    publisher_sources=json.loads(a.publisher_sources.read_text()) if a.publisher_sources else {}
    for m in selected:
        s=records[(m['name'],m['version'])];path=Path(s['archive']);digest=sha(path.read_bytes());assert digest==s['sha256']==s['indexRow']['checksum']
        index=Path(r['indexFiles'][m['name']]['path']);assert sha(index.read_bytes())==r['indexFiles'][m['name']]['sha256']
        anchor=subprocess.check_output([git,'-C',str(moon/'registry-index'),'show',historical+':user/'+m['name']+'.index'])
        historical_rows=[json.loads(line) for line in anchor.splitlines() if line.strip()]
        matches=[row for row in historical_rows if row.get('version')==m['version']]
        assert len(matches)==1 and matches[0]['checksum']==digest,'pinned historical registry source anchor'
        notices=zip_notices(path,headers=True);full=[n for n in notices if n['kind']=='upstream notice file']
        if not full:missing.append('actrun:publisher-license-text:'+m['name']+'@'+m['version'])
        modules.append({'name':m['name'],'version':m['version'],'archiveSha256':digest,'url':s['url'],'indexRow':s['indexRow'],'currentIndexBlobSha256':keep(index.read_bytes()),'historicalIndexCommit':historical,'historicalIndexBlobSha256':keep(anchor),'notices':notices,'noticeRefs':[n['blobSha256'] for n in notices],'fullLicenseTextRetained':bool(full),'scope':'conservative selected module graph; not an assertion every module is linked'})
        with zipfile.ZipFile(path) as z:
            config=z.read('moon.mod.json');published=json.loads(config)
            assert published['name']==m['name'] and published['version']==m['version']
            modules[-1]['manifestBlobSha256']=keep(config)
            modules[-1]['publisherReadmeRefs']=[keep(z.read(n)) for n in z.namelist() if '/' not in n and Path(n).name.lower().startswith('readme')]
        if m['name'] in publisher_sources:
            p=publisher_sources[m['name']];raw=Path(p['manifestLocalPath']).read_bytes();upstream=json.loads(raw)
            assert upstream['name']==published['name'] and upstream['version']==published['version']
            modules[-1]['publisherSource']={k:v for k,v in p.items() if k!='manifestLocalPath'}
            modules[-1]['publisherSource'].update(manifestBlobSha256=keep(raw),registryManifestByteEqual=raw==config)

    core=json.loads((moon/'core-source-receipt.json').read_text());assert sha(Path(core['archive']).read_bytes())==core['sha256']==core['indexRow']['checksum'];core_notices=zip_notices(Path(core['archive']),headers=True)
    assert {'LICENSE','NOTICE'}<=set(n['member'] for n in core_notices)
    runtime=json.loads((moon/'native-runtime-mirror-origin.json').read_text());mirror=moon/'native-runtime-mirror.tar.gz';assert sha(mirror.read_bytes())==runtime['archiveSha256'];runtime_notices=[]
    with tarfile.open(mirror) as t:
        for member in t:
            if member.isfile() and (legal(member.name) or member.name.endswith(('.c','.h','README.md'))):
                data=t.extractfile(member).read();runtime_notices.append({'member':member.name,'sourceFileSha256':sha(data),'blobSha256':keep(data),'offset':0,'bytes':len(data),'kind':'exact publisher-family runtime source/notice'})
    assert any(Path(n['member']).name=='LICENSE' for n in runtime_notices)
    overlay=moon/'pinned-overlay-toolchain.json'
    flake=moon/'source/actrun-b2fc1c9d88c921b670fc2c2651728967b414a8c7/flake.lock'
    lock=json.loads(flake.read_text());locked_revs={n.get('locked',{}).get('rev') for n in lock['nodes'].values()}
    assert historical in locked_revs and '4ffc0aab45588a519342178cca9231be94c9bab0' in locked_revs
    actrun.update(status='PUBLISHER_REGISTRY_SOURCE_NOTICE_COVERAGE',modules=modules,selectedGraphBlobSha256=keep((moon/'native-tree.stdout').read_bytes()),registryReceiptBlobSha256=keep((moon/'registry-source-receipt.json').read_bytes()),sourceCommit=r['actrunSourceCommit'],flakeLockBlobSha256=keep(flake.read_bytes()),pinnedRegistryCommit=historical,overlayRecord={'sourceCommit':'4ffc0aab45588a519342178cca9231be94c9bab0','blobSha256':keep(overlay.read_bytes())},core={'source':core['source'],'version':core['indexRow']['version'],'archiveSha256':core['sha256'],'indexRow':core['indexRow'],'notices':core_notices,'scope':'publisher core matching compiler label; no bit-identical build attestation'},nativeRuntime={'origin':runtime,'notices':runtime_notices,'unknownRevision':True,'scope':'publisher-family source/notice; exact revision in actual compiler has not been measured'},provenanceReviewBlobSha256=keep(a.registry_review.read_bytes()))
    actrun.pop('missingCause',None)
    embedded['missing']=missing;coverage['missing']=missing;coverage['unknowns']=['actrun:native-C-runtime-exact-revision-not-measured-publisher-family-origin-only']
    value['status']='MISSING_LICENSE_BYTES' if missing else 'RETAINED_BYTES_TECHNICAL_COVERAGE_REVIEW_REQUIRED'
    a.out.write_text(json.dumps(value,indent=2)+'\n');print(json.dumps({'goModules':124,'moonModules':26,'missing':missing,'unknowns':coverage['unknowns'],'assetCount':len(blobs)}))

p=argparse.ArgumentParser()
p.add_argument('--profile',type=Path,required=True)
p.add_argument('--metadata',type=Path)
p.add_argument('--plan',type=Path)
p.add_argument('--acquired',type=Path)
p.add_argument('--expected-plan-sha256')
p.add_argument('--base-packet',type=Path)
p.add_argument('--assets',type=Path)
p.add_argument('--embedded',type=Path)
p.add_argument('--go-receipt',type=Path)
p.add_argument('--moon-root',type=Path)
p.add_argument('--registry-review',type=Path)
p.add_argument('--publisher-sources',type=Path)
p.add_argument('--out',type=Path,required=True)
p.add_argument('--nix-store',default='/run/current-system/sw/bin/nix-store')
a=p.parse_args()
sha=lambda data:hashlib.sha256(data).hexdigest()
if a.go_receipt:
    integrate_embedded(a)
    raise SystemExit(0)
if a.plan:
    integrate_retained(a)
    raise SystemExit(0)
assert a.metadata, '--metadata or retained acquisition inputs required'
profile=json.loads(a.profile.read_text())
metadata=json.loads(a.metadata.read_text())
ro=[a.nix_store,'--extra-experimental-features','read-only-local-store','--store','local?read-only=true']
source_ids={}
entries=[]
for row in profile['closure']:
    matches=[m for m in metadata if m['path']==row['path']]
    assert matches,'missing exact evaluated output: '+row['path']
    m=next((m for m in matches if m['license']),matches[0])
    src=m['source']
    if src not in source_ids:
        source_ids[src]=subprocess.check_output([*ro,'--query','--hash',src],text=True).strip()
    definition=Path(m['position'].rsplit(':',1)[0])
    notices=[]
    # Preserve actual notice bytes provided by this output, including symlinked
    # notices. Do not infer a license for an output from a similar package name.
    for f in sorted(Path(row['path']).rglob('*')):
        if f.is_file() and (f.name.lower() in ['license','license.txt','copying','copyright','notice']):
            data=f.read_bytes()
            notices.append({'path':str(f),'sha256':sha(data),'base64':base64.b64encode(data).decode(), 'text':data.decode('utf-8',errors='replace')})
    if not m['license']:
        # ICU dev and out share the exact evaluated source definition. Preserve
        # that definition's actual out notice when meta.license is absent.
        siblings=[n for n in metadata if n['source']==m['source'] and n['position']==m['position'] and n['name']==m['name']]
        for n in siblings:
            for f in Path(n['path']).glob('share/icu/*/LICENSE'):
                data=f.read_bytes(); notices.append({'path':str(f),'sha256':sha(data),'base64':base64.b64encode(data).decode(), 'text':data.decode('utf-8')})
    assert m['license'] or notices,'neither declaration nor actual notice: '+row['path']
    actual=subprocess.check_output([*ro,'--query','--hash',row['path']],text=True).strip()
    assert actual==row['narHash']
    entries.append({**row,'evaluatedOutput':m['path'],'packageName':m['name'],'source':src,'sourceNarHash':source_ids[src],'definition':m['position'],'definitionSha256':sha(definition.read_bytes()),'licenseDeclaration':m['license'],'noticeBytes':notices})
value={'schema':'ops.taskCandidateDependencyLicenses/1','status':'EXACT_OUTPUT_DECLARATIONS_AND_AVAILABLE_NOTICES_BOUND','claim':'151 exact native output license declarations/provenance; available notice bytes retained; not a legal compliance verdict or authority to distribute','runtimeClosureSha256':profile['closureSha256'],'metadataSha256':sha(a.metadata.read_bytes()),'expressionSha256':sha((Path(__file__).parent/'license-metadata.nix').read_bytes()),'sourceNarHashes':source_ids,'entries':entries}
a.out.write_text(json.dumps(value,indent=2)+'\n')
print(json.dumps({'status':value['status'],'paths':len(entries),'noticeBytes':sum(len(r['noticeBytes']) for r in entries)}))
