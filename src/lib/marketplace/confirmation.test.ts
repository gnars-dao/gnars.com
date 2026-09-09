import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmationAttemptKey, createConfirmationRecovery } from "./confirmation";

describe("marketplace confirmation recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(check = vi.fn(async () => {})) {
    let identity: string | null = "attempt:hash";
    const changed = vi.fn();
    const controller = createConfirmationRecovery({ attempt: () => identity, check, changed });
    return {
      controller,
      check,
      changed,
      setIdentity: (value: string | null) => (identity = value),
    };
  }

  it("excludes unknown sends without hash and completed or failed receipts", () => {
    const attempt = { id: "a", phase: "unknown", transactionIntent: {} };
    expect(confirmationAttemptKey(attempt)).toBeNull();
    expect(confirmationAttemptKey({ ...attempt, txHash: "0xAB" })).toBe("a:0xab");
    expect(confirmationAttemptKey({ ...attempt, txHash: "0xAB", phase: "complete" })).toBeNull();
    expect(
      confirmationAttemptKey({ ...attempt, txHash: "0xAB", transactionFailed: true }),
    ).toBeNull();
    expect(
      confirmationAttemptKey({
        ...attempt,
        txHash: "0xAB",
        error: { code: "TRANSACTION_MISMATCH", retryable: false },
      }),
    ).toBeNull();
    expect(
      confirmationAttemptKey({ ...attempt, txHash: "0xAB", transactionIntent: undefined }),
    ).toBeNull();
  });

  it("shares a single loop across mounts and stops after the last unmount", async () => {
    const { controller, check } = setup();
    const first = controller.retain();
    const second = controller.retain();
    await vi.advanceTimersByTimeAsync(1500);
    expect(check).toHaveBeenCalledTimes(1);
    first();
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(2);
    second();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds retries and does not reset the budget on rerender or remount", async () => {
    const { controller, check, changed } = setup();
    const release = controller.retain();
    await vi.advanceTimersByTimeAsync(120_000);
    const calls = check.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(15);
    expect(changed).toHaveBeenLastCalledWith(false);
    release();
    controller.retain();
    controller.refresh();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses hidden tabs and resumes only within the original budget", async () => {
    const { controller, check } = setup();
    controller.retain();
    controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).not.toHaveBeenCalled();
    controller.setVisible(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(check).toHaveBeenCalledTimes(1);
    controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(120_000);
    controller.setVisible(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("stops on completion and gives a new transaction its own budget", async () => {
    const { controller, check, setIdentity } = setup();
    controller.retain();
    await vi.advanceTimersByTimeAsync(1500);
    setIdentity(null);
    controller.refresh();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).toHaveBeenCalledTimes(1);
    setIdentity("new:hash");
    controller.refresh();
    await vi.advanceTimersByTimeAsync(1500);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does not overlap slow checks and clears timers on unmount", async () => {
    let resolve!: () => void;
    const check = vi.fn(() => new Promise<void>((done) => (resolve = done)));
    const { controller } = setup(check);
    const release = controller.retain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(1);
    release();
    resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains unexpected check rejection and retries without overlapping", async () => {
    const check = vi.fn(async () => {
      throw new Error("RPC unavailable");
    });
    const { controller } = setup(check);
    const release = controller.retain();
    await vi.advanceTimersByTimeAsync(4500);
    expect(check).toHaveBeenCalledTimes(2);
    release();
    expect(vi.getTimerCount()).toBe(0);
  });
});
