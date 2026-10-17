"""Apply the bounded app overlay to the exact upstream checkout; never deploy."""
from pathlib import Path
import shutil
import subprocess

PIN = "dcb56ce2d174babb3f00112ac5b8cd597e58ab45"
source = Path(__file__).resolve().parent
assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == PIN


def replace_once(path, before, after):
    file = Path(path)
    text = file.read_text()
    assert text.count(before) == 1, f"upstream seam changed: {path}"
    file.write_text(text.replace(before, after, 1))


shutil.copyfile(source / "worker-oauth.ts", "src/worker-oauth.ts")
# A .d.ts sharing a .ts basename is shadowed by TypeScript source discovery.
shutil.copyfile(source / "worker-oauth.d.ts", "src/oauth-module.d.ts")
shutil.copyfile(source / "worker-oauth.alias.ts", "worker-oauth.alias.ts")
shutil.copyfile(source / "vitest.proof.config.ts", "vitest.proof.config.ts")
for name in ("worker-proof.setup.ts", "worker-auth.test.ts", "worker-app.test.ts"):
    shutil.copyfile(source / name, Path("test") / name)

replace_once("src/chat.ts", "const models = createModels();\nmodels.setProvider(openaiProvider());", "const defaultModels = createModels();\ndefaultModels.setProvider(openaiProvider());")
replace_once("src/chat.ts", "  ensureWakeupAt: (timestamp: number) => Promise<void>,\n", "  ensureWakeupAt: (timestamp: number) => Promise<void>,\n  models = defaultModels,\n")
replace_once("src/session.ts", 'import { createChatHarnessOptions } from "./chat.ts";', 'import { createChatHarnessOptions } from "./chat.ts";\nimport { createWorkerModels } from "./worker-oauth.ts";')
replace_once("src/session.ts", "    const chatOptions = createChatHarnessOptions((timestamp) =>\n      this.#setAlarmNoLaterThan(timestamp),\n    );", "    const chatOptions = createChatHarnessOptions(\n      (timestamp) => this.#setAlarmNoLaterThan(timestamp),\n      createWorkerModels(this.ctx.storage),\n    );")
replace_once("vite.config.ts", 'import { defineConfig } from "vite";', 'import { defineConfig } from "vite";\nimport { oauthAlias } from "./worker-oauth.alias.ts";')
replace_once("vite.config.ts", "export default defineConfig({\n", "export default defineConfig({\n  resolve: { alias: oauthAlias },\n")
