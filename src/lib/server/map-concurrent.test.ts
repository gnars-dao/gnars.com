import { describe, expect, it, vi } from "vitest";
import { mapConcurrent } from "./map-concurrent";

describe("mapConcurrent", () => {
  it("caps uneven workloads and executes each input once in input order", async () => {
    let active = 0;
    let peak = 0;
    const inputs = Array.from({ length: 50 }, (_, index) => index);
    const visit = vi.fn(async (index: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 1 : 5));
      active--;
      return index;
    });
    expect(await mapConcurrent(inputs, visit, 15)).toEqual(inputs);
    expect(peak).toBe(15);
    expect(visit).toHaveBeenCalledTimes(50);
  });

  it("propagates failures and stops scheduling more work", async () => {
    const visit = vi.fn(async () => {
      throw new Error("upstream");
    });
    await expect(mapConcurrent([1, 2, 3], visit, 1)).rejects.toThrow("upstream");
    expect(visit).toHaveBeenCalledTimes(1);
    expect(await mapConcurrent([], visit, 2)).toEqual([]);
    await expect(mapConcurrent([1], visit, 0)).rejects.toThrow("Invalid concurrency");
  });
});
