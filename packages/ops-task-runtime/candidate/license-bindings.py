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

p=argparse.ArgumentParser()
p.add_argument('--profile',type=Path,required=True)
p.add_argument('--metadata',type=Path)
p.add_argument('--plan',type=Path)
p.add_argument('--acquired',type=Path)
p.add_argument('--expected-plan-sha256')
p.add_argument('--base-packet',type=Path)
p.add_argument('--assets',type=Path)
p.add_argument('--embedded',type=Path)
p.add_argument('--out',type=Path,required=True)
p.add_argument('--nix-store',default='/run/current-system/sw/bin/nix-store')
a=p.parse_args()
sha=lambda data:hashlib.sha256(data).hexdigest()
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
