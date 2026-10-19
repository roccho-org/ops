// The frozen Core/default contract stays exact while the CLI gains a new bounded
// session. Native retained Git supplies the old source, not a copied blob gate.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionContract} from './split.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const old=execFileSync('git',['show','38fcc922b58f62e743e6a94ad489dec6f2212b8e:experiments/sys1-eval-loop/split.mjs'],{cwd:root,encoding:'utf8'});
const current=fs.readFileSync(new URL('./split.mjs',import.meta.url),'utf8');
test('frozen projection, questions, classification and split Core are byte-identical',()=>{
  const prefix=s=>s.slice(0,s.indexOf('export function sessionContract('));
  assert.ok(old.includes('export function sessionContract('));
  assert.equal(prefix(current),prefix(old));
});
test('old default session JSON and its digest input remain unchanged',async()=>{
  // Location-only loader shim: no old main(), provider or filesystem operation.
  const shim=old.replaceAll('import.meta.url',JSON.stringify(new URL('./split.mjs',import.meta.url).href));
  const before=await import('data:text/javascript;base64,'+Buffer.from(shim).toString('base64'));
  for(const file of ['./contract.json','./suites/role-boundaries/contract.json']) {
    const c=JSON.parse(fs.readFileSync(new URL(file,import.meta.url),'utf8'));
    assert.equal(JSON.stringify(sessionContract(c)),JSON.stringify(before.sessionContract(c)));
  }
});
