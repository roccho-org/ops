import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Build-time only: bundle the unchanged OAuth module from the frozen install.
const aiDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
export const oauthAlias = {
  "pi-proof-openai-oauth": join(aiDist, "auth/oauth/openai-chatgpt.js"),
};
