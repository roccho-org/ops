import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DiagnosticContractError,
  parseDiagnosticLine,
} from "../../structured-diagnostic/lib/diagnostic.mjs";

export const REQUIRED_DIAGNOSTIC_CODE = "artifact-assembly.source-digest-mismatch";
export const FAILURE_CLASSIFICATION = "artifact-source-integrity/digest-mismatch";
export const NEXT_ACTION = "inspect-selected-source-or-lock";

const APPLICABLE_OBLIGATIONS = Object.freeze([
  "abnormal_result",
  "separation",
  "diagnostic",
  "identification",
  "consumer_use",
  "traceability",
  "confidentiality",
  "ownership",
  "compatibility",
]);

const HOST_OWNED_FIELDS = Object.freeze([
  "event_id",
  "run_id",
  "instruction_id",
  "seq",
  "recorded_at",
  "timestamp",
  "status",
  "target",
  "final",
]);

const lines = (text) => {
  if (text === "") return [];
  const result = text.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
};

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const observationId = (value) => sha256(Buffer.from(JSON.stringify(value), "utf8"));

const evidence = (status, detail, extra = {}) => ({ status, detail, ...extra });

const parseDiagnostics = (stderr, contract) => {
  const diagnostics = [];
  const invalid = [];
  for (const [index, line] of lines(stderr).entries()) {
    if (line.trim() === "") {
      invalid.push({ line: index + 1, code: "DIAGNOSTIC_JSONL_EMPTY_LINE", detail: "blank stderr line" });
      continue;
    }
    try {
      diagnostics.push({ line: index + 1, value: parseDiagnosticLine(line, contract) });
    } catch (error) {
      if (!(error instanceof DiagnosticContractError)) throw error;
      invalid.push({ line: index + 1, code: error.code, detail: error.message });
    }
  }
  return { diagnostics, invalid };
};

const stdoutDiagnosticRows = (stdout, contract) => {
  const rows = [];
  for (const [index, line] of lines(stdout).entries()) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value) && value.schema === contract.diagnosticSchema) {
        rows.push({ line: index + 1, value });
      }
    } catch {
      // Primary output is package-specific. Classification never parses message prose.
    }
  }
  return rows;
};

const forgedHostFields = (diagnostics) => diagnostics.flatMap(({ line, value }) =>
  HOST_OWNED_FIELDS.filter((field) => Object.hasOwn(value, field)).map((field) => ({ line, field })));

const readEvaluatorIdentity = () => {
  const file = fileURLToPath(import.meta.url);
  const bytes = fs.readFileSync(file);
  return {
    path: "packages/shiftleft-admission/adapters/artifact_assembly_candidate.mjs",
    sha256: sha256(bytes),
  };
};

export function evaluateArtifactAssemblyCandidate({
  candidate,
  contract,
  failure,
  success,
  source,
}) {
  const requiredKeys = Object.keys(candidate.meaning.required).sort();
  const expectedKeys = [...APPLICABLE_OBLIGATIONS].sort();
  if (JSON.stringify(requiredKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`candidate required set changed: ${requiredKeys.join(",")}`);
  }
  if (candidate.authority !== false || candidate.admitted !== false) {
    throw new Error("candidate evaluation must remain non-authority and non-admitted");
  }
  if (source.actualSha256 === source.lockSha256) {
    throw new Error("selected route is not a real source digest mismatch");
  }

  const parsed = parseDiagnostics(failure.stderr, contract);
  const stdoutDiagnostics = stdoutDiagnosticRows(failure.stdout, contract);
  const matching = parsed.diagnostics.find(({ value }) => value.code === REQUIRED_DIAGNOSTIC_CODE) ?? null;
  const classification = matching ? {
    type: FAILURE_CLASSIFICATION,
    nextAction: NEXT_ACTION,
    diagnosticLine: matching.line,
    diagnosticCode: matching.value.code,
    messageParsingUsed: false,
  } : null;
  const hostFields = forgedHostFields(parsed.diagnostics);
  const rawLeak = [failure.stdout, failure.stderr].some((text) => text.includes(source.sentinel));
  const successPrimary = (() => {
    try {
      const rows = lines(success.stdout).filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
      return rows.length === 1 && rows[0].status === "PASS" && typeof rows[0].outputTreeSha256 === "string";
    } catch {
      return false;
    }
  })();

  const obligations = {
    abnormal_result: failure.status !== 0 && failure.signal === null && failure.receiptExists === false
      ? evidence("met", "digest mismatch remains a nonzero primary failure and writes no PASS receipt", { exitCode: failure.status })
      : evidence("unmet", "digest mismatch did not preserve the existing failed primary result", { exitCode: failure.status, signal: failure.signal }),
    separation: stdoutDiagnostics.length === 0
      ? evidence("met", "failure stdout contains no diagnostic/1 row", { stdoutBytes: Buffer.byteLength(failure.stdout) })
      : evidence("unmet", "diagnostic/1 polluted primary stdout", { rows: stdoutDiagnostics.map(({ line }) => line) }),
    diagnostic: parsed.diagnostics.length > 0
      ? evidence("met", "at least one valid diagnostic/1 row was emitted", { rows: parsed.diagnostics.length })
      : evidence("unmet", "selected digest-mismatch route emitted no valid diagnostic/1 row", { invalid: parsed.invalid }),
    identification: matching
      ? evidence("met", "stable diagnostic identity denotes source digest mismatch", { code: matching.value.code })
      : evidence("unmet", "no valid diagnostic carries the required stable source-digest-mismatch identity", {
          requiredCode: REQUIRED_DIAGNOSTIC_CODE,
          observedCodes: parsed.diagnostics.map(({ value }) => value.code),
        }),
    consumer_use: classification
      ? evidence("met", "receiver classified the failure from diagnostic code without message parsing", classification)
      : evidence("unmet", "receiver could not produce the typed classification or next action from diagnostic identity", {
          requiredCode: REQUIRED_DIAGNOSTIC_CODE,
          messageParsingUsed: false,
        }),
    traceability: classification
      ? evidence("met", "classification links contract, selected source, execution, and consumed diagnostic", {
          contractMeaningSha256: candidate.meaningSha256,
          selectedSourceId: source.id,
          actualSourceSha256: source.actualSha256,
          lockSha256: source.lockSha256,
          diagnosticLine: classification.diagnosticLine,
        })
      : evidence("unmet", "no consumed diagnostic/classification exists to bind to the selected source and execution", {
          contractMeaningSha256: candidate.meaningSha256,
          selectedSourceId: source.id,
          actualSourceSha256: source.actualSha256,
          lockSha256: source.lockSha256,
        }),
    confidentiality: rawLeak
      ? evidence("unmet", "raw source bytes leaked into process output")
      : evidence("met", "sentinel source bytes are absent from stdout/stderr", { sentinelSha256: sha256(Buffer.from(source.sentinel, "utf8")) }),
    ownership: hostFields.length === 0
      ? evidence("met", "no parsed diagnostic claims Host-owned identity, ordering, time, lifecycle, or final result", { parsedDiagnostics: parsed.diagnostics.length })
      : evidence("unmet", "diagnostic claims Host-owned fields", { hostFields }),
    compatibility: success.status === 0 && success.signal === null && success.receiptExists === true && success.receiptStatus === "PASS" && successPrimary
      ? evidence("met", "matching-digest control preserves normal exit, primary result, and receipt semantics", {
          exitCode: success.status,
          receiptStatus: success.receiptStatus,
        })
      : evidence("unmet", "matching-digest control did not preserve normal assembly semantics", {
          exitCode: success.status,
          signal: success.signal,
          receiptExists: success.receiptExists,
          receiptStatus: success.receiptStatus,
          primaryPass: successPrimary,
        }),
  };

  const statuses = Object.values(obligations).map(({ status }) => status);
  const unmet = Object.entries(obligations).filter(([, value]) => value.status === "unmet").map(([name]) => name);
  const unknown = Object.entries(obligations).filter(([, value]) => value.status === "unknown").map(([name]) => name);
  const conflict = Object.entries(obligations).filter(([, value]) => value.status === "conflict").map(([name]) => name);
  const execution = {
    route: "artifact-assembly assemble / required npm-tgz digest mismatch",
    sourceId: source.id,
    lockSha256: source.lockSha256,
    actualSourceSha256: source.actualSha256,
    exitCode: failure.status,
    signal: failure.signal,
    stdout: failure.stdout,
    stderr: failure.stderr,
    diagnosticRows: parsed.diagnostics.map(({ line, value }) => ({ line, code: value.code, level: value.level })),
    invalidDiagnosticRows: parsed.invalid,
  };

  return {
    kind: "ops.logger-finite-proof.candidate-finding",
    authority: false,
    admittedNormativeViolation: false,
    candidate: {
      source: candidate.source,
      meaningSha256: candidate.meaningSha256,
      obligationId: candidate.meaning.subject.obligation_id,
      claimCeiling: candidate.meaning.claim_ceiling,
    },
    target: candidate.target,
    evaluator: readEvaluatorIdentity(),
    observationId: observationId({ candidate: candidate.meaningSha256, target: candidate.target, execution }),
    finding: {
      status: unmet.length > 0 ? "unmet" : "met",
      code: unmet.length > 0 ? "candidate-contract-unmet" : "candidate-contract-met",
      unmet,
      messageParsingUsed: false,
    },
    coverage: {
      applicable: APPLICABLE_OBLIGATIONS.length,
      evaluated: statuses.length,
      met: statuses.filter((status) => status === "met").length,
      unmet: unmet.length,
      unknown: unknown.length,
      conflict: conflict.length,
      stale: 0,
    },
    obligations,
    execution,
    successControl: {
      exitCode: success.status,
      signal: success.signal,
      stdout: success.stdout,
      stderr: success.stderr,
      receiptExists: success.receiptExists,
      receiptStatus: success.receiptStatus,
    },
    nextBoundary: "independent R material true-positive review before producer or downstream consumer repair",
  };
}
