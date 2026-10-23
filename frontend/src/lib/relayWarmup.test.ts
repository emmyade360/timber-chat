// @vitest-environment jsdom
//
// The wake-up probe is fired before anything else and must never be able to
// break the boot it runs alongside.

import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();

vi.mock("axios", () => {
  const instance = {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return { default: { create: () => instance }, isAxiosError: () => false };
});

const { WAKE_TIMEOUT_MS, warmRelay, resetRelayWarmup } = await import("./api.js");

beforeEach(() => {
  vi.clearAllMocks();
  resetRelayWarmup();
});

describe("relay warm-up", () => {
  it("probes with the long wake budget, not the default one", async () => {
    get.mockResolvedValue({ data: {} });
    await warmRelay();
    expect(get).toHaveBeenCalledWith("/health", { timeout: WAKE_TIMEOUT_MS });
  });

  it("covers a free-tier cold start", () => {
    // The default 15s budget is shorter than the cold start it would be waiting
    // on, so the first request after a sleep could never have succeeded.
    expect(WAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
  });

  it("issues one probe however many callers ask", async () => {
    get.mockResolvedValue({ data: {} });
    await Promise.all([warmRelay(), warmRelay(), warmRelay()]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("resolves false instead of rejecting when the relay is down", async () => {
    // Nothing awaits this at boot; an unhandled rejection here would surface as
    // a console error on every offline start.
    get.mockRejectedValue(new Error("ECONNABORTED"));
    await expect(warmRelay()).resolves.toBe(false);
  });
});
