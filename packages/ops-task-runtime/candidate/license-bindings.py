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

p=argparse.ArgumentParser()
p.add_argument('--profile',type=Path,required=True)
p.add_argument('--metadata',type=Path,required=True)
p.add_argument('--out',type=Path,required=True)
p.add_argument('--nix-store',default='/run/current-system/sw/bin/nix-store')
a=p.parse_args()
sha=lambda data:hashlib.sha256(data).hexdigest()
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
