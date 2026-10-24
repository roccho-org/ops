import fs from 'node:fs';
import path from 'node:path';
import {sha} from './requests.mjs';
const read=p=>JSON.parse(fs.readFileSync(p));
const fail=s=>{throw Error(s);};
export function readback(root) {
 const x=read(path.join(root,'invocation.json'));
 const normalized=[];
 for(const a of x.accepted) {
  const r=read(path.join(a.dir,'receipt.json'));
  if(r.status!=='OBSERVED'||!r.oracleIntact||r.x!==a.x||r.commit!==x.commit)fail('receipt identity');
  for(const [rel,digest] of r.oracle)if(sha(fs.readFileSync(path.join(a.dir,'snapshot',rel)))!==digest)fail('oracle hash');
  const out=path.join(a.dir,'work','out');
  if(fs.readdirSync(out).some(n=>n.endsWith('.partial')))fail('partial artifact');
  if(fs.existsSync(path.join(out,'forbidden.json')))fail('dependent executed');
  const p=read(path.join(out,r.mode==='success'?'result.json':'failure.json'));
  if(p.x!==r.x||p.inputSha256!==r.inputSha256)fail('stale result');
  if(r.mode==='success') {
   if(r.exit!==0||p.status!=='PASS')fail('success exit/result');
   const [a,b]=['a','b'].map(n=>read(path.join(out,n+'.json')));
   if(a.x!==r.x||b.x!==r.x||a.inputSha256!==r.inputSha256||b.inputSha256!==r.inputSha256||!(max(a.start,b.start)<min(a.end,b.end))||p.join<max(a.end,b.end))fail('DAG interval/binding');
  } else if(r.exit===0||r.exit===null||p.errorClass!=='fixture-root-failure'||p.leafExit!==7)fail('failure class');
  normalized.push({commit:r.commit,tree:r.tree,x:r.x,inputSha256:r.inputSha256,mode:r.mode,runtimeIdentity:r.runtimeIdentity,status:p.status,...(r.mode==='success'?{semantic:p.semantic}:{errorClass:p.errorClass,leafExit:p.leafExit}),dependentStarted:false,exitClass:r.mode==='success'?'zero':'nonzero'});
 }
 const success=x.accepted.filter(a=>a.mode==='success').map(a=>read(path.join(a.dir,'work','out','result.json')));
 if(success.length===2&&!(max(success[0].start,success[1].start)<min(success[0].end,success[1].end)))fail('run overlap');
 return {schema:'ops.taskCandidateReadback/1',status:'PASS',normalized,rejected:x.rejected};
}
const max=Math.max,min=Math.min;
if(process.argv[1]===new URL(import.meta.url).pathname)console.log(JSON.stringify(readback(process.argv[2]),null,2));
