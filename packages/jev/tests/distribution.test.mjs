import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const jevEntry = process.env.JEV_PROVIDER_ENTRY;
const typedEntry = process.env.TYPELLM_PROVIDER_ENTRY;

test("independent completed ESMs expose only their own API and run without a companion import", {
  skip: !jevEntry || !typedEntry,
}, async () => {
  const jev = await import(jevEntry);
  const typed = await import(typedEntry);
  assert.deepEqual(Object.keys(jev).sort(), ["JevContractError", "JevError", "JudgeProviderError", "askJevChoice",
    "askJevNoul", "askJevQuestions", "askJevScore", "bindJev", "judgeNamedChoices"]);
  assert.deepEqual(Object.keys(typed).sort(), ["TypedProviderError", "bindTypeLLM", "generateTyped"]);
  assert.doesNotMatch(await readFile(jevEntry, "utf8"), /api\.typellm\.ai|bindTypeLLM|generateTyped|\bimport\b|node:/);
  assert.doesNotMatch(await readFile(typedEntry, "utf8"), /api\.typesafe\.ai|bindJev|askJevQuestions|\bimport\b|node:/);
  let jevCalls = 0, typedCalls = 0;
  const judged = await jev.askJevQuestions({ state: { text: "fixture" },
    questions: { fits: { type: "noul", instructions: "Fits?" } },
    provider: jev.bindJev({ apiKey: "synthetic-jev", fetch: async (_url, init) => {
      jevCalls++; assert.equal(init.headers.authorization, "Bearer synthetic-jev");
      return new Response(JSON.stringify({ model: "resolved", answers: { fits: { type: "noul", noul: 0.8 } } }));
    } }),
  });
  assert.equal(judged.answers.fits.noul, 0.8);
  const generated = await typed.generateTyped({ request: { context: "fixture", questions: { name: { type: "string" } } },
    provider: typed.bindTypeLLM({ apiKey: "synthetic-typed", fetch: async (_url, init) => {
      typedCalls++; assert.equal(init.headers.authorization, "Bearer synthetic-typed");
      return new Response(JSON.stringify({ status: "completed", result: { name: "fixture" } }));
    } }),
  });
  assert.equal(generated.result.name, "fixture");
  assert.equal(jevCalls, 1); assert.equal(typedCalls, 1);
});
