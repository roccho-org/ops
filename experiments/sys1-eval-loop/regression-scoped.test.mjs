import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {targetRequest} from './feedback-improvement.mjs';import {scopedRequest,scopedTemplates,wireTemplate,SCOPE_CLARIFICATION} from './regression/scoped-request.mjs';
const best=JSON.parse(fs.readFileSync(new URL('./candidates/binary-eo-v3.json',import.meta.url))).instructions;
test('candidate clarifies both E labels symmetrically while original Best and all O fields remain unchanged',()=>{
 const original=targetRequest('body',best,'E'),candidate=scopedRequest('body',best,'E');assert.equal(candidate.text,original.text);assert.equal(candidate.instructions,original.instructions);
 for(const key of ['yes','no'])assert.equal(candidate.criteria[key],original.criteria[key]+SCOPE_CLARIFICATION);
 assert.deepEqual(targetRequest('body',best,'E'),original);assert.deepEqual(scopedRequest('body',best,'O'),targetRequest('body',best,'O'));
 assert.match(SCOPE_CLARIFICATION,/必要な責務/);assert.match(SCOPE_CLARIFICATION,/引用・条件付き・表形式/);assert.match(SCOPE_CLARIFICATION,/採用済み・実施済みであることは必要条件ではない/);
});
test('identity captures full standard wire despite identical instruction strings and aliases only truly identical O',async()=>{
 const p=await scopedTemplates(best);assert.notDeepEqual(p.templates.bestE,p.templates.scopedE);assert.deepEqual(p.templates.bestO,p.templates.scopedO);
 assert.deepEqual(p,JSON.parse(fs.readFileSync(new URL('./regression/scoped-plan.json',import.meta.url))));
 for(const template of Object.values(p.templates)){assert.equal(template.model,'jev-latest');assert.deepEqual(Object.keys(template.questions),['live']);assert.equal(template.questions.live.type,'choice');assert.equal(typeof template.state,'string');}
 assert.equal(p.maxPosts.total,128+32+144+192);assert.deepEqual(p.physical.screen,['bestE','scopedE','sharedO']);
 const actual=await wireTemplate(scopedRequest('actual body',best,'E'));assert.deepEqual({...actual,state:p.templates.scopedE.state},p.templates.scopedE);assert.equal(actual.state,JSON.stringify({body:'actual body'}));
});
