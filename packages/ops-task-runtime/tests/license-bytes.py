"""Negative proof for retained required bytes; not a license sufficiency verdict."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

package=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(package/'candidate'))
from license_contract import assess_dependency_licenses,verify_dependency_licenses,MissingLicenseBytes
profile=json.loads((package/'candidate/native-profile.json').read_text())
packet=package/'candidate/dependency-licenses.json'
original=json.loads(packet.read_text());assets=package/'candidate/license-bytes'
assessment=assess_dependency_licenses(profile,packet)
assert assessment['paths']==151 and assessment['sources']==229
assert len(assessment['missing'])==6 and assessment['status']=='MISSING_LICENSE_BYTES'
assert len(assessment['unknowns'])==1
passed=[]
def reject(name,call):
    try:call()
    except (AssertionError,KeyError,ValueError,FileNotFoundError):passed.append(name);return
    raise AssertionError('false PASS: '+name)
reject('real-missing-embedded-notices',lambda:verify_dependency_licenses(profile,packet))
with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp);dest=root/'license-bytes';shutil.copytree(assets,dest)
    current=root/'packet.json'
    def altered(name,change):
        value=copy.deepcopy(original);change(value);current.write_text(json.dumps(value))
        binding=copy.deepcopy(profile);binding['dependencyLicenses']['sha256']=hashlib.sha256(current.read_bytes()).hexdigest()
        reject(name,lambda:assess_dependency_licenses(binding,current,dest))
    first=next(iter(original['byteCoverage']['blobs']));f=dest/first;data=f.read_bytes()
    current.write_bytes(packet.read_bytes())
    f.unlink();reject('required-file-missing',lambda:assess_dependency_licenses(profile,current,dest));f.write_bytes(data)
    f.write_bytes(data+b'changed');reject('required-file-tampered',lambda:assess_dependency_licenses(profile,current,dest));f.write_bytes(data)
    altered('missing-output-coverage',lambda v:v['byteCoverage']['components'].pop(next(iter(v['byteCoverage']['components']))))
    source=next(iter(original['byteCoverage']['sourceMetadata']))
    altered('missing-source-provenance',lambda v:v['byteCoverage']['sourceMetadata'].pop(source))
    altered('required-source-notice-reference-missing',lambda v:v['byteCoverage']['blobs'].pop(v['byteCoverage']['sourceMetadata'][source]['notices'][0]['blobSha256']))
    component=next(k for k,v in original['byteCoverage']['components'].items() if v['patchSourceIds'])
    altered('patch-coverage-dropped',lambda v:v['byteCoverage']['components'][component]['patchSourceIds'].clear())
    altered('definition-byte-reference-changed',lambda v:v['byteCoverage']['components'][component].update(definitionBlobSha256=first))
    altered('root-bundle-wrong-binary',lambda v:v['byteCoverage']['rootTools']['node'].update(toolSha256='0'*64))
    altered('embedded-module-inventory-dropped',lambda v:v['byteCoverage']['embedded']['tools']['task']['modules'].pop())
    altered('generic-root-notice-for-third-party-module',lambda v:v['byteCoverage']['embedded']['tools']['task']['modules'][1].update(noticeRefs=[v['byteCoverage']['rootTools']['task']['blobSha256']]))
    altered('Go-h1-source-membership-changed',lambda v:v['byteCoverage']['embedded']['tools']['task']['modules'][1]['sourceEvidence'].update(actualH1='h1:wrong'))
    altered('Go-runtime-notice-reference-dropped',lambda v:v['byteCoverage']['embedded']['tools']['task']['goRuntime']['noticeRefs'].clear())
    altered('Moon-selected-graph-dropped',lambda v:v['byteCoverage']['embedded']['tools']['actrun']['modules'].pop())
    altered('Moon-registry-source-checksum-changed',lambda v:v['byteCoverage']['embedded']['tools']['actrun']['modules'][0].update(archiveSha256='0'*64))
    altered('core-NOTICE-dropped',lambda v:v['byteCoverage']['embedded']['tools']['actrun']['core'].update(notices=[n for n in v['byteCoverage']['embedded']['tools']['actrun']['core']['notices'] if n['member']!='NOTICE']))
    altered('native-C-exact-revision-claim-without-proof',lambda v:v['byteCoverage']['embedded']['tools']['actrun']['nativeRuntime'].update(unknownRevision=False))
    altered('native-C-Unknown-silently-cleared',lambda v:v['byteCoverage']['unknowns'].clear())
    altered('missing-inventory-cleared',lambda v:v['byteCoverage']['missing'].clear())
    altered('fixed-source-hash-changed',lambda v:v['byteCoverage']['sourceMetadata'][source]['identity'].update(actual='0'*64))
    value=copy.deepcopy(original);value.pop('byteCoverage');current.write_text(json.dumps(value));binding=copy.deepcopy(profile);binding['dependencyLicenses']['sha256']=hashlib.sha256(current.read_bytes()).hexdigest()
    report=assess_dependency_licenses(binding,current,dest)
    assert report['status']=='MISSING_LICENSE_BYTES'
    reject('metadata-only-cannot-complete',lambda:verify_dependency_licenses(binding,current,dest))
print(json.dumps({'status':'PASS','licenseGate':'MISSING_LICENSE_BYTES','nativeOutputCoverage':151,'sourceObjects':229,'assetBlobs':assessment['blobs'],'remainingPublisherTextGaps':len(assessment['missing']),'normalProvenanceUnknowns':assessment['unknowns'],'negativeCases':passed}))
