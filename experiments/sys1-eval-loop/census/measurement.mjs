import assert from 'node:assert/strict';
import {prepareCensusAndMeasurement,assertCensusAndEffectInput,evaluateCensusAndMeasurement,verifyCensusAndMeasurement} from '../reserve/and-measurement.mjs';
import {scorePairedCensus} from './feasible.mjs';
export {prepareCensusAndMeasurement,assertCensusAndEffectInput,evaluateCensusAndMeasurement};
export async function projectCensusMeasurement(input,report,events,cases,selection){
 const measurement=await verifyCensusAndMeasurement(input,report,events,cases,selection);assert.deepEqual(measurement.rows.map(r=>r.id),cases.map(c=>c.id));
 const rows=cases.map((c,i)=>({id:c.id,gold:c.gold,best:measurement.rows[i].best,candidate:measurement.rows[i].scoped})),inference=scorePairedCensus(rows,{physical:{assigned:measurement.effectCounts.assigned,qualified:measurement.effectCounts.qualified},modelStable:measurement.modelStable,repId:input.repId});
 return {schema:'ops.sys1.census-and-projection.v1',measurement,inference};
}
export async function verifyCensusPassRecord(record,cases,selection){
 assert.deepEqual(record.input.execution,{source:record.provider.source,activation:record.provider.head,runUrl:record.provider.runUrl});const rebuilt=await projectCensusMeasurement(record.input,record.report,record.events,cases,selection);assert.deepEqual(record.projection,rebuilt);return rebuilt;
}
export function reconfirmCensus(projections){
 assert.equal(projections.length,2);assert.deepEqual(projections.map(p=>p.measurement.repId),[1,2]);assert.ok(projections.every(p=>p.schema==='ops.sys1.census-and-projection.v1'));assert.deepEqual(projections[0].measurement.rows.map(r=>r.id),projections[1].measurement.rows.map(r=>r.id));
 for(const p of projections){const m=p.measurement,i=p.inference,ids=m.rows.map(r=>r.id);assert.equal(i.schema,'ops.sys1.paired-feasible-census.v1');assert.equal(i.repId,m.repId);assert.deepEqual(i.caseIds,ids);assert.deepEqual(i.cases.map(c=>c.id),ids);assert.equal(i.assigned,ids.length);assert.equal(m.logicalCounts.assignedCases,ids.length);assert.equal(m.effectCounts.assigned,4*ids.length);assert.deepEqual(i.physical,{assigned:m.effectCounts.assigned,qualified:m.effectCounts.qualified});assert.equal(i.modelStable,m.modelStable);assert.equal(i.accepted,Boolean(i.qualificationComplete&&i.modelStable&&i.bounds&&i.bounds.differenceLowerNumerator>0&&i.bounds.regressionUpperNumerator===0));}
 // The native entry must reconstruct BOTH projections from their original raw
 // against one unchanged native corpus/Gold/configuration before aggregation.
 return {schema:'ops.sys1.census-and-reconfirmation.v1',caseDenominator:projections[0].measurement.logicalCounts.assignedCases,repetitions:2,accepted:projections.every(p=>p.inference.accepted),disposition:projections.every(p=>p.inference.accepted)?'RECONFIRMED_FIXED_CENSUS_GAIN':'NOT_RECONFIRMED',rule:'both fixed same-case passes independently satisfy all qualification/model/feasible-delta/regression conditions; no averaging, winner selection or doubled case denominator'};
}
