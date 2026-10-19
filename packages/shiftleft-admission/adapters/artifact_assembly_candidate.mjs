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

const SOURCE_BINDING_FIELDS = Object.freeze([
  "source_id",
  "source_kind",
  "source_revision",
  "expected_sha256",
  "actual_sha256",
]);

const lines = (text) => {
  if (text === "") return [];
  const result = text.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
};

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const diagnosticSha256 = (diagnostic) => sha256(Buffer.from(`${JSON.stringify(diagnostic)}\n`, "utf8"));

const observationId = (value) => sha256(Buffer.from(JSON.stringify(value), "utf8"));

const evidence = (status, detail, extra = {}) => ({ status, detail, ...extra });

const expectedSourceBinding = (source) => ({
  source_id: source.id,
  source_kind: source.kind,
  source_revision: source.revision ?? null,
  expected_sha256: source.lockSha256,
  actual_sha256: source.actualSha256,
});

const sourceBindingDifferences = (diagnostic, source) => {
  const expected = expectedSourceBinding(source);
  const observed = diagnostic.fields ?? {};
  return SOURCE_BINDING_FIELDS
    .filter((field) => observed[field] !== expected[field])
    .map((field) => ({ field, expected: expected[field], observed: observed[field] ?? null }));
};

export function consumeArtifactAssemblyDiagnostic({
  contractMeaningSha256,
  diagnostic,
  line,
  source,
}) {
  if (diagnostic.code !== REQUIRED_DIAGNOSTIC_CODE) {
    return {
      accepted: false,
      reason: "diagnostic-code",
      diagnosticCode: diagnostic.code,
      diagnosticLine: line,
      messageParsingUsed: false,
    };
  }

  const differences = sourceBindingDifferences(diagnostic, source);
  if (differences.length > 0) {
    return {
      accepted: false,
      reason: "source-binding",
      diagnosticCode: diagnostic.code,
      diagnosticLine: line,
      diagnosticSha256: diagnosticSha256(diagnostic),
      differences,
      messageParsingUsed: false,
    };
  }

  return {
    accepted: true,
    reason: null,
    classification: {
      type: FAILURE_CLASSIFICATION,
      nextAction: NEXT_ACTION,
      diagnosticLine: line,
      diagnosticCode: diagnostic.code,
      diagnosticSha256: diagnosticSha256(diagnostic),
      messageParsingUsed: false,
      binding: {
        contractMeaningSha256,
        ...expectedSourceBinding(source),
      },
    },
  };
}

export function consumeArtifactAssemblyStderr({
  contract,
  contractMeaningSha256,
  source,
  stderr,
}) {
  const diagnostics = [];
  const invalid = [];
  const consumptions = [];
  const hostFields = [];

  for (const [index, line] of lines(stderr).entries()) {
    if (line.trim() === "") {
      invalid.push({ line: index + 1, code: "DIAGNOSTIC_JSONL_EMPTY_LINE", detail: "blank stderr line" });
      continue;
    }
    try {
      const raw = JSON.parse(line);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const field of HOST_OWNED_FIELDS) {
          if (Object.hasOwn(raw, field)) hostFields.push({ line: index + 1, field });
        }
      }
    } catch {
      // Contract parsing below owns the invalid-JSON result.
    }
    try {
      const value = parseDiagnosticLine(line, contract);
      const parsed = { line: index + 1, value };
      diagnostics.push(parsed);
      consumptions.push({
        line: parsed.line,
        value,
        result: consumeArtifactAssemblyDiagnostic({
          contractMeaningSha256,
          diagnostic: value,
          line: parsed.line,
          source,
        }),
      });
    } catch (error) {
      if (!(error instanceof DiagnosticContractError)) throw error;
      invalid.push({ line: index + 1, code: error.code, detail: error.message });
    }
  }

  return {
    diagnostics,
    invalid,
    consumptions,
    hostFields,
    accepted: consumptions.find(({ result }) => result.accepted) ?? null,
  };
}

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
  implementation,
  source,
  success,
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

  const consumed = consumeArtifactAssemblyStderr({
    contract,
    contractMeaningSha256: candidate.meaningSha256,
    source,
    stderr: failure.stderr,
  });
  const stdoutDiagnostics = stdoutDiagnosticRows(failure.stdout, contract);
  const matchingCode = consumed.diagnostics.filter(({ value }) => value.code === REQUIRED_DIAGNOSTIC_CODE);
  const classification = consumed.accepted?.result.classification ?? null;
  const hostFields = consumed.hostFields;
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
    diagnostic: consumed.diagnostics.length > 0 && consumed.invalid.length === 0
      ? evidence("met", "the selected route emitted valid diagnostic/1 JSONL without invalid stderr rows", {
          rows: consumed.diagnostics.length,
          invalidRows: 0,
        })
      : evidence("unmet", "selected digest-mismatch stderr was not clean valid diagnostic/1 JSONL", {
          validRows: consumed.diagnostics.length,
          invalid: consumed.invalid,
        }),
    identification: matchingCode.length > 0
      ? evidence("met", "stable diagnostic identity denotes source digest mismatch", {
          code: REQUIRED_DIAGNOSTIC_CODE,
          rows: matchingCode.map(({ line }) => line),
        })
      : evidence("unmet", "no valid diagnostic carries the required stable source-digest-mismatch identity", {
          requiredCode: REQUIRED_DIAGNOSTIC_CODE,
          observedCodes: consumed.diagnostics.map(({ value }) => value.code),
        }),
    consumer_use: classification
      ? evidence("met", "receiver classified the failure from diagnostic code and machine fields without message parsing", classification)
      : evidence("unmet", "receiver could not produce the typed classification or next action from diagnostic identity", {
          requiredCode: REQUIRED_DIAGNOSTIC_CODE,
          rejections: consumed.consumptions.map(({ line, result }) => ({
            line,
            reason: result.reason,
            differences: result.differences ?? [],
          })),
          messageParsingUsed: false,
        }),
    traceability: classification
      ? evidence("met", "classification binds the actual diagnostic, selected source, execution, and candidate Contract", {
          contractMeaningSha256: candidate.meaningSha256,
          selectedSourceId: source.id,
          sourceKind: source.kind,
          sourceRevision: source.revision,
          actualSourceSha256: source.actualSha256,
          lockSha256: source.lockSha256,
          diagnosticLine: classification.diagnosticLine,
          diagnosticSha256: classification.diagnosticSha256,
        })
      : evidence("unmet", "no consumed diagnostic/classification exists to bind to the selected source and execution", {
          contractMeaningSha256: candidate.meaningSha256,
          selectedSourceId: source.id,
          sourceRevision: source.revision,
          actualSourceSha256: source.actualSha256,
          lockSha256: source.lockSha256,
        }),
    confidentiality: rawLeak
      ? evidence("unmet", "raw source bytes leaked into process output")
      : evidence("met", "sentinel source bytes are absent from stdout/stderr", { sentinelSha256: sha256(Buffer.from(source.sentinel, "utf8")) }),
    ownership: hostFields.length === 0
      ? evidence("met", "no parsed diagnostic claims Host-owned identity, ordering, time, lifecycle, or final result", { parsedDiagnostics: consumed.diagnostics.length })
      : evidence("unmet", "diagnostic claims Host-owned fields", { hostFields }),
    compatibility: success.status === 0 && success.signal === null && success.receiptExists === true && success.receiptStatus === "PASS" && successPrimary
      ? evidence("met", "matching-digest control preserves normal exit, primary result, and receipt semantics", {
          exitCode: success.status,
          receiptStatus: success.receiptStatus,
          receiptSha256: success.receiptSha256,
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
    sourceKind: source.kind,
    sourceRevision: source.revision,
    lockSha256: source.lockSha256,
    actualSourceSha256: source.actualSha256,
    exitCode: failure.status,
    signal: failure.signal,
    stdout: failure.stdout,
    stderr: failure.stderr,
    diagnosticRows: consumed.consumptions.map(({ line, result, value }) => ({
      line,
      value,
      sha256: diagnosticSha256(value),
      consumption: result.accepted
        ? {
            accepted: true,
            type: result.classification.type,
            nextAction: result.classification.nextAction,
            messageParsingUsed: false,
          }
        : {
            accepted: false,
            reason: result.reason,
            differences: result.differences ?? [],
            messageParsingUsed: false,
          },
    })),
    invalidDiagnosticRows: consumed.invalid,
    hostOwnedFieldClaims: consumed.hostFields,
    receiptExists: failure.receiptExists,
  };
  const evaluator = readEvaluatorIdentity();
  const observation = {
    candidate: candidate.meaningSha256,
    target: candidate.target,
    implementation,
    evaluator,
    execution,
    classification,
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
    implementation,
    evaluator,
    observationId: observationId(observation),
    classification,
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
      receiptSha256: success.receiptSha256,
      receipt: success.receipt,
    },
    nextBoundary: unmet.length === 0
      ? "independent R old/new, counterexample, evidence, and finite residual review; no merge/release/deploy authority"
      : "independent R material true-positive review before producer or downstream consumer repair",
  };
}
