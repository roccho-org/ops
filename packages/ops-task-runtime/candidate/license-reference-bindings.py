import json,hashlib,tarfile,zipfile,struct
from pathlib import Path
import argparse
from license_contract import is_sfnt
a=argparse.ArgumentParser(description='Bind independently retained source members and direct publisher references; no network acquisition')
a.add_argument('--inputs',type=Path,required=True)
a.add_argument('--reuse-native-membership',action='store_true',help='Reuse unchanged externally anchored native member inventory; still re-read affected Moon/font source')
args=a.parse_args()
P=Path(__file__).resolve().parent;B=args.inputs;M=B/'P-actrun-moon'
sha=lambda b:hashlib.sha256(b).hexdigest()
v=json.loads((P/'dependency-licenses.json').read_text());c=v['byteCoverage'];profile=json.loads((P/'native-profile.json').read_text())
def keep(raw):
 h=sha(raw);(P/'license-bytes'/h).write_bytes(raw);c['blobs'][h]={'file':h,'bytes':len(raw)};return h
# Independently re-read selected members from the verified acquisition, rather than
# using the packet's claimed blob as its own membership oracle.
acq=json.loads((B/'P-license-acquisition-1/bytes/receipt.json').read_text());sources={r['sourceId']:r for r in acq['sources']}
anchor={'schema':'ops.taskCandidateNoticeMembership/1','acquisitionPlanSha256':c['acquisitionPlanSha256'],'native':{},'goRuntime':{},'publisherReferences':{}}
if args.reuse_native_membership:
 previous=(P/'license-bytes'/profile['dependencyLicenses']['noticeMembershipSha256']).read_bytes()
 assert sha(previous)==c['noticeMembershipAnchorBlobSha256']==profile['dependencyLicenses']['noticeMembershipSha256']
 previous=json.loads(previous);assert previous['acquisitionPlanSha256']==c['acquisitionPlanSha256']
 expected={sid:{'identity':row['identity'],'members':{n['member']:n['blobSha256'] for n in row['notices']}} for sid,row in c['sourceMetadata'].items()}
 assert previous['native']==expected, 'reuse only byte-identical native source membership'
 anchor['native']=previous['native']
for sid,row in ({} if args.reuse_native_membership else c['sourceMetadata']).items():
 f=Path(sources[sid]['retainedSourcePath']);wanted={n['member']:n['blobSha256'] for n in row['notices']};actual={}
 if f.is_dir():actual={n:sha((f/n).read_bytes()) for n in wanted}
 elif zipfile.is_zipfile(f):
  with zipfile.ZipFile(f) as z:actual={n:sha(z.read(n)) for n in wanted}
 else:
  try:
   with tarfile.open(f) as t:
    for m in t:
     if m.isfile() and m.name in wanted:actual[m.name]=sha(t.extractfile(m).read())
  except tarfile.ReadError:actual={'<exact native patch>':sha(f.read_bytes())}
 assert actual==wanted,(sid,'source member mismatch')
 anchor['native'][sid]={'identity':row['identity'],'members':actual}
go=c['embedded']['tools']['task']['goRuntime'];goarchive=Path(go['origin']['archive']['path']) if 'path' in go['origin']['archive'] else B/'P-task-go-modules/go1.26.5.linux-amd64.tar.gz'
assert sha(goarchive.read_bytes())==go['archiveSha256']
with tarfile.open(goarchive) as t:
 members={n['member']:sha(t.extractfile(n['member']).read()) for n in go['notices']}
assert members=={n['member']:n['sourceFileSha256'] for n in go['notices']}
anchor['goRuntime']={'archiveSha256':go['archiveSha256'],'members':members}
canonical={}
for r in json.loads((M/'canonical-license-receipt.json').read_text()):
 raw=Path(r['path']).read_bytes();assert sha(raw)==r['sha256'] and len(raw)==r['bytes']
 canonical[r['licenseId']]={k:x for k,x in r.items() if k!='path'};canonical[r['licenseId']]['blobSha256']=keep(raw)
act=c['embedded']['tools']['actrun'];records=json.loads((M/'upstream-notice-source-readback.json').read_text())
for r in records:
 m=next(m for m in act['modules'] if m['name']==r['module']);archive=Path(r['archive']);assert sha(archive.read_bytes())==r['archiveSha256'] and not r['differentCodeFiles']
 selected='MIT' if m['name']=='mizchi/tui' else 'Apache-2.0';refs=[];headers=[];filehash={}
 with tarfile.open(archive) as t:
  files={x.name.split('/',1)[1]:t.extractfile(x).read() for x in t if x.isfile() and '/' in x.name}
 for name,raw in files.items():
  if is_sfnt(raw):continue
  try:raw.decode('utf-8')
  except UnicodeDecodeError:continue
  if name=='moon.mod.json' or Path(name).name.lower().startswith('readme') or name=='.licenserc.toml' or b'copyright' in raw.lower() or b'ported from' in raw.lower() or b'ported-from' in raw.lower():
   h=keep(raw);headers.append({'member':name,'blobSha256':h});filehash[name]=h
   if selected.encode() in raw or (selected=='Apache-2.0' and b'Apache License' in raw):refs.append({'member':name,'blobSha256':h})
 manifest=json.loads(files['moon.mod.json']);assert manifest['license']==selected
 assert refs
 # Compare all code bytes to the exact registry archive, retaining registry metadata authority.
 receipt=json.loads((M/'registry-source-receipt.json').read_text())
 rr=next(x for x in receipt['modules'] if x['name']==m['name'] and x['version']==m['version'])
 zpath=Path(rr['archive']);assert sha(zpath.read_bytes())==m['archiveSha256']
 with zipfile.ZipFile(zpath) as z:
  matched=0
  for name in z.namelist():
   if name.endswith(('.mbt','.mbti')) or Path(name).name=='moon.pkg.json':
    assert name in files and z.read(name)==files[name], ('publisher code differs',m['name'],name)
    matched+=1
  assert matched>0
 # Parent/R independently checked correspondence; retain their exact record too.
 p={'component':m['name'],'version':m['version'],'licenseId':selected,'source':r['source'],'commit':r['commit'],'archiveSha256':r['archiveSha256'],'registryArchiveSha256':m['archiveSha256'],'codeCorrespondence':r,'references':refs,'existingNotices':headers,'canonicalBody':canonical[selected],'status':'ACTUAL_PUBLISHER_REFERENCE_AND_LICENSE_BODY_RETAINED','copyrightClaim':'Only actual retained publisher statements; no invented author/year'}
 p['codeCorrespondence']={k:x for k,x in r.items() if k!='archive'}
 m['publisherLicenseReference']=p
 anchor['publisherReferences'][m['name']]=p
# Actual name records from every SFNT fixture, including OTF/CFF fixtures.
font=next(r for r in records if r['module']=='mizchi/font');fontrecords=json.loads((M/'font-all-fixture-notice-records.json').read_text());fontrows=[]
with tarfile.open(font['archive']) as t:
 sourcefonts={x.name:t.extractfile(x).read() for x in t if x.isfile() and is_sfnt(t.extractfile(x).read())}
 assert set(sourcefonts)=={r['sourceMember'] for r in fontrecords}, 'all SFNT fixtures inventoried'
 for record in fontrecords:
  raw=sourcefonts[record['sourceMember']];assert sha(raw)==record['sourceFontSha256'] and len(raw)==record['sourceBytes']
  nt=struct.unpack_from('>H',raw,4)[0];off=next(struct.unpack_from('>II',raw,12+i*16+8)[0] for i in range(nt) if raw[12+i*16:16+i*16]==b'name')
  count,strings=struct.unpack_from('>HH',raw,off+2);rows=[]
  for i in range(count):
   platform,enc,lang,nid,length,start=struct.unpack_from('>HHHHHH',raw,off+6+i*12);data=raw[off+strings+start:off+strings+start+length]
   expected=next((r for r in record['records'] if (r['platform'],r['encoding'],r['language'],r['nameId'])==(platform,enc,lang,nid)),None)
   text=data.decode('utf-16-be' if platform in (0,3) else 'mac_roman')
   if expected:assert sha(data)==expected['rawSha256'] and text==expected['text']
   rows.append({'platform':platform,'encoding':enc,'language':lang,'nameId':nid,'blobSha256':keep(data),'decodedText':text})
  assert all(any((r['platform'],r['encoding'],r['language'],r['nameId'])==(n['platform'],n['encoding'],n['language'],n['nameId']) for n in rows) for r in record['records'])
  fontrows.append({'member':record['sourceMember'],'fontSha256':record['sourceFontSha256'],'nameRecords':rows})
fixture={'classification':'SOURCE_TEST_FIXTURE_NOT_SHIPPED_FONT_BYTES; retained raw name records only','sourceArchiveSha256':font['archiveSha256'],'records':fontrows,'canonicalBody':canonical['OFL-1.1']}
act['fontFixtureNotices']=fixture;anchor['fontFixtureNotices']=fixture
# Bind variant/member classification from actual registry source, independent of
# consumer packet kind/full flags. Existing publisher references cannot be skipped.
anchor['moonNoticeVariants']={}
registry=json.loads((M/'registry-source-receipt.json').read_text())
for module in act['modules']:
 record=next(r for r in registry['modules'] if (r['name'],r['version'])==(module['name'],module['version']))
 archive=Path(record['archive']);assert sha(archive.read_bytes())==module['archiveSha256']
 with zipfile.ZipFile(archive) as z:
  for n in module['notices']:
   raw=z.read(n['member']);notice=(P/'license-bytes'/n['blobSha256']).read_bytes()
   assert sha(raw)==n['sourceFileSha256'] and n['offset']==0 and raw.startswith(notice)
   if n['kind']=='upstream notice file':
    leaf=Path(n['member']).name.lower()
    assert leaf!='licenserc.toml' and any(k in leaf for k in ['license','licence','copying','notice','copyright','artistic','patents'])
    assert raw==notice
   else:assert n['kind']=='literal upstream source copyright/license header' and n['member'].endswith(('.mbt','.c','.h'))
 full=any(n['kind']=='upstream notice file' for n in module['notices']);assert full==module['fullLicenseTextRetained']
 anchor['moonNoticeVariants'][module['name']]={'archiveSha256':module['archiveSha256'],'notices':module['notices'],'fullLicenseTextRetained':full}
# Remove obsolete anchor and actual raw font payload from both registry and disk.
old=c.get('noticeMembershipAnchorBlobSha256')
if old:
 c['blobs'].pop(old);(P/'license-bytes'/old).unlink()
for path in list((P/'license-bytes').iterdir()):
 if is_sfnt(path.read_bytes()):c['blobs'].pop(path.name,None);path.unlink()
c['noticeMembershipAnchorBlobSha256']=keep((json.dumps(anchor,sort_keys=True,indent=2)+'\n').encode())
profile['dependencyLicenses']['noticeMembershipSha256']=c['noticeMembershipAnchorBlobSha256']
c['embedded']['missing']=[];c['missing']=[];v['status']='RETAINED_BYTES_TECHNICAL_COVERAGE_REVIEW_REQUIRED'
raw=(json.dumps(v,indent=2)+'\n').encode();(P/'dependency-licenses.json').write_bytes(raw);profile['dependencyLicenses']['sha256']=sha(raw);profile['licenseStatus']='RETAINED_BYTES_TECHNICAL_COVERAGE_REVIEW_REQUIRED';(P/'native-profile.json').write_text(json.dumps(profile,indent=2)+'\n')
print(json.dumps({'blobs':len(c['blobs']),'membershipAnchor':c['noticeMembershipAnchorBlobSha256'],'packet':sha(raw)}))
