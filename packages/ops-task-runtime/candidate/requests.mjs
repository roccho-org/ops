// Finite opt-in proof caller. Taskfile remains the only task DAG.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
export const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p));
const write = (p,x) => { fs.writeFileSync(`${p}.partial`,JSON.stringify(x,null,2)+'\n',{flag:'wx'}); fs.renameSync(`${p}.partial`,p); };
const die = s => {throw Error(s);};
function git(repo,args) {
 const r=spawnSync(process.env.OPS_CANDIDATE_GIT || 'git',['-C',repo,...args],{maxBuffer:64*1024*1024});
 if(r.status!==0)die(`git ${args[0]} failed: ${r.stderr}`); return r.stdout;
}
function inventory(root) {
 const rows=[];
 function walk(dir) {for(const name of fs.readdirSync(dir).sort()) {const p=path.join(dir,name),s=fs.lstatSync(p); if(s.isDirectory())walk(p);else if(s.isFile())rows.push([path.relative(root,p),sha(fs.readFileSync(p))]);else die('non-regular snapshot asset');}}
 walk(root); return rows;
}
function binding(file) {
 const x=read(file); if(x.schema!=='ops.taskCandidateRuntime/1')die('runtime schema');
 for(const k of ['node','python','task','actrun','shell']) {const t=x.tools[k];if(!t || !path.isAbsolute(t.path) || sha(fs.readFileSync(t.path))!==t.sha256)die(`runtime identity: ${k}`);}
 if(x.tools.node.path!==process.execPath && fs.realpathSync(x.tools.node.path)!==fs.realpathSync(process.execPath))die('caller Node identity');
 return x;
}
export async function requests(args) {
 const opts={}; for(let i=0;i<args.length;i+=2) {if(!args[i]?.startsWith('--')||args[i+1]===undefined)die('option/value required'); opts[args[i]]=args[i+1];}
 for(const k of ['--repo','--request-file','--runtime-manifest','--evidence-dir'])if(!opts[k])die(`missing ${k}`);
 const repo=path.resolve(opts['--repo']),out=path.resolve(opts['--evidence-dir']);
 const runtime=binding(opts['--runtime-manifest']), req=read(opts['--request-file']);
 if(req.schema!=='ops.taskCandidateRequests/1'||!Array.isArray(req.requests)||req.requests.length>32)die('requests schema/bound');
 if(git(repo,['status','--porcelain','--untracked-files=all']).length)die('dirty source refused');
 const commit=git(repo,['rev-parse','HEAD']).toString().trim(),tree=git(repo,['rev-parse','HEAD^{tree}']).toString().trim();
 fs.mkdirSync(out,{recursive:false});
 const prefix='packages/ops-task-runtime/';
 const names=git(repo,['ls-tree','-r','--name-only',commit,'--',prefix]).toString().trim().split('\n');
 const accepted=[],rejected=[],ids=new Set();
 for(const r of req.requests) {
  if(typeof r.eventId!=='string'||!r.eventId||ids.has(r.eventId))die('unique eventId required');ids.add(r.eventId);
  if(accepted.length>=2) {rejected.push({eventId:r.eventId,status:'REJECTED_CAPACITY',queued:false});continue;}
  if(!['success','failure'].includes(r.mode)||typeof r.inputBase64!=='string'||!['direct','actrun'].includes(r.route))die('request fields');
  const input=Buffer.from(r.inputBase64,'base64');if(input.toString('base64')!==r.inputBase64)die('noncanonical input');
  const runId=crypto.randomUUID(),attemptId=crypto.randomUUID(),dir=path.join(out,runId,attemptId);
  fs.mkdirSync(dir,{recursive:true}); for(const d of ['snapshot','work','tmp','home'])fs.mkdirSync(path.join(dir,d));
  for(const n of names) {const rel=n.slice(prefix.length),p=path.join(dir,'snapshot',rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,git(repo,['show',`${commit}:${n}`]),{mode:0o444});}
  fs.writeFileSync(path.join(dir,'snapshot','input.bin'),input,{mode:0o444});
  const oracle=inventory(path.join(dir,'snapshot'));
  fs.cpSync(path.join(dir,'snapshot'),path.join(dir,'work'),{recursive:true});
  if(JSON.stringify(inventory(path.join(dir,'work')))!==JSON.stringify(oracle))die('copy mismatch');
  const runtimeIdentity=Object.fromEntries(Object.entries(runtime.tools).map(([k,v])=>[k,v.sha256]));
  const x=sha(JSON.stringify({commit,tree,oracle,runtimeIdentity,mode:r.mode}));
  const record={schema:'ops.taskCandidateAttempt/1',eventId:r.eventId,runId,attemptId,x,commit,tree,inputSha256:sha(input),runtimeIdentity,mode:r.mode,route:r.route,dir,oracle,status:'ACCEPTED'};
  write(path.join(dir,'accepted.json'),record); accepted.push(record);
 }
 write(path.join(out,'admission.json'),{schema:'ops.taskCandidateAdmission/1',bound:2,boundScope:'one invocation',accepted:accepted.map(({eventId,runId,attemptId,x})=>({eventId,runId,attemptId,x})),rejected});
 await Promise.all(accepted.map(async a=>{
  const work=path.join(a.dir,'work'),env={PATH:[path.dirname(runtime.tools.task.path),path.dirname(runtime.tools.shell.path)].join(':'),HOME:path.join(a.dir,'home'),TMPDIR:path.join(a.dir,'tmp'),LANG:'C.UTF-8',OPS_CANDIDATE_NODE:runtime.tools.node.path,OPS_CANDIDATE_PYTHON:runtime.tools.python.path,OPS_CANDIDATE_TASK:runtime.tools.task.path,OPS_CANDIDATE_X:a.x,OPS_CANDIDATE_MODE:a.mode};
  const argv=['--taskfile',path.join(work,'Taskfile.yml'),'--dir',work,`candidate-${a.mode}`];
  const executable=a.route==='direct'?runtime.tools.task.path:runtime.tools.actrun.path;
  const actualArgv=a.route==='direct'?argv:['workflow','run',path.join(work,'candidate','workflow.yml'),'--workspace-mode','local','--no-nix','--run-root',path.join(a.dir,'actrun')];
  const stdout=fs.openSync(path.join(a.dir,'stdout'),'wx'),stderr=fs.openSync(path.join(a.dir,'stderr'),'wx');
  const child=spawn(executable,actualArgv,{cwd:work,env,stdio:['ignore',stdout,stderr],detached:true});fs.closeSync(stdout);fs.closeSync(stderr);
  const startIdentity=child.pid?fs.readFileSync(`/proc/${child.pid}/stat`,'utf8'):null;
  write(path.join(a.dir,'process.json'),{pid:child.pid,startIdentity,executable,argv:actualArgv});
  const result=await new Promise(resolve=>{child.once('error',e=>resolve({exit:null,error:e.message}));child.once('exit',(exit,signal)=>resolve({exit,signal}));});
  const intact=JSON.stringify(inventory(path.join(a.dir,'snapshot')))===JSON.stringify(a.oracle);
  const receipt={...a,...result,argv,oracleIntact:intact,status:'OBSERVED'};write(path.join(a.dir,'receipt.json'),receipt);
 }));
 const summary={schema:'ops.taskCandidateInvocation/1',commit,tree,accepted:accepted.map(a=>({dir:a.dir,...read(path.join(a.dir,'receipt.json'))})),rejected};
 write(path.join(out,'invocation.json'),summary);process.stdout.write(JSON.stringify({evidence:out,accepted:accepted.length,rejected:rejected.length})+'\n');
}
