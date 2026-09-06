import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const { tokens, eth } = vi.hoisted(() => ({ tokens: vi.fn(), eth: vi.fn() }));
vi.mock("@/services/prices", () => ({ getTokenPricesUsd: tokens, getEthUsd: eth }));
const a = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const b = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
let caller = 0;
const request = (addresses: string) =>
  new Request(`https://gnars.com/api/prices?addresses=${addresses}`, {
    headers: { "x-vercel-forwarded-for": `prices-test-${caller++}` },
  });
const post = (body: unknown) =>
  new Request("https://gnars.com/api/prices", {
    method: "POST",
    headers: { "x-vercel-forwarded-for": `prices-test-${caller++}` },
    body: JSON.stringify(body),
  });
describe("prices request bounds", () => {
  beforeEach(() => {
    tokens.mockReset();
    eth.mockReset();
    tokens.mockResolvedValue({ [a]: 1, [b]: 2 });
  });
  it("canonicalizes valid GET and POST batches", async () => {
    expect((await GET(request(`${b},${a},${a}`))).status).toBe(200);
    expect(tokens).toHaveBeenLastCalledWith([a, b], "base");
    const response = await POST(post({ addresses: [b, a] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects malformed, excessive, and oversized input without upstream calls", async () => {
    expect((await GET(request("bad"))).status).toBe(400);
    expect((await POST(post({ addresses: Array(101).fill(a) }))).status).toBe(400);
    expect((await POST(post({ addresses: [42] }))).status).toBe(400);
    expect((await POST(post({ addresses: ["a".repeat(9000)] }))).status).toBe(413);
    expect(tokens).not.toHaveBeenCalled();
  });
  it("never caches a wholly unavailable price response", async () => {
    tokens.mockResolvedValue({ [a]: null });
    const response = await GET(request(a));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ prices: { [a]: { usd: null } } });
  });

  it("does not CDN-cache partially unresolved prices", async () => {
    tokens.mockResolvedValue({ [a]: 1, [b]: null });
    const response = await GET(request(`${a},${b}`));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
