#!/usr/bin/env python3
"""Finite CLI probe, not an agent runtime. Default: plan; --run allows three invocations.

Only native session files are inspected. Raw process output and credentials are
never copied into the report. OBSERVED is not an independent acceptance receipt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import uuid

PROVIDER = "opencode-go"
LIMIT = 2 * 1024 * 1024
SHA = re.compile(r"[0-9a-f]{40}\Z")
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\Z")


class Refused(ValueError):
    """Only closed, non-secret reason codes leave this module."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise Refused(code)


def inspect_session(raw: bytes, previous: bytes, session: str, cwd: str,
                    model: str, marker: str, count: int) -> dict:
    require(0 < len(raw) <= LIMIT and raw.endswith(b"\n"), "SESSION_SIZE_OR_FRAMING")
    require(raw.startswith(previous) and len(raw) > len(previous), "HISTORY_REWRITTEN")
    try:
        rows = [json.loads(line) for line in raw.split(b"\n")[:-1]]
    except (ValueError, UnicodeError):
        raise Refused("SESSION_JSON") from None
    require(all(isinstance(row, dict) for row in rows), "SESSION_OBJECTS")
    header = rows[0]
    require(header.get("type") == "session" and header.get("version") == 3
            and header.get("id") == session and header.get("cwd") == cwd,
            "SESSION_IDENTITY")
    seen: dict[str, dict] = {}
    messages = []
    for row in rows[1:]:
        identity, parent = row.get("id"), row.get("parentId")
        require(isinstance(identity, str) and identity not in seen, "ENTRY_ID")
        require(parent is None or isinstance(parent, str) and parent in seen, "ENTRY_PARENT")
        seen[identity] = row
        message = row.get("message")
        if row.get("type") == "message" and isinstance(message, dict):
            if message.get("role") == "assistant":
                messages.append((row, message))
    require(len(messages) == count, "ASSISTANT_COUNT")
    entry, message = messages[-1]
    require(message.get("provider") == PROVIDER and message.get("model") == model,
            "PROVIDER_OR_MODEL")
    require(message.get("stopReason") == "stop", "ASSISTANT_NOT_SUCCESS")
    content = message.get("content")
    require(isinstance(content, list) and all(isinstance(x, dict) for x in content), "CONTENT")
    require(not any(x.get("type") == "toolCall" for x in content), "UNEXPECTED_TOOL")
    text = "".join(x.get("text", "") for x in content if x.get("type") == "text")
    require(text.strip() == marker, "HISTORY_RECALL")
    # Every prior assistant must be on the selected branch, not merely somewhere in the file.
    ancestors: set[str] = set()
    parent = entry.get("parentId")
    while parent is not None:
        ancestors.add(parent)
        parent = seen[parent].get("parentId")
    require(all(old[0]["id"] in ancestors for old in messages[:-1]), "HISTORY_BRANCH")
    return {"provider": PROVIDER, "model": model, "assistant_count": count,
            "entry_count": len(rows) - 1}


def command(pi: Path, envs_sha: str, model: str, session: str,
            directory: Path, prompt: str) -> list[str]:
    return [str(pi), "--envs-sha", envs_sha, "--mode", "json", "--provider", PROVIDER,
            "--model", model, "--session-id", session, "--session-dir", str(directory),
            "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates",
            "--no-context-files", "--no-themes", "--no-mcp", "--no-approve", "--offline",
            "--", prompt]


def invoke(argv: list[str], cwd: Path, timeout: int) -> None:
    # New process group: a timeout also stops auth-command descendants. No replay.
    with subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          start_new_session=True) as child:
        try:
            result = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            raise Refused("INVOCATION_TIMEOUT_UNKNOWN") from None
    require(result == 0, "INVOCATION_FAILED")


def probe(args: argparse.Namespace) -> dict:
    require(SHA.fullmatch(args.source_sha) is not None, "SOURCE_SHA")
    require(SHA.fullmatch(args.envs_sha) is not None, "ENVS_SHA")
    require(all(MODEL.fullmatch(m) for m in (args.model_a, args.model_b)), "EXACT_MODEL_IDS")
    require(args.model_a != args.model_b, "TWO_MODELS_REQUIRED")
    require(1 <= args.timeout <= 300, "TIMEOUT_BOUND")
    report = {"kind": "ops.piCliProbe.v1", "source_sha": args.source_sha,
              "envs_sha": args.envs_sha, "models": [args.model_a, args.model_b, args.model_b],
              "status": "PLAN", "provider_use": "NOT_RUN", "invocations_started": 0,
              "independent_acceptance": "NOT_PROVEN", "os_reboot_rebuild": "NOT_RUN"}
    if not args.run:
        return report
    require(not os.environ.get("CI") and not os.environ.get("GITHUB_ACTIONS"), "NO_LIVE_IN_CI")
    pi = Path(args.pi)
    require(pi.is_absolute() and pi.is_file() and os.access(pi, os.X_OK), "PI_UNAVAILABLE")
    require(re.fullmatch(r"[0-9a-f]{64}", args.pi_sha256 or "") is not None, "PI_DIGEST_REQUIRED")
    require(hashlib.sha256(pi.read_bytes()).hexdigest() == args.pi_sha256, "PI_DIGEST")
    workspace = Path(args.workspace)
    require(workspace.is_absolute(), "ABSOLUTE_WORKSPACE")
    # A new private workspace rejects competing/repeated runs before any provider use.
    workspace.mkdir(mode=0o700, parents=False, exist_ok=False)
    cwd = workspace.resolve()
    sessions = cwd / "sessions"
    sessions.mkdir(mode=0o700)
    marker, session = "pah-" + uuid.uuid4().hex, uuid.uuid4().hex
    previous = b""
    snapshots = []
    report["session_id"] = session
    try:
        for index, model in enumerate(report["models"], 1):
            prompt = (f"Remember this marker for this conversation: {marker}. Return only the marker."
                      if index == 1 else "Return only the exact marker from the first user message.")
            report["invocations_started"] = index
            report["provider_use"] = "UNKNOWN"
            invoke(command(pi, args.envs_sha, model, session, sessions, prompt), cwd, args.timeout)
            files = list(sessions.rglob("*.jsonl"))
            require(len(files) == 1 and files[0].is_file() and not files[0].is_symlink(), "ONE_SESSION")
            require(files[0].stat().st_size <= LIMIT, "SESSION_SIZE_OR_FRAMING")
            raw = files[0].read_bytes()
            snapshots.append(inspect_session(raw, previous, session, str(cwd), model, marker, index))
            previous = raw
    except (Refused, OSError) as exc:
        report.update(status="NOT_PROVEN", reason=str(exc) if isinstance(exc, Refused) else "LOCAL_IO")
        return report
    report.update(status="OBSERVED", provider_use="CLI_AND_HISTORY_OBSERVED",
                  pi_sha256=args.pi_sha256, snapshots=snapshots)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("pi", "source-sha", "envs-sha", "model-a", "model-b", "workspace"):
        parser.add_argument("--" + flag, required=True)
    parser.add_argument("--pi-sha256")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    try:
        report = probe(args)
    except (Refused, OSError) as exc:
        report = {"kind": "ops.piCliProbe.v1", "status": "NOT_PROVEN", "provider_use": "NOT_RUN",
                  "reason": str(exc) if isinstance(exc, Refused) else "LOCAL_IO"}
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["status"] in {"PLAN", "OBSERVED"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
