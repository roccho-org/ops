"""Package only the finite, owner-verified runtime; never deploy or bind secrets."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

source = Path("dist/pi_durable_cloudflare_do")
out = Path(sys.argv[1])
credit_mode = sys.argv[2:] == ["--opencode-credit"]
api_mode = credit_mode or sys.argv[2:] == ["--opencode"]
assert not sys.argv[2:] or api_mode, "Unknown runtime composition"
shutil.copytree(source, out)
original = json.loads((out / "wrangler.json").read_text())
(out / "runtime-entry.js").write_text('''export { Session } from "./index.js";
export default {
  async fetch(request, env) {
    if (env.PI_PROOF_TRANSIENT !== "true" || !env.PI_JEV_PROOF_SESSION ||
        !env.PI_ACCESS_ISSUER || !env.PI_ACCESS_AUDIENCE || !env.PI_ACCESS_OWNER_HASH ||
        !env.PI_JEV_PROOF_API_KEY || "PI_CHATGPT_BOOTSTRAP" in env) {
      return new Response("Runtime not admitted", {status:503});
    }
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/api/sessions/" + env.PI_JEV_PROOF_SESSION ||
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
        url.search !== "") return new Response("Not found", {status:404});
    return env.SESSIONS.getByName(env.PI_JEV_PROOF_SESSION).fetch(request);
  }
};
''')
if api_mode:
    entry = (out / "runtime-entry.js").read_text()
    entry = entry.replace('env.PI_PROOF_TRANSIENT !== "true"', 'env.PI_PROOF_AUTH_MODE !== "opencode-go" || env.PI_PROOF_PROVIDER !== "opencode-go" || env.PI_PROOF_MODEL !== "gpt-6-luna" || env.PI_JEV_PROOF_SESSION !== "owner-jev-opencode-proof-20261021" || env.PI_PROOF_TRANSIENT === "true" || !env.OPENCODE_API_KEY')
    if credit_mode:
        entry = entry.replace('"opencode-go"', '"opencode"')
    (out / "runtime-entry.js").write_text(entry)
(out / "wrangler.json").write_text(json.dumps({
    "name": "pi-jev-owner-proof", "main": "runtime-entry.js",
    "compatibility_date": original["compatibility_date"],
    "compatibility_flags": original["compatibility_flags"],
    "no_bundle": True, "find_additional_modules": True,
    "rules": [{"type": "ESModule", "globs": ["**/*.js"], "fallthrough": True}],
    "durable_objects": {"bindings": [{"name": "SESSIONS", "class_name": "Session"}]},
    "migrations": [{"tag": "pi-jev-proof-v1", "new_sqlite_classes": ["Session"]}],
    "workers_dev": True, "preview_urls": False,
    "observability": {"enabled": False},
}, indent=2) + "\n")
(out / "source.json").write_text(json.dumps({
    "schema": "pi-jev-runtime-source.v1",
    "ops_sha": subprocess.check_output(["git", "-C", "../ops", "rev-parse", "HEAD"], text=True).strip(),
    "upstream_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
    "scope": "KEYLESS_SELECTED_OWNER_TRANSIENT_RUNTIME",
    "deployment": "NOT_RUN",
    "required_vars": ["PI_PROOF_TRANSIENT", "PI_JEV_PROOF_SESSION", "PI_ACCESS_ISSUER",
                      "PI_ACCESS_AUDIENCE", "PI_ACCESS_OWNER_HASH"],
    "required_secret": "PI_JEV_PROOF_API_KEY from existing owner Jev slot; never ChatGPT credentials",
    "forbidden_binding": "PI_CHATGPT_BOOTSTRAP",
    "admission": "Separate envs review, owner pins, migration and actual deployment readback required",
}, indent=2) + "\n")

if api_mode:
    metadata = json.loads((out / "source.json").read_text())
    metadata.update(scope="KEY_BOUND_SELECTED_OWNER_OPENCODE_RUNTIME",
        required_vars=["PI_PROOF_AUTH_MODE", "PI_PROOF_PROVIDER", "PI_PROOF_MODEL", "PI_JEV_PROOF_SESSION",
                       "PI_ACCESS_ISSUER", "PI_ACCESS_AUDIENCE", "PI_ACCESS_OWNER_HASH"],
        required_secret="OPENCODE_API_KEY and PI_JEV_PROOF_API_KEY via separately admitted standard bindings",
        proof_session="owner-jev-opencode-proof-20261021", model_post_limit=3,
        provider="opencode-go", model="gpt-6-luna",
        base_url="https://opencode.ai/inference/go/openai/v1")
    if credit_mode:
        metadata.update(scope="KEY_BOUND_SELECTED_OWNER_OPENCODE_CREDIT_RUNTIME", provider="opencode",
            base_url="https://opencode.ai/inference/openai/v1", model_post_limit=4, recovery_start_offset=1)
    (out / "source.json").write_text(json.dumps(metadata, indent=2) + "\n")

import hashlib
(out / "SHA256SUMS").write_text("".join(
    f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(out)}\n"
    for path in sorted(out.rglob("*")) if path.is_file() and path.name != "SHA256SUMS"))
