import { fetchMock } from "cloudflare:test";
import { beforeEach, vi } from "vitest";

beforeEach(() => {
  // Backstop even an SDK that captured fetch before a test installed its stub.
  fetchMock.activate();
  fetchMock.disableNetConnect();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("MOCK_ONLY: outbound network disabled", { status: 401 })),
  );
});
