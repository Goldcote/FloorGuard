// A demo-only build (VITE_DEMO_ONLY=1) must never leave the demo or expose a wallet connector.
import { afterEach, describe, expect, it, vi } from "vitest";

describe("demo-only build", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("stays in demo mode and refuses live", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_ENABLE_LOCAL", "");
    vi.stubEnv("VITE_DEMO_ONLY", "1");
    vi.resetModules();
    const local = await import("../src/local");
    expect(local.DEMO_ONLY).toBe(true);
    const mode = await import("../src/demo/mode");
    expect(mode.getMode()).toBe("demo");
    mode.setMode("live");
    expect(mode.getMode()).toBe("demo");
  });

  it("has no wallet connectors and no wallet discovery", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_ENABLE_LOCAL", "");
    vi.stubEnv("VITE_DEMO_ONLY", "1");
    vi.resetModules();
    const { config } = await import("../src/wagmi");
    expect(config.connectors.length).toBe(0);
  });

  it("is off in an ordinary build", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_ENABLE_LOCAL", "");
    vi.stubEnv("VITE_DEMO_ONLY", "");
    vi.resetModules();
    const local = await import("../src/local");
    expect(local.DEMO_ONLY).toBe(false);
    const { config } = await import("../src/wagmi");
    expect(config.connectors.length).toBeGreaterThan(0);
  });
});
