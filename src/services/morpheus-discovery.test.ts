import { keccak256, toHex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverMorpheusUsers } from "./morpheus-discovery";

const pool = "0x1111111111111111111111111111111111111111";
const referrer = "0x2222222222222222222222222222222222222222";
const user = "0x3333333333333333333333333333333333333333";
const log = (block = "0x1") => ({
  address: pool,
  blockNumber: block,
  topics: [
    keccak256(toHex("UserReferred(uint256,address,address,uint256)")),
    `0x${"0".repeat(64)}`,
    `0x${user.slice(2).padStart(64, "0")}`,
    `0x${referrer.slice(2).padStart(64, "0")}`,
  ],
});
const response = (result: unknown, status = "1", message = "OK") =>
  new Response(JSON.stringify({ status, message, result }));
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ETHERSCAN_API_KEY", "");
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Morpheus full-history discovery", () => {
  it("works without a key, starts at genesis and deduplicates event users", async () => {
    fetchMock.mockResolvedValue(response([log(), log("0x2")]));
    expect(await discoverMorpheusUsers(pool, referrer)).toEqual({ users: [user], resolved: true });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin).toBe("https://eth.blockscout.com");
    expect(url.searchParams.get("fromBlock")).toBe("0");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  });

  it("accepts explicit no logs, but not an invalid-key error, as complete empty", async () => {
    fetchMock.mockResolvedValueOnce(response([], "0", "No logs found"));
    expect(await discoverMorpheusUsers(pool, referrer)).toEqual({ users: [], resolved: true });
    fetchMock.mockResolvedValueOnce(response("Invalid API Key", "0", "NOTOK"));
    expect(await discoverMorpheusUsers(pool, referrer)).toEqual({ users: [], resolved: false });
  });

  it("falls back after upstream failure and does not turn a bad mainnet key into zero", async () => {
    vi.stubEnv("ETHERSCAN_API_KEY", "invalid-test-key");
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    fetchMock.mockResolvedValueOnce(response("Invalid API Key", "0", "NOTOK"));
    expect(await discoverMorpheusUsers(pool, referrer)).toEqual({ users: [], resolved: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("chainid")).toBe("1");
  });

  it("uses overlapping block boundaries instead of silently truncating the first 1000", async () => {
    fetchMock.mockResolvedValueOnce(response(Array.from({ length: 1000 }, () => log("0x64"))));
    fetchMock.mockResolvedValueOnce(response([log("0x64"), log("0x65")]));
    expect(await discoverMorpheusUsers(pool, referrer)).toEqual({ users: [user], resolved: true });
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("fromBlock")).toBe("100");
  });

  it("marks a saturated single block incomplete and preserves known candidates", async () => {
    fetchMock.mockImplementation(async () => response(Array.from({ length: 1000 }, () => log())));
    expect(await discoverMorpheusUsers(pool, referrer)).toEqual({ users: [user], resolved: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps primary candidates when a complete but lagging fallback returns none", async () => {
    vi.stubEnv("ETHERSCAN_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(response(Array.from({ length: 1000 }, () => log())));
    fetchMock.mockRejectedValueOnce(new Error("second page unavailable"));
    fetchMock.mockResolvedValueOnce(response([], "0", "No records found"));
    expect(await discoverMorpheusUsers(pool, referrer)).toEqual({ users: [user], resolved: true });
  });

  it("rejects malformed or unrelated logs and HTTP errors", async () => {
    fetchMock.mockResolvedValueOnce(response([{ ...log(), topics: [] }]));
    expect((await discoverMorpheusUsers(pool, referrer)).resolved).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    expect((await discoverMorpheusUsers(pool, referrer)).resolved).toBe(false);
  });

  it("bounds history work to four pages while keeping discovered users", async () => {
    let block = 0;
    fetchMock.mockImplementation(async () =>
      response(Array.from({ length: 1000 }, () => log(`0x${(++block).toString(16)}`))),
    );
    expect(await discoverMorpheusUsers(pool, referrer)).toEqual({ users: [user], resolved: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
