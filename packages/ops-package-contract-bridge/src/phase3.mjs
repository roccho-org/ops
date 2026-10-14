import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sha256Bytes, sha256File, stableJson } from './verify.mjs';

export const PHASE3_RECEIPT_CEILING = 'PACKAGE_PROJECTIONS_CONSUMED_NOT_ORGANIZATION_ADMISSION';
const RELATIONS = new Set(['declares','declares_common_boundary','declares_local_metadata','declares_nix_attrset','declares_nix_lambda_metadata','declares_package_path','derived_from','observes_registry_dependencies','observes_registry_entry']);
const FIELDS = Object.freeze([
  'position', 'purpose', 'contributionMechanism', 'responsibility', 'mustNotOwn',
  'placement', 'input', 'output', 'dependency', 'requiredEvidence', 'lifecycle',
]);
const fail = (message) => { throw new Error(`ops-package-contract-bridge phase3: ${message}`); };
const object = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; };
const text = (value, label) => { if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be non-empty text`); return value; };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(line => line.trim()).map(JSON.parse);
const writeJson = (file, value) => fs.writeFileSync(file, `${stableJson(value)}\n`);
const writeJsonl = (file, values) => fs.writeFileSync(file, `${values.map(stableJson).join('\n')}\n`);
const digest = (value) => sha256Bytes(Buffer.from(typeof value === 'string' ? value : `${stableJson(value)}\n`, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sortedUnique = (values) => [...new Set(values)].sort();
const uiSafeJson = (value) => stableJson(value).replaceAll('<', '\\u003c');

function resolveRoot(bundle, expectedFile) {
  const root = path.resolve(bundle);
  if (fs.existsSync(path.join(root, expectedFile))) return root;
  if (fs.existsSync(path.join(root, 'proof', expectedFile))) return path.join(root, 'proof');
  fail(`bundle file missing: ${expectedFile}`);
}

function sourceRow(assertion) {
  text(assertion.sourceRef, 'assertion.sourceRef');
  if (!/^[a-f0-9]{64}$/u.test(assertion.sourceDigest)) fail(`invalid source digest: ${assertion.sourceRef}`);
  return { sourceRef: `${assertion.sourceRef}@assertion:${assertion.sourceDigest}`, sourceDigest: `sha256:${assertion.sourceDigest}` };
}

function sourceRows(assertions) {
  const byRef = new Map();
  for (const assertion of assertions) {
    const row = sourceRow(assertion);
    const prior = byRef.get(row.sourceRef);
    if (prior && prior.sourceDigest !== row.sourceDigest) fail(`conflicting source revision: ${row.sourceRef}`);
    byRef.set(row.sourceRef, row);
  }
  return [...byRef.values()].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
}

function readPhaseInputs(phase1Bundle, phase2Bundle) {
  const p1 = resolveRoot(phase1Bundle, 'accepted-current-selection.json');
  const p2 = resolveRoot(phase2Bundle, 'phase2-v5-verification.json');
  const selection = readJson(path.join(p1, 'accepted-current-selection.json'));
  const packets = Object.fromEntries(['before', 'accepted', 'candidate'].map(role => [role, readJson(path.join(p1, selection[role].packet))]));
  const verification = readJson(path.join(p2, 'phase2-v5-verification.json'));
  if (verification.status !== 'PASS' || verification.authority !== false || verification.phaseClosed !== false) fail('Phase 2 verification boundary mismatch');
  const assertions = readJsonl(path.join(p2, 'relation-valid-source-assertions-v5.jsonl'));
  for (const assertion of assertions) {
    if (!RELATIONS.has(assertion.relation)) fail(`unsupported Phase 3 relation: ${assertion.relation}`);
    if (!FIELDS.includes(assertion.field)) fail(`unsupported Phase 3 field: ${assertion.field}`);
  }
  const coverage = readJsonl(path.join(p2, 'combined-package-field-coverage-v5.jsonl'));
  const drifts = readJson(path.join(p2, 'combined-drift-findings-v5.json')).findings;
  if (assertions.length !== verification.relationValidAssertionCount) fail('Phase 2 assertion count mismatch');
  if (coverage.length !== verification.packageCount) fail('Phase 2 coverage count mismatch');
  if (drifts.length !== verification.driftCount) fail('Phase 2 drift count mismatch');
  if (coverage.some(row => row.status !== 'COMPLETE')) fail('Phase 2 incomplete package reached Phase 3');
  for (const row of coverage) {
    const keys = Object.keys(object(row.fields, `${row.packageId}.fields`)).sort();
    if (stableJson(keys) !== stableJson([...FIELDS].sort())) fail(`mandatory field set mismatch: ${row.packageId}`);
  }
  return { p1, p2, selection, packets, verification, assertions, coverage, drifts };
}

function subjectDecision(packet, subject, label) {
  const rows = packet.currentState?.filter(row => row?.subject_key === subject) ?? [];
  if (rows.length !== 1 || typeof rows[0].decision !== 'string') fail(`${label}: one subject decision required`);
  return rows[0].decision;
}

function roleBinding(input, role, logicalRole = role) {
  const row = object(input.selection[role], `selection.${role}`);
  const packet = object(input.packets[role], `packet.${role}`);
  const packetFile = path.join(input.p1, row.packet);
  if (!fs.existsSync(packetFile)) fail(`${logicalRole}: packet missing`);
  const packetSha256 = sha256File(packetFile);
  if (packetSha256 !== row.packetSha256) fail(`${logicalRole}: packet SHA mismatch`);
  if (packet.currentDigest !== row.currentDigest) fail(`${logicalRole}: current digest mismatch`);
  const subjectKey = 'request:02-semantic';
  const decision = subjectDecision(packet, subjectKey, logicalRole);
  if (decision !== row.decision) fail(`${logicalRole}: decision mismatch`);
  if (packet.authority !== false) fail(`${logicalRole}: packet authority must be false`);
  return {
    logicalRole,
    subjectKey,
    rowId: row.rowId,
    decision,
    currentDigest: row.currentDigest,
    packetName: row.packet,
    packetSha256,
    packetSemanticDigest: packet.semanticDigest,
    packetData: packet,
  };
}

function bindingIdentity(binding) {
  return {
    logicalRole: binding.logicalRole,
    subjectKey: binding.subjectKey,
    rowId: binding.rowId,
    decision: binding.decision,
    currentDigest: binding.currentDigest,
    packet: binding.packetName,
    packetSha256: binding.packetSha256,
    packetSemanticDigest: binding.packetSemanticDigest,
  };
}

function resolveSelectionEnvelope(input, { acceptedRole = 'accepted', candidateRole = null, exactAfter = false, afterRole = 'accepted' } = {}) {
  const accepted = roleBinding(input, acceptedRole, 'accepted');
  const candidate = candidateRole ? roleBinding(input, candidateRole, candidateRole === 'candidate' ? 'candidate' : 'alternate-candidate') : null;
  if (candidate && candidate.currentDigest === accepted.currentDigest) fail('candidate must differ from accepted');
  let after;
  if (candidate && exactAfter) after = object(input.selection.acceptedCurrentAfterCandidate, 'acceptedCurrentAfterCandidate');
  else {
    const selected = afterRole === 'candidate' ? candidate : accepted;
    if (!selected) fail('selected role missing');
    after = {
      sourceRole: afterRole,
      packet: selected.packetName,
      packetSha256: selected.packetSha256,
      currentDigest: selected.currentDigest,
    };
  }
  const expected = after.sourceRole === 'candidate' ? candidate ²È="25ÕÑ¡½É¥Ñäµ™¥•±œ°€ ¤€ôø½¹ÍÕµ•ÉÌ¹Õ¤¹…ÍÍ•ÉÑ½¹ÑÉ…Ñ5½‘•±Ñ±…ÍY¥•Ü¡…ÕÑ¡½É¥ÑåY¥•Ü¤¤ì(€É•©•Ñ¥½¸¡‘•ÍÑÉÕÑ¥Ù”°€…ÁÁÌµ…ÕÑ¡½É¥ÑäµÑÉÕ”œ°€ ¤€ôø½¹ÍÕµ•ÉÌ¹…ÁÁÌ¹É•‘Õ•±½ÍÕÉ”¡…•ÁÑ•‘Ñ±…Ì¹©Í½¹°¹É•Á±…” œ‰…ÕÑ¡½É¥Ñäˆé™…±Í”œ°€œ‰…ÕÑ¡½É¥ÑäˆéÑÉÕ”œ¤¤¤ì(€É•©•Ñ¥½¸¡‘•ÍÑÉÕÑ¥Ù”°€…ÁÁÌµµ¥ÍÍ¥¹œµÁÕÉÁ½Í”µÉ•™•É•¹”œ°€ ¤€ôø½¹ÍÕµ•ÉÌ¹…ÁÁÌ¹É•‘Õ•±½ÍÕÉ”¡…•ÁÑ•‘Ñ±…Ì¹©Í½¹°¹É•Á±…”¡ÁÕÉÁ½Í”éÁ…­…”è‘íµ½‘•±ÍlÁt¹Á…­…•%‘õ€°€ÁÕÉÁ½Í”éµ¥ÍÍ¥¹œœ¤¤¤ì(€½¹ÍÐ‰…‘%‘•¹Ñ¥ÑåY¥•Ü€ô±½¹”¡…•ÁÑ•‘Y¥•Ü¤ì‰…‘%‘•¹Ñ¥ÑåY¥•Ü¹Í½ÕÉ•%‘•¹Ñ¥Ñä¹Í½ÕÉ•ÍlÁt¹Í½ÕÉ•¥•ÍÐ€ôÍ¡„ÈÔØè‘ìœÀœ¹É•Á•…Ð ØÐ¥õ€ì(€É•©•Ñ¥½¸¡‘•ÍÑÉÕÑ¥Ù”°€É½ÍÌµÁÉ½©•Ñ¥½¸µÍ½ÕÉ”µ‘¥•ÍÐµµ¥Íµ…Ñ œ°€ ¤€ôø…ÍÍ•ÉÑAÉ½©•Ñ¥½¹M½ÕÉ•%‘•¹Ñ¥Ñä¡‰…‘%‘•¹Ñ¥ÑåY¥•Ü°…•ÁÑ•‘Ñ±…Ì¹É½ÝÌ°Í•µ…¹Ñ¥M½ÕÉ•Ì¤¤ì(€É•©•Ñ¥½¸¡‘•ÍÑÉÕÑ¥Ù”°€Õ¹­¹½Ý¸µÉ•±…Ñ¥½¸œ°€ ¤€ôøì½¹ÍÐ‰…€ô±½¹”¡¥¹ÁÕÐ¹…ÍÍ•ÉÑ¥½¹Ì¤ì‰…‘lÁt¹É•±…Ñ¥½¸€ô€Õ¹­¹½Ý¹}É•±…Ñ¥½¸œì¥˜€ …I1Q%=9L¹¡…Ì¡‰…‘lÁt¹É•±…Ñ¥½¸¤¤Ñ¡É½Ü¹•ÜÉÉ½È Õ¹­¹½Ý¸É•±…Ñ¥½¸œ¤ìô¤ì(€É•©•Ñ¥½¸¡‘•ÍÑÉÕÑ¥Ù”°€…¹‘¥‘…Ñ”µµ¥ÍÍ•±•Ñ¥½¸œ°€ ¤€ôøÁÉ½©•Ñ¹Ù•±½Á”¡ì¥¹ÁÕÐ°µ½‘•±Ì°Í•µ…¹Ñ¥M½ÕÉ•Ì°½¹ÍÕµ•ÉÌ°…•ÁÑ•‘I½±”è€…•ÁÑ•œ°…¹‘¥‘…Ñ•I½±”è€…¹‘¥‘…Ñ”œ°…™Ñ•ÉI½±”è€…¹‘¥‘…Ñ”œô¤¤ì(€½¹ÍÐÕ¹É•±…Ñ•‘‘”€ô±½¹”¡…•ÁÑ•‘Y¥•Ü¤ìÕ¹É•±…Ñ•‘‘”¹•‘•ÍlÁt¹Í½ÕÉ•I½ÝÌ¹ÁÕÍ ¡µ½‘•±ÍlÁt¹ÁÕÉÁ½Í•M½ÕÉ•ÍlÁt¤ì(€É•©•Ñ¥½¸¡‘•ÍÑÉÕÑ¥Ù”°€Õ¹É•±…Ñ•µ‘•Á•¹‘•¹äµÍ½ÕÉ”µ…ÑÑÉ¥‰ÕÑ¥½¸œ°€ ¤€ôøµ…ÁÁ¥¹I½ÝÌ¡µ½‘•±Ì°Õ¹É•±…Ñ•‘‘”°…•ÁÑ•‘Ñ±…Ì¹É½ÝÌ¤¤ì(€½¹ÍÐÕ¹É•±…Ñ•‘AÕÉÁ½Í•I½ÝÌ€ô±½¹”¡…•ÁÑ•‘Ñ±…Ì¹É½ÝÌ¤ìÕ¹É•±…Ñ•‘AÕÉÁ½Í•I½ÝÌ¹™¥¹¡É½Ü€ôøÉ½Ü¹­¥¹€ôôô€ÁÕÉÁ½Í”œ¤¹Í½ÕÉ•Ì¹ÁÕÍ ¡µ½‘•±ÍlÁt¹Í½ÕÉ•Ì¹™¥¹¡Í½ÕÉ”€ôø€…µ½‘•±ÍlÁt¹ÁÕÉÁ½Í•M½ÕÉ•Ì¹Í½µ”¡¥Ñ•´€ôø¥Ñ•´¹Í½ÕÉ•I•˜€ôôôÍ½ÕÉ”¹Í½ÕÉ•I•˜¤¤¤ì(€É•©•Ñ¥½¸¡‘•ÍÑÉÕÑ¥Ù”°€Õ¹É•±…Ñ•µÁÕÉÁ½Í”µÍ½ÕÉ”µ…ÑÑÉ¥‰ÕÑ¥½¸œ°€ ¤€ôøµ…ÁÁ¥¹I½ÝÌ¡µ½‘•±Ì°…•ÁÑ•‘Y¥•Ü°Õ¹É•±…Ñ•‘AÕÉÁ½Í•I½ÝÌ¤¤ì(€½¹ÍÐµ¥ÍÍ¥¹5…ÁÁ¥¹œ€ôµ…ÁÁ¥¹Ì¹Í±¥” Ä¤ì(€É•©•Ñ¥½¸¡‘•ÍÑÉÕÑ¥Ù”°€™¥•±µÉ•±…Ñ¥½¸µµ…ÁÁ¥¹œµ½µ¥ÍÍ¥½¸œ°€ ¤€ôø…ÍÍ•ÉÑá…Ñ5…ÁÁ¥¹Ì¡µ¥ÍÍ¥¹5…ÁÁ¥¹œ°µ…ÁÁ¥¹Ì¤¤ì(€ÝÉ¥Ñ•)Í½¸¡Á…Ñ ¹©½¥¸¡½ÕÐ°€Á¡…Í”Ìµ‘•ÍÑÉÕÑ¥Ù”µÉ•ÍÕ±ÑÌ¹©Í½¸œ¤°ì­¥¹è€½ÁÌ¹½¹ÑÉ…ÐØÌÈ¹Á¡…Í”Í•ÍÑÉÕÑ¥Ù”¹ØÈœ°É•ÍÕ±ÑÌè‘•ÍÑÉÕÑ¥Ù”ô¤ì((€½¹ÍÐÁÉ•I••¥ÁÐ€ôÝ…±­¥±•Ì¡½ÕÐ¤¹™¥±Ñ•È¡™¥±”€ôø€…lÁ¡…Í”ÌµÉ••¥ÁÐ¹©Í½¸œ°€Á¡…Í”ÌµÙ•É¥™¥…Ñ¥½¸¹©Í½¸t¹¥¹±Õ‘•Ì¡™¥±”¤¤ì(€½¹ÍÐ…ÉÑ¥™…ÑÌ€ôÁÉ•I••¥ÁÐ¹µ…À¡™¥±”€ôø€¡ìÁ…Ñ è™¥±”°Í¡„ÈÔØèÍ¡„ÈÔÙ¥±”¡Á…Ñ ¹©½¥¸¡½ÕÐ°™¥±”¤¤ô¤¤ì(€½¹ÍÐÉ••¥ÁÐ€ôì(€€€­¥¹è€½ÁÌ¹Á…­…•½¹ÑÉ…Ñ	É¥‘”¹Á¡…Í”ÍI••¥ÁÐ¹ØÈœ°ÍÑ…ÑÕÌè€AMLœ°…ÕÑ¡½É¥Ñäè™…±Í”°Á¡…Í•±½Í•è™…±Í”°(€€€±…¥µ•¥±¥¹œèA!MÍ}I%AQ}%1%9°(€€€Í½ÕÉ”èì½ÁÍ…¹‘¥‘…Ñ•M¡„°Õ¥I•Ù¥Í¥½¸°…ÁÁÍI•Ù¥Í¥½¸°Á¡…Í”ÅM•±•Ñ¥½¹M¡„ÈÔØèÍ¡„ÈÔÙ¥±”¡Á…Ñ ¹©½¥¸¡¥¹ÁÕÐ¹ÀÄ°€…•ÁÑ•µÕÉÉ•¹ÐµÍ•±•Ñ¥½¸¹©Í½¸œ¤¤°Á¡…Í”ÉÍÍ•ÉÑ¥½¹M¡„ÈÔØèÍ¡„ÈÔÙ¥±”¡Á…Ñ ¹©½¥¸¡¥¹ÁÕÐ¹ÀÈ°€É•±…Ñ¥½¸µÙ…±¥µÍ½ÕÉ”µ…ÍÍ•ÉÑ¥½¹ÌµØÔ¹©Í½¹°œ¤¤ô°(€€€½Ù•É…”èìÁ…­…•½Õ¹Ðèµ½‘•±Ì¹±•¹Ñ °™¥•±‘½Õ¹Ðè%1L¹±•¹Ñ °Í½ÕÉ•½Õ¹ÐèÍ•µ…¹Ñ¥M½ÕÉ•Ì¹±•¹Ñ °Õ¥±•µ•¹Ñ½Õ¹Ðè…•ÁÑ•‘Y¥•Ü¹•±•µ•¹ÑÌ¹±•¹Ñ °Õ¥‘•½Õ¹Ðè…•ÁÑ•‘Y¥•Ü¹•‘•Ì¹±•¹Ñ °…ÁÁÍI½Ý½Õ¹Ðè…•ÁÑ•‘Ñ±…Ì¹É½ÝÌ¹±•¹Ñ °µ…ÁÁ¥¹I½ÝÌèµ…ÁÁ¥¹Ì¹±•¹Ñ °€¸¸¹…•ÁÑ•‘Ñ±…Ì¹½Õ¹ÑÌô°(€€€…ÁÁ•¹èì…¹‘¥‘…Ñ•U¹¡…¹•èÑÉÕ”°…±Ñ•É¹…Ñ•…¹‘¥‘…Ñ•U¹¡…¹•èÑÉÕ”°…¹‘¥‘…Ñ•5¥ÍÍ•±•Ñ¥½¹I•©•Ñ•èÑÉÕ”°…•ÁÑ•‘½¹Ñ•áÑÁÁÍU¹¡…¹•èÑÉÕ”ô°(€€€µ…ÁÁ¥¹œèì•á…ÐèÑÉÕ”°Õ¹µ…ÁÁ•‘¥•±‘Ìè€À°Õ¹•áÁ•Ñ•‘M½ÕÉ•ÑÑÉ¥‰ÕÑ¥½¹Ìè€Àô°(€€€‰½Õ¹‘…Éäèì…•ÁÑ•‘]¥¹¹•ÉM•±•Ñ•è™…±Í”°½É…¹¥é…Ñ¥½¹‘µ¥ÍÍ¥½¹A•É™½Éµ•è™…±Í”°‰É½ÝÍ•ÉI••¥ÁÑI•ÅÕ¥É•èÑÉÕ”°‰É½ÝÍ•É=‰Í•ÉÙ•‘	å½É”è™…±Í”°½Á•É…Ñ¥½¹…±‘½ÁÑ¥½¹A•É™½Éµ•è™…±Í”ô°(€€€‘•ÍÑÉÕÑ¥Ù”èìÑ½Ñ…°è‘•ÍÑÉÕÑ¥Ù”¹±•¹Ñ °Í…™”è‘•ÍÑÉÕÑ¥Ù”¹±•¹Ñ ô°…ÉÑ¥™…ÑÌ°(€ôì(€ÝÉ¥Ñ•)Í½¸¡Á…Ñ ¹©½¥¸¡½ÕÐ°€Á¡…Í”ÌµÉ••¥ÁÐ¹©Í½¸œ¤°É••¥ÁÐ¤ì(€½¹ÍÐÙ•É¥™¥…Ñ¥½¸€ô…Ý…¥ÐÙ•É¥™åA¡…Í”Í	Õ¹‘±”¡½ÕÐ¤ì(€ÝÉ¥Ñ•)Í½¸¡Á…Ñ ¹©½¥¸¡½ÕÐ°€Á¡…Í”ÌµÙ•É¥™¥…Ñ¥½¸¹©Í½¸œ¤°Ù•É¥™¥…Ñ¥½¸¤ì(€É•ÑÕÉ¸Ù•É¥™¥…Ñ¥½¸ì)ô()•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸Ù•É¥™åA¡…Í”Í	Õ¹‘±”¡‰Õ¹‘±•¥È¤ì(€½¹ÍÐÉ½½Ð€ôÁ…Ñ ¹É•Í½±Ù”¡‰Õ¹‘±•¥È¤ì(€½¹ÍÐÉ••¥ÁÐ€ôÉ•…‘)Í½¸¡Á…Ñ ¹©½¥¸¡É½½Ð°€Á¡…Í”ÌµÉ••¥ÁÐ¹©Í½¸œ¤¤ì(€¥˜€¡É••¥ÁÐ¹­¥¹€„ôô€½ÁÌ¹Á…­…•½¹ÑÉ…Ñ	É¥‘”¹Á¡…Í”ÍI••¥ÁÐ¹ØÈœñðÉ••¥ÁÐ¹ÍÑ…ÑÕÌ€„ôô€AMLœñðÉ••¥ÁÐ¹…ÕÑ¡½É¥Ñä€„ôô™…±Í”ñðÉ••¥ÁÐ¹Á¡…Í•±½Í•€„ôô™…±Í”¤™…¥° É••¥ÁÐ‰½Õ¹‘…Éäµ¥Íµ…Ñ œ¤ì(€™½È€¡½¹ÍÐ…ÉÑ¥™…Ð½˜É••¥ÁÐ¹…ÉÑ¥™…ÑÌ¤ì(€€€½¹ÍÐ™¥±”€ôÁ…Ñ ¹©½¥¸¡É½½Ð°…ÉÑ¥™…Ð¹Á…Ñ ¤ì(€€€¥˜€ …™Ì¹•á¥ÍÑÍMå¹Œ¡™¥±”¤ñðÍ¡„ÈÔÙ¥±”¡™¥±”¤€„ôô…ÉÑ¥™…Ð¹Í¡„ÈÔØ¤™…¥°¡…ÉÑ¥™…Ðµ¥Íµ…Ñ è€‘í…ÉÑ¥™…Ð¹Á…Ñ¡õ€¤ì(€ô(€½¹ÍÐ¥¹ÁÕÐ€ôÉ•…‘A¡…Í•%¹ÁÕÑÌ¡Á…Ñ ¹©½¥¸¡É½½Ð°€¥¹ÁÕÑÌ½Á¡…Í”Äœ¤°Á…Ñ ¹©½¥¸¡É½½Ð°€¥¹ÁÕÑÌ½Á¡…Í”Èœ¤¤ì(€¥˜€¡¥¹ÁÕÐ¹Ù•É¥™¥…Ñ¥½¸¹½ÁÍ…¹‘¥‘…Ñ•M¡„€„ôôÉ••¥ÁÐ¹Í½ÕÉ”¹½ÁÍ…¹‘¥‘…Ñ•M¡„¤™…¥° ½Á¥•A¡…Í”€È…¹‘¥‘…Ñ”µ¥Íµ…Ñ œ¤ì(€½¹ÍÐ½¹ÍÕµ•ÉÌ€ô…Ý…¥Ð¥µÁ½ÉÑ½¹ÍÕµ•ÉÌ¡Á…Ñ ¹©½¥¸¡É½½Ð°€½¹ÍÕµ•ÈµÍ½ÕÉ•Ì½Õ¤œ¤°Á…Ñ ¹©½¥¸¡É½½Ð°€½¹ÍÕµ•ÈµÍ½ÕÉ•Ì½…ÁÁÌœ¤¤ì(€½¹ÍÐµ½‘•±Ì€ôÁ…­…•5½‘•±Ì¡¥¹ÁÕÐ¹½Ù•É…”¤ì(€½¹ÍÐÍ•µ…¹Ñ¥M½ÕÉ•Ì€ôÍ½ÕÉ•I½ÝÌ¡¥¹ÁÕÐ¹…ÍÍ•ÉÑ¥½¹Ì¤ì(€½¹ÍÐ…ÁÁ•¹€ô…ÁÁ•¹‘AÉ½½˜¡¥¹ÁÕÐ°µ½‘•±Ì°Í•µ…¹Ñ¥M½ÕÉ•Ì°½¹ÍÕµ•ÉÌ¤ì(€½¹ÍÐÙ¥•Ü€ôÉ•…‘)Í½¸¡Á…Ñ ¹©½¥¸¡É½½Ð°€Õ¤¹½¹ÑÉ…Ðµµ½‘•°µ…Ñ±…Ì¹Ù¥•Ü¹©Í½¸œ¤¤ì(€¥˜€¡ÍÑ…‰±•)Í½¸¡Ù¥•Ü¤€„ôôÍÑ…‰±•)Í½¸¡…ÁÁ•¹¹ÁÉ½©•Ñ¥½¸¹Ù¥•Ü¤¤™…¥° ÍÑ½É•U$ÁÉ½©•Ñ¥½¸¥Ì¹½Ð‘•É¥Ù…‰±”™É½´½Á¥•¥¹ÁÕÑÌœ¤ì(€½¹ÍÕµ•ÉÌ¹Õ¤¹…ÍÍ•ÉÑ½¹ÑÉ…Ñ5½‘•±Ñ±…ÍY¥•Ü¡Ù¥•Ü¤ì(€½¹ÍÐ…ÁÁÍ%¹ÁÕÐ€ô™Ì¹É•…‘¥±•Må¹Œ¡Á…Ñ ¹©½¥¸¡É½½Ð°€…ÁÁÌ¹…Ñ±…ÌµÁÕÉÁ½Í”µ±½ÍÕÉ”¹¥¹ÁÕÐ¹©Í½¹°œ¤°€ÕÑ˜àœ¤ì(€¥˜€¡…ÁÁÍ%¹ÁÕÐ€„ôô…ÁÁ•¹¹ÁÉ½©•Ñ¥½¸¹…Ñ±…Ì¹©Í½¹°¤™…¥° ÍÑ½É•ÁÁÌ¥¹ÁÕÐ¥Ì¹½Ð‘•É¥Ù…‰±”™É½´½Á¥•¥¹ÁÕÑÌœ¤ì(€½¹ÍÐÉ•‘Õ•€ô½¹ÍÕµ•ÉÌ¹…ÁÁÌ¹É•‘Õ•±½ÍÕÉ”¡…ÁÁÍ%¹ÁÕÐ¤ì(€¥˜€¡É•‘Õ•€„ôô…ÁÁ•¹¹ÁÉ½©•Ñ¥½¸¹É•‘Õ•ñðÉ•‘Õ•€„ôô™Ì¹É•…‘¥±•Må¹Œ¡Á…Ñ ¹©½¥¸¡É½½Ð°€…ÁÁÌ¹…Ñ±…ÌµÁÕÉÁ½Í”µ±½ÍÕÉ”¹É•‘Õ•¹©Í½¹°œ¤°€ÕÑ˜àœ¤¤™…¥° ÁÁÌÉ•‘Õ•½ÕÑÁÕÐµ¥Íµ…Ñ œ¤ì(€½¹ÍÐ¥‘•¹Ñ¥Ñå¡•¬€ô…ÍÍ•ÉÑAÉ½©•Ñ¥½¹M½ÕÉ•%‘•¹Ñ¥Ñä¡Ù¥•Ü°…ÁÁ•¹¹ÁÉ½©•Ñ¥½¸¹…Ñ±…Ì¹É½ÝÌ°Í•µ…¹Ñ¥M½ÕÉ•Ì¤ì(€½¹ÍÐ•áÁ•Ñ•‘5…ÁÁ¥¹Ì€ôµ…ÁÁ¥¹I½ÝÌ¡µ½‘•±Ì°Ù¥•Ü°…ÁÁ•¹¹ÁÉ½©•Ñ¥½¸¹…Ñ±…Ì¹É½ÝÌ¤ì(€½¹ÍÐ…ÑÕ…±5…ÁÁ¥¹Ì€ôÉ•…‘)Í½¹°¡Á…Ñ ¹©½¥¸¡É½½Ð°€ÁÉ½©•Ñ¥½¸µµ…ÁÁ¥¹œ¹©Í½¹°œ¤¤ì(€…ÍÍ•ÉÑá…Ñ5…ÁÁ¥¹Ì¡…ÑÕ…±5…ÁÁ¥¹Ì°•áÁ•Ñ•‘5…ÁÁ¥¹Ì¤ì(€½¹ÍÐ•áÁ•Ñ•‘5…ÁÁ¥¹œ€ôµ…ÁÁ¥¹MÕµµ…Éä¡µ½‘•±Ì°•áÁ•Ñ•‘5…ÁÁ¥¹Ì°…ÁÁ•¹¹ÁÉ½©•Ñ¥½¸¹…Ñ±…Ì°¥‘•¹Ñ¥Ñå¡•¬¤ì(€½¹ÍÐ…ÑÕ…±5…ÁÁ¥¹œ€ôÉ•…‘)Í½¸¡Á…Ñ ¹©½¥¸¡É½½Ð°€µ…ÁÁ¥¹œµ½Ù•É…”¹©Í½¸œ¤¤ì(€¥˜€¡ÍÑ…‰±•)Í½¸¡…ÑÕ…±5…ÁÁ¥¹œ¤€„ôôÍÑ…‰±•)Í½¸¡•áÁ•Ñ•‘5…ÁÁ¥¹œ¤ñð…ÑÕ…±5…ÁÁ¥¹œ¹Õ¹µ…ÁÁ•‘¥•±‘Ì¹±•¹Ñ ñð…ÑÕ…±5…ÁÁ¥¹œ¹Õ¹µ…ÁÁ•‘A…­…•¥•±‘Ì¹±•¹Ñ ñð…ÑÕ…±5…Á¥¹œ¹Õ¹•áÁ•Ñ•‘M½ÕÉ•ÑÑÉ¥‰ÕÑ¥½¹Ì¤™…¥° µ…ÁÁ¥¹œ½Ù•É…”µ¥Íµ…Ñ œ¤ì(€½¹ÍÐ¥¹Ù…É¥…¹ÑÌ€ôÉ•…‘)Í½¸¡Á…Ñ ¹©½¥¸¡É½½Ð°€…ÁÁ•¹µ¥¹Ù…É¥…¹ÑÌ¹©Í½¸œ¤¤ì(€¥˜€¡ÍÑ…‰±•)Í½¸¡¥¹Ù…É¥…¹ÑÌ¤€„ôôÍÑ…‰±•)Í½¸¡…ÁÁ•¹¹ÁÉ½½˜¤¤™…¥° …ÁÁ•¹¥¹Ù…É¥…¹Ð¥Ì¹½ÐÉ•½µÁÕÑ•™É½´½Á¥•Á…­•ÑÌ…¹Í•±•Ñ¥½¸œ¤ì(€½¹ÍÐ‘•ÍÑÉÕÑ¥Ù”€ôÉ•…‘)Í½¸¡Á…Ñ ¹©½¥¸¡É½½Ð°€Á¡…Í”Ìµ‘•ÍÑÉÕÑ¥Ù”µÉ•ÍÕ±ÑÌ¹©Í½¸œ¤¤ì(€¥˜€¡‘•ÍÑÉÕÑ¥Ù”¹É•ÍÕ±ÑÌ¹±•¹Ñ €ð€ÄÀñð‘•ÍÑÉÕÑ¥Ù”¹É•ÍÕ±ÑÌ¹Í½µ”¡¥Ñ•´€ôø¥Ñ•´¹ÍÑ…ÑÕÌ€„ôô€I)QœñðÑåÁ•½˜¥Ñ•´¹•ÉÉ½È€„ôô€ÍÑÉ¥¹œœñð€…¥Ñ•´¹•ÉÉ½È¤¤™…¥° ‘•ÍÑÉÕÑ¥Ù”½Ù•É…”¥¹½µÁ±•Ñ”œ¤ì(€É•ÑÕÉ¸ì(€€€­¥¹è€½ÁÌ¹Á…­…•½¹ÑÉ…Ñ	É¥‘”¹Á¡…Í”ÍY•É¥™¥…Ñ¥½¸¹ØÈœ°ÍÑ…ÑÕÌè€AMLœ°…ÕÑ¡½É¥Ñäè™…±Í”°Á¡…Í•±½Í•è™…±Í”°(€€€±…¥µ•¥±¥¹œèA!MÍ}I%AQ}%1%9°½ÁÍ…¹‘¥‘…Ñ•M¡„èÉ••¥ÁÐ¹Í½ÕÉ”¹½ÁÍ…¹‘¥‘…Ñ•M¡„°(€€€Á…­…•½Õ¹ÐèÉ••¥ÁÐ¹½Ù•É…”¹Á…­…•½Õ¹Ð°Í½ÕÉ•½Õ¹ÐèÉ••¥ÁÐ¹½Ù•É…”¹Í½ÕÉ•½Õ¹Ð°(€€€Õ¥±•µ•¹Ñ½Õ¹ÐèÉ••¥ÁÐ¹½Ù•É…”¹Õ¥±•µ•¹Ñ½Õ¹Ð°Õ¥‘•½Õ¹ÐèÉ••¥ÁÐ¹½Ù•É…”¹Õ¥‘•½Õ¹Ð°(€€€…ÁÁÍI½Ý½Õ¹ÐèÉ••¥ÁÐ¹½Ù•É…”¹…ÁÁÍI½Ý½Õ¹Ð°µ…ÁÁ¥¹I½ÝÌèÉ••¥ÁÐ¹½Ù•É…”¹µ…ÁÁ¥¹I½ÝÌ°(€€€™¥±±½Õ¹Ðè€À°É••¥ÁÑ½Õ¹Ðè€À°É•Í¥‘Õ…±½Õ¹Ðè€À°(€€€…¹‘¥‘…Ñ•U¹¡…¹•èÑÉÕ”°…±Ñ•É¹…Ñ•…¹‘¥‘…Ñ•U¹¡…¹•èÑÉÕ”°…¹‘¥‘…Ñ•5¥ÍÍ•±•Ñ¥½¹I•©•Ñ•èÑÉÕ”°(€€€…•ÁÑ•‘½¹Ñ•áÑÁÁÍU¹¡…¹•èÑÉÕ”°•á…ÑAÉ½©•Ñ¥½¹5…ÁÁ¥¹œèÑÉÕ”°‰É½ÝÍ•ÉI••¥ÁÑI•ÅÕ¥É•èÑÉÕ”°(€ôì)ô(