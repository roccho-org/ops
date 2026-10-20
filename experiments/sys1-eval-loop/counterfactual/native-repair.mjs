// Native CLI capture only. No HTTP client, credential reader, model retry or agent loop.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const [dir]=process.argv.slice(2),oc='/nix/var/nix/profiles/own-dev/bin/opencode';
assert.equal(process.getuid(),1001);assert.equal(process.env.HOME,'/home/dev');assert.equal(process.cwd(),'/home/dev');
assert.equal(dir,'/home/dev/.local/state/jev-feedback-counterfactual-20261020');
assert.equal(fs.statSync(dir).uid,1001);assert.equal(fs.statSync(dir).mode&0o777,0o700);
const read=p=>JSON.parse(fs.readFileSync(path.join(dir,p),'utf8'));
const write=(p,x)=>fs.writeFileSync(path.join(dir,p),JSON.stringify(x)+'\n',{flag:'wx',mode:0o600});
const payloads=read('payloads.json');assert.deepEqual(Object.keys(payloads).sort(),['feedback','no-feedback']);
const f=JSON.parse(payloads.feedback.prompt),n=JSON.parse(payloads['no-feedback'].prompt);assert.deepEqual(f.common,n.common);
assert.equal(f.advice.available,true);assert.equal(n.advice.available,false);assert.deepEqual(n.advice.rows,[]);
for(const p of Object.values(payloads))assert.deepEqual(p.model,{providerID:'opencode',id:'deepseek-v4.1-flash'});
const metadata=()=>{
  const version=spawnSync(oc,['--version'],{encoding:'utf8',timeout:30000});assert.equal(version.status,0);assert.equal(version.stdout.trim(),'opencode v2.0.30');
  const models=spawnSync(oc,['api','--standalone','model.list'],{encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});assert.equal(models.status,0);
  const selected=JSON.parse(models.stdout).data.find(m=>m.id==='deepseek-v4.1-flash'&&m.providerID==='opencode');assert.ok(selected);
  const knownKeys=['baseURL','provider'];assert.ok(Object.keys(selected.settings??{}).every(k=>knownKeys.includes(k)));
  const files=['/etc/opencode/opencode.json','/etc/opencode/opencode.jsonc','/home/dev/.config/opencode/opencode.json','/home/dev/.config/opencode/opencode.jsonc'].map(p=>{
    try{const s=fs.statSync(p);return {path:p,size:s.size,mtimeMs:s.mtimeMs,uid:s.uid};}catch(e){assert.equal(e.code,'ENOENT');return {path:p,absent:true};}
  });
  return {version:version.stdout.trim(),executable:fs.realpathSync(oc),model:{id:selected.id,providerID:selected.providerID,limit:selected.limit,settings:selected.settings},files};
};
const before=metadata();write('before.json',before);write('attempt.json',{plannedStandardGenerateInvocations:2,providerHttpAttempts:null,providerUsage:null,hardGenerationMax:null,order:['no-feedback','feedback'],retryByThisScript:false});
for(const arm of ['no-feedback','feedback']){
  assert.deepEqual(metadata(),before,'base/catalog metadata changed; stop before next request');
  const payload=payloads[arm];write(arm+'.request.json',payload);const start=performance.now();
  const result=spawnSync(oc,['api','--standalone','POST','/api/experimental/generate','--data',JSON.stringify(payload)],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
  fs.writeFileSync(path.join(dir,arm+'.stdout.private.txt'),result.stdout??'',{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(dir,arm+'.stderr.private.txt'),result.stderr??'',{flag:'wx',mode:0o600});
  write(arm+'.receipt.json',{status:result.status,signal:result.signal,elapsedMs:performance.now()-start,standardCliInvocations:1,apiDelivery:'unknown until a valid API response is retained',providerHttpAttempts:null,providerUsage:null,hardGenerationMax:null});
  if(result.status!==0)continue;
  let response;try{response=JSON.parse(result.stdout);}catch{continue;}
  if(typeof response?.data?.text==='string')write(arm+'.response.json',{data:{text:response.data.text}});
}
write('after.json',metadata());assert.deepEqual(read('after.json'),before);
console.log('NATIVE_REPAIR_CAPTURE_COMPLETE: inspect retained receipts; no regeneration');
