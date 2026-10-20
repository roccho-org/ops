import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath,pathToFileURL} from 'node:url';
import {confirmationProjection} from '../counterfactual/runtime.mjs';
import {deriveDiagnosis,REPAIR_PROMPT} from '../counterfactual/comparison.mjs';
import {REPAIR_MODEL} from '../counterfactual/repair-route.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
export const PROMPT=REPAIR_PROMPT+' The supplied startingDraft is a rejected development configuration, not adopted Best. Actual answers below came from startingDraft, not Best. You may rewrite or remove its suffix while retaining the complete Best prefix. All cases are retired prior confirmation data, now development data. Do not infer correctness from the draft or from an evaluator label.';
export function migrateRetiredConfirmation(input,report,projection,provider,definitions){
  assert.equal(input.phase,'confirmation');assert.equal(input.rows.length,32);assert.equal(report.rows.length,32);assert.equal(projection.targetComplete,true);assert.equal(projection.modelStable,true);
  assert.equal(provider.runAttempt,1);assert.equal(provider.conclusion,'failure');assert.equal(report.actualPosts,224);
  const best=input.plan.configurations.find(c=>c.id==='best').instructions,startingDraft=input.plan.configurations.find(c=>c.id==='feedback').instructions;
  assert.ok(startingDraft.startsWith(best));assert.notEqual(startingDraft,best);
  const rows=input.rows.map(c=>{
    const r=report.rows.find(r=>r.id===c.id);assert.ok(r);const observed=r.configurations.find(x=>x.id==='feedback');assert.equal(observed.target.length,2);
    const answer=Object.fromEntries(observed.target.map(t=>[t.role,t.answer.choice]));
    const diagnostic=deriveDiagnosis(r.judge?.answer.choice??null,answer);
    return {id:c.id,family:c.family,body:c.body,answer,diagnostic};
  });
  assert.equal(new Set(rows.map(r=>r.id)).size,32);
  const common={prompt:PROMPT,diagnosisDefinitions:definitions,best,startingDraft,cases:rows.map(r=>({body:r.body,answer:r.answer}))};
  const feedback={common,advice:{available:true,rows:rows.map((r,index)=>({index,...r.diagnostic}))}},noFeedback={common,advice:{available:false,rows:[]}};
  return {schema:'ops.sys1.regression-development.v1',role:'retired confirmation promoted to development; never unseen',
    provenance:{runId:provider.runId,runAttempt:provider.runAttempt,activation:provider.head,artifact:provider.artifact,originalRunConclusion:provider.conclusion,cachedTargetAnswers:64,cachedJudgeQualified:report.rows.filter(r=>r.judge).length,newModelCalls:0},
    rows,best,startingDraft,feedback,noFeedback};
}
export function loadDevelopment(){
  const at='results/counterfactual-confirmation-20261020/',input=read(at+'input.json'),report=read(at+'predictions.json'),projection=read(at+'projection.json');
  assert.deepEqual(confirmationProjection(input,report,read('counterfactual/confirmation-gold.json').cases),projection);
  const definitions=read('results/counterfactual-development-20261020/projection.json').repair.feedback.common.diagnosisDefinitions;
  return migrateRetiredConfirmation(input,report,projection,read(at+'provider.json'),definitions);
}
export function repairPayloads(development){
  assert.equal(development.schema,'ops.sys1.regression-development.v1');assert.deepEqual(development.feedback.common,development.noFeedback.common);
  return Object.fromEntries([['feedback',development.feedback],['no-feedback',development.noFeedback]].map(([arm,prompt])=>[arm,{model:{...REPAIR_MODEL},prompt:JSON.stringify(prompt)}]));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [dir]=process.argv.slice(2);assert.ok(dir);assert.ok(!process.env.JEV_API_KEY);fs.mkdirSync(dir,{recursive:true});
  const development=loadDevelopment();for(const [name,data]of [['development.json',development],['repair-payloads.json',repairPayloads(development)]])fs.writeFileSync(path.join(dir,name),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
}
