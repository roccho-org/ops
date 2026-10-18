"""Package the built app's existing /auth handler; no deploy or credentials."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

source = Path('dist/pi_durable_cloudflare_do')
out = Path(sys.argv[1])
shutil.copytree(source, out)
original = json.loads((out / 'wrangler.json').read_text())
# This entry has no DO/asset/secret bindings and cannot dispatch chat routes.
(out / 'screen-entry.js').write_text('''import app from "./index.js";
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") url.pathname = "/auth";
    if (url.pathname !== "/auth" && !url.pathname.startsWith("/auth/")) return new Response("Screen-only Worker", {status: 404, headers: {"cache-control": "no-store"}});
    return app.fetch(new Request(url, request), {PI_OAUTH_HOST_ID: env.PI_OAUTH_HOST_ID});
  }
};
''')
(out / 'wrangler.json').write_text(json.dumps({
    'name': 'pi-worker-oauth-screen', 'main': 'screen-entry.js',
    'compatibility_date': original['compatibility_date'],
    'compatibility_flags': original['compatibility_flags'],
    'no_bundle': True, 'find_additional_modules': True,
    'rules': [{'type': 'ESModule', 'globs': ['**/*.js'], 'fallthrough': True}],
    'workers_dev': True, 'preview_urls': False,
    'observability': {'enabled': False},
}, indent=2) + '\n')
(out / 'source.json').write_text(json.dumps({
    'schema': 'pi-worker-screen-source.v1',
    'ops_sha': subprocess.check_output(['git', '-C', '../ops', 'rev-parse', 'HEAD'], text=True).strip(),
    'upstream_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'scope': 'SCREEN_ONLY_NO_TOKEN_EXCHANGE_OR_STORAGE',
    'deployment': 'NOT_RUN',
    'required_non_secret_binding': 'PI_OAUTH_HOST_ID: one stable UUID for this Worker host',
    'entry': 'same built app /auth handler; no chat/DO/asset/credential bindings',
}, indent=2) + '\n')
