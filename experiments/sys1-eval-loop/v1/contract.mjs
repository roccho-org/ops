import assert from 'node:assert/strict';
const known=v=>v==='yes'||v==='no';
// Noise between two answers to the identical Best request; unknown pairs are excluded from n.
export function noiseRate(pairs){let n=0,f=0;for(const [a,b]of pairs){assert.ok(known(a)||a===null);assert.ok(known(b)||b===null);if(known(a)&&known(b)){n++;f+=Number(a!==b);}}assert.ok(n>0);return {n,f};}
export function rMax({n,f},bestCorrect){assert.ok(Number.isInteger(bestCorrect)&&bestCorrect>=0);return Math.ceil(f*bestCorrect/n);}
export function developmentGuardV1({qualificationComplete,modelStable,repaired,regressed,bestCorrect},noise){const limit=rMax(noise,bestCorrect);return {rMax:limit,eligible:qualificationComplete===true&&modelStable===true&&repaired>regressed&&regressed<=limit};}
export function heldAcceptanceV1(passes,noise){assert.equal(passes.length,2);const each=passes.map(p=>{const limit=rMax(noise,p.bestCorrect);return {rMax:limit,accepted:p.qualificationComplete===true&&p.modelStable===true&&p.deltaLower>0&&p.regressed<=limit};});return {passes:each,accepted:each.every(p=>p.accepted)};}
export function stageInputMax(posts,maxFrozenWireChars,retained){assert.ok(retained.length>0);const ratio=Math.max(...retained.map(r=>{assert.ok(r.inputTokens>0&&r.wireChars>0);return r.inputTokens/r.wireChars;}));return posts*Math.ceil(maxFrozenWireChars*ratio);}
// Gate J and the remaining budget, checked immediately before each provider stage.
export function admitStage(contract,{http,input},{posts,inputMax},{openLaunch,runs}){
 const b=contract.budget,blocked=runs.some(r=>r.status==='queued'||r.status==='in_progress'),latest=Math.max(...runs.map(r=>r.run_number));
 if(openLaunch)return {ok:false,reason:'J1'};if(blocked)return {ok:false,reason:'J2'};if(latest===379||latest===380)return {ok:false,reason:'J3'};
 if(http+posts>b.httpMax||input+inputMax>b.inputTokenMax)return {ok:false,reason:'BUDGET'};return {ok:true};
}
