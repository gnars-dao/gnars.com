import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Three states for the address→FID map — issue #2.
 *
 * The bug these pin: a dead NEYNAR_API_KEY made every address resolve to
 * `null`, indistinguishable from "this person has no Farcaster", and the UI
 * printed "Farcaster: Not linked" against 1050 members. A false statement
 * about each of them, produced by a read that never happened.
 *
 * The failed-read case is the one that matters most here, so it is covered
 * from every direction a read can fail: rejected key, other non-2xx, network
 * throw, and missing key.
 */

const ADDRESS = "0xAbC0000000000000000000000000000000000001";
const LOWER = ADDRESS.toLowerCase();

async function loadModule(apiKey: string | undefined) {
  vi.resetModules();
  if (apiKey === undefined) {
    delete process.env.NEYNAR_API_KEY;
  } else {
    process.env.NEYNAR_API_KEY = apiKey;
  }
  return import("./farcaster");
}

const originalKey = process.env.NEYNAR_API_KEY;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.NEYNAR_API_KEY;
  else process.env.NEYNAR_API_KEY = originalKey;
});

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

function neynarOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function neynarErr(status: number, text = "nope"): Response {
  return { ok: false, status, text: async () => text } as unknown as Response;
}

const USER = {
  fid: 4242,
  username: "gnar",
  display_name: "Gnar",
  custody_address: LOWER,
  follower_count: 10,
  following_count: 5,
};

describe("fetchFarcasterProfilesByAddressUncached — three states", () => {
  it("found: Neynar answers with a user", async () => {
    const mod = await loadModule("valid-key");
    mockFetch(() => neynarOk({ [LOWER]: [USER] }));

    const result = await mod.fetchFarcasterProfilesByAddressUncached([ADDRESS]);

    expect(result[LOWER].status).toBe("found");
    expect(mod.lookupProfile(result[LOWER])?.fid).toBe(4242);
  });

  it("absent: Neynar answers, and has no account for the address", async () => {
    const mod = await loadModule("valid-key");
    mockFetch(() => neynarOk({ [LOWER]: [] }));

    const result = await mod.fetchFarcasterProfilesByAddressUncached([ADDRESS]);

    // We ASKED and the answer was no. This is the only case the UI may call
    // "Not linked".
    expect(result[LOWER].status).toBe("absent");
    expect(mod.lookupProfile(result[LOWER])).toBeNull();
  });

  it("unavailable: the API key is rejected (the exact production failure)", async () => {
    const mod = await loadModule("expired-key");
    mockFetch(() => neynarErr(401, '{"message":"Incorrect or missing API key"}'));

    const result = await mod.fetchFarcasterProfilesByAddressUncached([ADDRESS]);

    expect(result[LOWER].status).toBe("unavailable");
    expect(mod.lookupProfile(result[LOWER])).toBeNull();
    // The reason names the key, because "the key is dead" is the thing nobody
    // could see for as long as this rendered as "Not linked".
    expect((result[LOWER] as { reason: string }).reason).toMatch(/key/i);
  });

  it("unavailable: 403 is also the key", async () => {
    const mod = await loadModule("forbidden-key");
    mockFetch(() => neynarErr(403));
    const result = await mod.fetchFarcasterProfilesByAddressUncached([ADDRESS]);
    expect((result[LOWER] as { reason: string }).reason).toMatch(/key/i);
  });

  it("unavailable: a non-key error is reported as itself, not as the key", async () => {
    const mod = await loadModule("valid-key");
    mockFetch(() => neynarErr(500));

    const result = await mod.fetchFarcasterProfilesByAddressUncached([ADDRESS]);

    expect(result[LOWER].status).toBe("unavailable");
    expect((result[LOWER] as { reason: string }).reason).toContain("500");
    expect((result[LOWER] as { reason: string }).reason).not.toMatch(/key/i);
  });

  it("unavailable: the request throws", async () => {
    const mod = await loadModule("valid-key");
    mockFetch(() => {
      throw new Error("socket hang up");
    });

    const result = await mod.fetchFarcasterProfilesByAddressUncached([ADDRESS]);

    expect(result[LOWER].status).toBe("unavailable");
  });

  it("unavailable: no key at all — never 'absent'", async () => {
    const mod = await loadModule(undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await mod.fetchFarcasterProfilesByAddressUncached([ADDRESS]);

    expect(result[LOWER].status).toBe("unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never reports 'absent' for an address it could not ask about", async () => {
    // The regression in one line: with a broken key, NOTHING may come back as
    // absent, because absent is a claim about the person.
    const mod = await loadModule("expired-key");
    mockFetch(() => neynarErr(401));

    const result = await mod.fetchFarcasterProfilesByAddressUncached([
      ADDRESS,
      "0xBbC0000000000000000000000000000000000002",
    ]);

    expect(Object.values(result).every((r) => r.status === "unavailable")).toBe(true);
    expect(Object.values(result).some((r) => r.status === "absent")).toBe(false);
  });

  it("mixes states within one response", async () => {
    const other = "0xbbc0000000000000000000000000000000000002";
    const mod = await loadModule("valid-key");
    mockFetch(() => neynarOk({ [LOWER]: [USER], [other]: [] }));

    const result = await mod.fetchFarcasterProfilesByAddressUncached([ADDRESS, other]);

    expect(result[LOWER].status).toBe("found");
    expect(result[other].status).toBe("absent");
  });

  it("returns an empty map for an empty input without calling out", async () => {
    const mod = await loadModule("valid-key");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await mod.fetchFarcasterProfilesByAddressUncached([])).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("lookupProfile", () => {
  it("yields the profile only for 'found'", async () => {
    const mod = await loadModule("valid-key");
    expect(mod.lookupProfile({ status: "absent" })).toBeNull();
    expect(mod.lookupProfile({ status: "unavailable", reason: "x" })).toBeNull();
    expect(mod.lookupProfile(undefined)).toBeNull();
  });
});
