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


for name in ("worker-oauth.ts", "worker-screen.ts"):
    shutil.copyfile(source / name, Path("src") / name)
# A .d.ts sharing a .ts basename is shadowed by TypeScript source discovery.
shutil.copyfile(source / "worker-oauth.d.ts", "src/oauth-module.d.ts")
shutil.copyfile(source / "worker-oauth.alias.ts", "worker-oauth.alias.ts")
shutil.copyfile(source / "vitest.proof.config.ts", "vitest.proof.config.ts")
for name in ("worker-proof.setup.ts", "worker-auth.test.ts", "worker-app.test.ts", "worker-screen.test.ts"):
    shutil.copyfile(source / name, Path("test") / name)

replace_once("src/chat.ts", "const models = createModels();\nmodels.setProvider(openaiProvider());", "const defaultModels = createModels();\ndefaultModels.setProvider(openaiProvider());")
replace_once("src/chat.ts", "  ensureWakeupAt: (timestamp: number) => Promise<void>,\n", "  ensureWakeupAt: (timestamp: number) => Promise<void>,\n  models = defaultModels,\n")
# Both caches are recoverable from SQLite; do not retain idle Worker instances.
replace_once("src/chat.ts", "      documentRetentionMs: 0,\n", "      documentRetentionMs: 0,\n      ...(jevTool ? { contextRetentionMs: 0 } : {}),\n")
replace_once("src/session.ts", 'import { createChatHarnessOptions } from "./chat.ts";', 'import { createChatHarnessOptions } from "./chat.ts";\nimport { bootstrapWorkerCredential, createWorkerModels } from "./worker-oauth.ts";')
replace_once("src/session.ts", "    const chatOptions = createChatHarnessOptions((timestamp) =>\n      this.#setAlarmNoLaterThan(timestamp),\n    );", "    await bootstrapWorkerCredential(this.ctx, this.env);\n    const chatOptions = createChatHarnessOptions(\n      (timestamp) => this.#setAlarmNoLaterThan(timestamp),\n      createWorkerModels(this.ctx.storage),\n    );")
replace_once("vite.config.ts", 'import { defineConfig } from "vite";', 'import { defineConfig } from "vite";\nimport { oauthAlias } from "./worker-oauth.alias.ts";')
replace_once("vite.config.ts", "export default defineConfig({\n", "export default defineConfig({\n  resolve: { alias: oauthAlias },\n")
# Both the full app and the screen-only deployment call this one handler.
replace_once("src/index.ts", 'export { Session } from "./session.ts";', 'export { Session } from "./session.ts";\nimport { oauthScreen } from "./worker-screen.ts";')
replace_once("src/index.ts", "    const url = new URL(request.url);\n", '    const url = new URL(request.url);\n    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return oauthScreen(request, env);\n')
replace_once("wrangler.jsonc", '  "compatibility_date": "2026-09-23",', '  "compatibility_date": "2026-09-23",\n  "compatibility_flags": ["nodejs_compat"],')
replace_once("wrangler.jsonc", '"run_worker_first": ["/api/*"]', '"run_worker_first": ["/api/*", "/auth", "/auth/*"]')
# The proof tool consumes the canonical client bytes; no handwritten client fork.
jev = source.parent.parent / "packages" / "jev" / "src"
Path("src/jev-client").mkdir(exist_ok=True)
for name in ("client.mjs", "core.mjs"):
    shutil.copyfile(jev / name, Path("src/jev-client") / name)
shutil.copyfile(source / "jev-client.d.mts", "src/jev-client/client.d.mts")
shutil.copyfile(source / "worker-jev.ts", "src/worker-jev.ts")
replace_once("src/chat.ts", 'import { createScheduleTool, getWeatherTool } from "./tools.ts";', 'import { createScheduleTool, getWeatherTool } from "./tools.ts";\nimport type { ToolRegistration } from "@earendil-works/pi-durable";')
replace_once("src/chat.ts", "  models = defaultModels,\n", "  models = defaultModels,\n  jevTool?: ToolRegistration,\n")
replace_once("src/chat.ts", "  const scheduleTool = createScheduleTool(ensureWakeupAt);", "  const scheduleTool = createScheduleTool(ensureWakeupAt);\n  const tools = jevTool ? [jevTool] : [getWeatherTool, scheduleTool, searchHistoryTool];")
chat = Path("src/chat.ts")
text = chat.read_text()
assert text.count("tools: [getWeatherTool, scheduleTool, searchHistoryTool],") == 2
chat.write_text(text.replace("tools: [getWeatherTool, scheduleTool, searchHistoryTool],", "tools,"))
replace_once("src/chat.ts", "      extensions: [chatExtension],", "      extensions: [chatExtension],\n      ...(jevTool ? { stream: { maxRetries: 0 }, retry: { enabled: false, maxRetries: 0 } } : {}),")
replace_once("src/session.ts", 'import { bootstrapWorkerCredential, createWorkerModels } from "./worker-oauth.ts";', 'import { bootstrapWorkerCredential, createWorkerModels } from "./worker-oauth.ts";\nimport { bindJevProof } from "./worker-jev.ts";')
replace_once("src/session.ts", "    const chatOptions = createChatHarnessOptions(", "    const proof = this.env as Env & { PI_JEV_PROOF_API_KEY?: string; PI_JEV_PROOF_SESSION?: string };\n    const selected = proof.PI_JEV_PROOF_SESSION !== undefined && this.env.SESSIONS.idFromName(proof.PI_JEV_PROOF_SESSION).equals(this.ctx.id);\n    const chatOptions = createChatHarnessOptions(")
replace_once("src/session.ts", "      createWorkerModels(this.ctx.storage),", "      createWorkerModels(this.ctx.storage),\n      selected ? bindJevProof(proof.PI_JEV_PROOF_API_KEY) : undefined,")

# The shared verifier is derived from this Ops tree and its separate frozen lock.
shutil.copyfile(source / "operator/dist/auth.mjs", "src/proof-auth.mjs")
replace_once("src/session.ts", "bootstrapWorkerCredential, createWorkerModels", "bootstrapWorkerCredential, createWorkerModels, TransientWorkerProof, type ProofEnvironment")
replace_once("src/session.ts", "  #harness!: Harness;", "  #harness!: Harness;\n  #proof?: TransientWorkerProof;")
replace_once("src/session.ts", "    await bootstrapWorkerCredential(this.ctx, this.env);\n", "")
replace_once("src/session.ts", "    const chatOptions = createChatHarnessOptions(", "    const transient = selected && (proof as ProofEnvironment).PI_PROOF_TRANSIENT === \"true\";\n    if (transient) this.#proof = new TransientWorkerProof(this.ctx.storage);\n    else await bootstrapWorkerCredential(this.ctx, this.env);\n    const chatOptions = createChatHarnessOptions(")
replace_once("src/session.ts", "      createWorkerModels(this.ctx.storage),", "      this.#proof ? this.#proof.models() : createWorkerModels(this.ctx.storage),")
replace_once("src/session.ts", "    const pair = new WebSocketPair();", "    let witness: HeadersInit | undefined;\n    if (this.#proof) {\n      try { witness = await this.#proof.attach(request, this.env as ProofEnvironment); }\n      catch { return json({ error: \"Owner authorization required\" }, 403); }\n    }\n    const pair = new WebSocketPair();")
replace_once("src/session.ts", "return new Response(null, { status: 101, webSocket: client });", "return new Response(null, { status: 101, webSocket: client, headers: witness });")

# Terminal provider diagnostics must not become durable credential copies.
replace_once("src/chat.ts", "  configure,\n", "  configure,\n  hook,\n  GenerationTask,\n")
replace_once("src/chat.ts", '    name: "chat",\n', '    name: "chat",\n    hooks: jevTool ? [hook(GenerationTask, { afterResponse(message) {\n      if (message.stopReason === "error" || message.stopReason === "aborted") {\n        message.errorMessage = "Proof provider request failed";\n        message.content = [];\n        delete message.responseId;\n        delete message.rawStopReason;\n      }\n    } })] : [],\n')

replace_once("src/chat.ts", "  jevTool?: ToolRegistration,\n", "  jevTool?: ToolRegistration,\n  failureMetadata?: (message: object) => string,\n")
replace_once("src/session.ts", "      selected ? bindJevProof(proof.PI_JEV_PROOF_API_KEY) : undefined,", "      selected ? bindJevProof(proof.PI_JEV_PROOF_API_KEY) : undefined,\n      this.#proof ? (message) => this.#proof!.failureMetadata(message) : undefined,")
replace_once("src/chat.ts", 'message.errorMessage = "Proof provider request failed";', 'message.errorMessage = failureMetadata ? failureMetadata(message) : "Proof provider request failed";')

# Explicit API-key proof is a separate fixed session, never key-presence fallback.
replace_once("src/chat.ts", "  failureMetadata?: (message: object) => string,\n", '  failureMetadata?: (message: object) => string,\n  proofProvider = "openai",\n')
replace_once("src/chat.ts", 'model: { provider: "openai", modelId: "gpt-6-luna" }', 'model: { provider: proofProvider, modelId: "gpt-6-luna" }')
replace_once("src/session.ts",
    '    const transient = selected && (proof as ProofEnvironment).PI_PROOF_TRANSIENT === "true";\n    if (transient) this.#proof = new TransientWorkerProof(this.ctx.storage);',
    '    const apiMode = (proof as ProofEnvironment).PI_PROOF_AUTH_MODE;\n'
    '    const api = apiMode === "opencode-go" || apiMode === "opencode";\n'
    '    if (api && (!selected || proof.PI_JEV_PROOF_SESSION !== "owner-jev-opencode-proof-20261021" ||\n'
    '        (proof as ProofEnvironment).PI_PROOF_PROVIDER !== apiMode ||\n'
    '        (proof as ProofEnvironment).PI_PROOF_MODEL !== "gpt-6-luna" ||\n'
    '        (proof as ProofEnvironment).PI_PROOF_TRANSIENT === "true")) throw new Error("API proof selection rejected");\n'
    '    const transient = selected && (proof as ProofEnvironment).PI_PROOF_TRANSIENT === "true";\n'
    '    if (transient || api) this.#proof = new TransientWorkerProof(this.ctx.storage,\n'
    '      api ? { apiKey: (proof as ProofEnvironment).OPENCODE_API_KEY ?? "", provider: apiMode as "opencode-go" | "opencode", sockets: () => this.ctx.getWebSockets() } : undefined);')
replace_once("src/session.ts",
    'selected ? bindJevProof(proof.PI_JEV_PROOF_API_KEY) : undefined,',
    'selected ? bindJevProof(proof.PI_JEV_PROOF_API_KEY, () => this.#proof?.requireOwner()) : undefined,')
replace_once("src/session.ts",
    '      this.#proof ? (message) => this.#proof!.failureMetadata(message) : undefined,',
    '      this.#proof ? (message) => this.#proof!.failureMetadata(message) : undefined,\n'
    '      api ? apiMode! : "openai",')
replace_once("src/session.ts", '    this.ctx.acceptWebSocket(server);',
    '    this.ctx.acceptWebSocket(server);\n    this.#proof?.admit(server);')
replace_once("src/session.ts", '      reportError("Session WebSocket connection failed", error);',
    '      this.#proof?.release(server);\n      reportError("Session WebSocket connection failed", error);')
replace_once("src/session.ts", '    _wasClean: boolean,\n  ): Promise<void> {\n',
    '    _wasClean: boolean,\n  ): Promise<void> {\n    this.#proof?.release(socket);\n')
replace_once("src/session.ts", '  override async webSocketError(socket: WebSocket, error: unknown): Promise<void> {\n',
    '  override async webSocketError(socket: WebSocket, error: unknown): Promise<void> {\n    this.#proof?.release(socket);\n')

# The same trusted per-stream terminal identity also carries the noncredential wire witness.
replace_once("src/chat.ts", '    hooks: jevTool ? [hook(GenerationTask, { afterResponse(message) {\n',
    '    hooks: jevTool ? [hook(GenerationTask, { afterResponse(message) {\n'
    '      const diagnostic = failureMetadata?.(message);\n')
replace_once("src/chat.ts", 'message.errorMessage = failureMetadata ? failureMetadata(message) : "Proof provider request failed";',
    'message.errorMessage = diagnostic ?? "Proof provider request failed";')

# An existing Go conversation retains pi.agent; change only its model on the
# already-authorized PAYG prompt command, before submitting that new input.
replace_once("src/session.ts", '  Harness,\n', '  configure as configureProofModel,\n  Harness,\n')
replace_once("src/session.ts", '      case "prompt.submit": {',
    '      case "prompt.submit": {\n'
    '        if (this.#proof?.apiKeyMode && this.#proof.apiProvider === "opencode") {\n'
    '          this.#proof.requireOwner();\n'
    '          await this.#harness.commit(tx => configureProofModel(tx, command.conversationId as ConversationId,\n'
    '            { model: { provider: "opencode", modelId: "gpt-6-luna" } }), BACKGROUND_CONTEXT);\n'
    '        }')
