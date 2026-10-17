import { beforeEach, vi } from "vitest";

// The main Worker and its DOs share this test isolate. No real OAuth/API request
// is permitted in this stage. Individual tests replace this with explicit mocks.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("MOCK_ONLY: outbound network disabled", { status: 401 })),
  );
});
