import { describe, expect, it, vi } from "vitest";
import {
  parseRetryAfter,
  run,
  subgraphGateConfig,
  SubgraphTransientError,
} from "@/lib/subgraph-gate";

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("reads an HTTP date as a delta from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT")).toBe(5000);
    vi.useRealTimers();
  });

  it("never returns a negative wait for a date in the past", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT")).toBe(0);
    vi.useRealTimers();
  });

  it("returns undefined when the header is absent or unparseable", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("run", () => {
  it("returns the value without retrying when the call succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(run(fn, "test")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and resolves once the endpoint recovers", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new SubgraphTransientError("Subgraph error: 429", { status: 429, retryAfterMs: 0 }),
      )
      .mockResolvedValue("ok");
    await expect(run(fn, "test")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries the SDK's unstructured 429 message too", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("GraphQL Error (Code: 429): {}"))
      .mockResolvedValue("ok");
    await expect(run(fn, "test")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient failure", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Subgraph query failed: bad field"));
    await expect(run(fn, "test")).rejects.toThrow("bad field");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates the failure once the ladder is exhausted — never a silent zero", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new SubgraphTransientError("429", { status: 429, retryAfterMs: 0 }));
    // The full ladder is ~15s of real backoff, so run it on fake timers rather
    // than making every `pnpm test` wait it out.
    vi.useFakeTimers();
    try {
      const settled = expect(run(fn, "test")).rejects.toThrow("429");
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
    expect(fn).toHaveBeenCalledTimes(subgraphGateConfig.maxAttempts);
  });

  it("never lets more than maxConcurrency calls run at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return true;
    };

    await Promise.all(
      Array.from({ length: subgraphGateConfig.maxConcurrency * 3 }, () => run(task, "test")),
    );

    expect(peak).toBeLessThanOrEqual(subgraphGateConfig.maxConcurrency);
  });

  it("releases its slot when a call throws, so the gate cannot deadlock", async () => {
    const failing = Array.from({ length: subgraphGateConfig.maxConcurrency }, () =>
      run(() => Promise.reject(new Error("hard failure")), "test").catch(() => "handled"),
    );
    await Promise.all(failing);
    await expect(run(() => Promise.resolve("still open"), "test")).resolves.toBe("still open");
  });
});
