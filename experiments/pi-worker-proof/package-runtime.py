"""Package only the finite, owner-verified runtime; never deploy or bind secrets."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

source = Path("dist/pi_durable_cloudflare_do")
out = Path(sys.argv[1])
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

import hashlib
(out / "SHA256SUMS").write_text("".join(
    f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(out)}\n"
    for path in sorted(out.rglob("*")) if path.is_file() and path.name != "SHA256SUMS"))
