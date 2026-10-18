import { bindTypeLLM, generateTyped, TypedProviderError } from "../src/typellm.mjs";

// Independent CLI: one bounded stdin request, one JSON stdout line, no retry.
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    if ((size += chunk.byteLength) > 128 * 1024) throw new TypedProviderError("input_invalid");
    chunks.push(chunk);
  }
  let request;
  try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new TypedProviderError("input_invalid"); }
  const result = await generateTyped({ request, provider: bindTypeLLM({ apiKey: process.env.TYPELLM_API_KEY }) });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  const known = error instanceof TypedProviderError;
  const code = known ? error.code : "internal_error";
  const output = { error: code };
  if (known && error.upstreamStatus !== undefined) output.upstreamStatus = error.upstreamStatus;
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exitCode = code === "input_invalid" ? 1 : code === "auth_missing" ? 2
    : code === "provider_contract_error" ? 4 : known ? 3 : 5;
}
