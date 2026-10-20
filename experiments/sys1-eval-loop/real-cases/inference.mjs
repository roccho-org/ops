import assert from 'node:assert/strict';import {summarizeObserved} from './summary.mjs';
function integer(n){assert.ok(Number.isSafeInteger(n)&&n>=0);}
export function choose(n,k){integer(n);assert.ok(Number.isSafeInteger(k));if(k<0||k>n)return 0n;k=Math.min(k,n-k);let value=1n;for(let j=1;j<=k;j++)value=value*BigInt(n-k+j)/BigInt(j);return value;}
function tailCount(M,K,n,x,upper){
 const lo=Math.max(0,n-(M-K)),hi=Math.min(n,K);let term=choose(K,lo)*choose(M-K,n-lo),sum=0n;
 for(let v=lo;v<=hi;v++){if(upper?v>=x:v<=x)sum+=term;if(v===hi)break;const numerator=term*BigInt(K-v)*BigInt(n-v),denominator=BigInt(v+1)*BigInt(M-K-n+v+1);assert.equal(numerator%denominator,0n);term=numerator/denominator;}
 return sum;
}
export function hypergeometricLimits(M,n,x,{numerator=1n,denominator=400n}={}){
 for(const k of [M,n,x])integer(k);assert.ok(n<=M&&x<=n);assert.equal(typeof numerator,'bigint');assert.equal(typeof denominator,'bigint');assert.ok(numerator>0n&&numerator<=denominator);
 const total=choose(M,n),retain=(K,upper)=>tailCount(M,K,n,x,upper)*denominator>=total*numerator;
 let a=0,b=M;while(a<b){const mid=a+Math.floor((b-a)/2);if(retain(mid,true))b=mid;else a=mid+1;}const lower=a;
 a=0;b=M;while(a<b){const mid=a+Math.ceil((b-a)/2);if(retain(mid,false))a=mid;else b=mid-1;}
 return {lower,upper:a,boundary:'retain tail >= alpha; equality included',tailAlpha:{numerator:numerator.toString(),denominator:denominator.toString()}};
}
export function inferFiniteFrame(rows,{frameSize,roundIndex,modelStable=null,samplingValid=null,repetitions=2,repId}={}){
 integer(frameSize);assert.equal(repetitions,2);assert.ok(repId===1||repId===2);assert.ok(Array.isArray(rows)&&rows.length<=frameSize);assert.ok(Number.isSafeInteger(roundIndex)&&roundIndex>=1);assert.ok(samplingValid===null||typeof samplingValid==='boolean');
 const power=2n**BigInt(roundIndex),alpha={numerator:'1',denominator:(20n*power).toString()},tail={numerator:1n,denominator:200n*power};
 const base={roundIndex,repId,repetitions,roundAlpha:alpha,perTailAlpha:{numerator:'1',denominator:tail.denominator.toString()},frameSize,assigned:rows.length,caseIds:rows.map(r=>r.id).sort(),scope:'fixed eligible frame and measurement protocol approximation; not backend/Gold/future stability guarantee'};
 if(!rows.length)return {...base,disposition:'UNKNOWN_EMPTY_SAMPLE',observed:null,bounds:null};
 const observed=summarizeObserved(rows,{modelStable});if(modelStable!==true||samplingValid!==true)return {...base,disposition:'UNKNOWN_INVALID_MEASUREMENT',observed,bounds:null};
 const {b,c,unknown:u,regressionCases:r}=observed,low=(x)=>hypergeometricLimits(frameSize,rows.length,x,tail).lower,high=(x)=>hypergeometricLimits(frameSize,rows.length,x,tail).upper;
 const B_L=low(b),B_U=high(b+u),C_L=low(c),C_U=high(c+u),R_U=high(r+u),bounds={B_L,B_U,C_L,C_U,R_U,differenceLowerNumerator:B_L-C_U,differenceUpperNumerator:B_U-C_L,denominator:frameSize,differenceLower:(B_L-C_U)/frameSize,differenceUpper:(B_U-C_L)/frameSize,regressionUpper:R_U/frameSize};
 const disposition=observed.observedRegressionCases?'OBSERVED_REGRESSION':B_L>C_U&&b-c-u>0?'POSITIVE_FIXED_FRAME_APPROXIMATION':'NOT_ESTABLISHED';
 return {...base,observed,bounds,disposition,method:'five per-pass inclusive exact integer HG tails, round alpha split across two prospectively fixed passes with Bonferroni; unresolved cases enter adversarial success-count ranges; one issue one weight',regressionClaim:'observed known axis regression count only; report R_U, no population-zero/1% claim'};
}

export function reconfirmFixedFrame(passes){
 assert.ok(Array.isArray(passes)&&passes.length===2);assert.deepEqual(passes.map(p=>p.repId),[1,2]);const [a,b]=passes;for(const key of ['roundIndex','frameSize','assigned'])assert.equal(a[key],b[key]);assert.equal(a.repetitions,2);assert.equal(b.repetitions,2);assert.deepEqual(a.caseIds,b.caseIds);
 const unknownPasses=passes.filter(p=>p.disposition.startsWith('UNKNOWN')).map(p=>p.repId),knownFailurePasses=passes.filter(p=>!p.disposition.startsWith('UNKNOWN')&&p.disposition!=='POSITIVE_FIXED_FRAME_APPROXIMATION').map(p=>p.repId);
 const disposition=knownFailurePasses.length?'NOT_RECONFIRMED':unknownPasses.length?'UNKNOWN_RECONFIRMATION':'FIXED_FRAME_GAIN_RECONFIRMED';
 return {disposition,knownFailurePasses,unknownPasses,passes,independentIssueCount:a.assigned,observationsPerIssue:2,claim:'same fixed real-case frame, both prospectively fixed passes positive without observed axis regression; HG intervals cover sampling only, not Gold/model/future expected gain',averageRescue:false};
}
