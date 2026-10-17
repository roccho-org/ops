import { beforeEach, vi } from "vitest";

beforeEach(() => {
  // The Miniflare outboundService is the network backstop. Per-test fetch stubs
  // supply only synthetic OAuth/Responses data without adding a mock framework.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("MOCK_ONLY: outbound network disabled", { status: 401 })),
  );
});
