import { createHash } from "node:crypto";
import { bindTypeLLM, generateTyped, TypedProviderError } from "../src/typellm.mjs";

// Opt-in observations stay off the normalized stdout and model request.
const responseMetadataRequested = process.argv.slice(2).includes("--response-metadata");
let stdinComplete = false, stdinBytes = null, stdinSha256 = null, responseMetadata = null;

// Independent CLI: one bounded stdin request, one JSON stdout line, no retry.
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    if ((size += chunk.byteLength) > 128 * 1024) throw new TypedProviderError("input_invalid");
    chunks.push(chunk);
  }
  const rawInput = Buffer.concat(chunks);
  stdinComplete = true;
  stdinBytes = rawInput.length;
  if (responseMetadataRequested) stdinSha256 = createHash("sha256").update(rawInput).digest("hex");
  let request;
  try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawInput)); }
  catch { throw new TypedProviderError("input_invalid"); }
  const result = await generateTyped({ request, provider: bindTypeLLM({ apiKey: process.env.TYPELLM_API_KEY }) });
  if (responseMetadataRequested) responseMetadata = generateTyped.responseMetadata(result);
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  const known = error instanceof TypedProviderError;
  const code = known ? error.code : "internal_error";
  const output = { error: code };
  if (known && error.upstreamStatus !== undefined) output.upstreamStatus = error.upstreamStatus;
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exitCode = code === "input_invalid" ? 1 : code === "auth_missing" ? 2
    : code === "provider_contract_error" ? 4 : known ? 3 : 5;
} finally {
  if (responseMetadataRequested) {
    const record = {
      schema: "typellm.cli-response-metadata.v1", stdinComplete, stdinBytes, stdinSha256,
      responseMetadataStatus: responseMetadata ? "SDK_OBSERVATION_AVAILABLE" : "NOT_OBSERVED",
      metadataSchema: responseMetadata?.schema ?? null,
      publicModelStatus: responseMetadata?.publicModelStatus ?? "UNKNOWN",
      reportedPublicModel: responseMetadata?.reportedPublicModel ?? null,
      responseIdStatus: responseMetadata?.responseIdStatus ?? "UNKNOWN",
      providerResponseId: responseMetadata?.providerResponseId ?? null,
      backendIdentityStatus: "UNKNOWN"
    };
    process.stderr.write("TYPELLM_RESPONSE_METADATA_JSON_BEGIN\n" + JSON.stringify(record)
      + "\nTYPELLM_RESPONSE_METADATA_JSON_END\n");
  }
}
