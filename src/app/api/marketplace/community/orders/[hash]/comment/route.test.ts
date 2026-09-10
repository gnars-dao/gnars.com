import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { communityCommentEditPayload } from "@/lib/marketplace/community-comment";
import { RequestSecurityError } from "@/lib/server/request-security";
import { GET, PATCH } from "./route";

const mocks = vi.hoisted(() => ({
  edit: vi.fn(),
  get: vi.fn(),
  rate: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidate }));
vi.mock("@/services/marketplace-community", () => ({
  COMMUNITY_CACHE_TAG: "marketplace-community",
  editCommunityOrderComment: mocks.edit,
  getCommunityOrderComment: mocks.get,
}));
vi.mock("@/lib/server/request-security", async (original) => ({
  ...(await original<typeof import("@/lib/server/request-security")>()),
  enforceRateLimit: mocks.rate,
}));

const hash = `0x${"a".repeat(64)}` as const;
const url = `http://localhost/api/marketplace/community/orders/${hash}/comment`;
const context = { params: Promise.resolve({ hash }) };
function body() {
  return {
    ...communityCommentEditPayload(hash, "Updated", 0),
    authorization: { signature: "0x12" },
  };
}
function patch(payload: unknown = body()) {
  return new Request(url, { method: "PATCH", body: JSON.stringify(payload) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", "0x3333333333333333333333333333333333333333");
  mocks.rate.mockResolvedValue(undefined);
  mocks.edit.mockResolvedValue({
    orderHash: hash,
    listingComment: "Updated",
    listingCommentRevision: 1,
  });
  mocks.get.mockResolvedValue({
    orderHash: hash,
    listingComment: "Current",
    listingCommentRevision: 2,
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("community comment route", () => {
  it("passes the signed edit to the service and invalidates the public feed", async () => {
    const response = await PATCH(patch(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      offer: { orderHash: hash, listingComment: "Updated", listingCommentRevision: 1 },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.edit).toHaveBeenCalledWith(body());
    expect(mocks.revalidate).toHaveBeenCalledWith("marketplace-community", { expire: 0 });
  });
  it("supports clearing the comment explicitly with null", async () => {
    await PATCH(patch({ ...body(), listingComment: null }), context);
    expect(mocks.edit).toHaveBeenCalledWith(expect.objectContaining({ listingComment: null }));
  });
  it.each([
    null,
    {},
    { listingComment: "" },
    { listingComment: "x".repeat(281) },
    { expectedRevision: -1 },
    { chainId: 1 },
    { orderHash: `0x${"b".repeat(64)}` },
    { priceWei: "123" },
  ])("rejects malformed or tampered bodies %j", async (change) => {
    const payload =
      change === null ? null : Object.keys(change).length ? { ...body(), ...change } : change;
    const response = await PATCH(patch(payload), context);
    expect(response.status).toBe(400);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("rejects oversized body before service execution", async () => {
    const response = await PATCH(
      patch({ ...body(), authorization: { signature: "x".repeat(23000) } }),
      context,
    );
    expect(response.status).toBe(413);
    expect(mocks.edit).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409, 429, 503])(
    "preserves service denial %s without feed invalidation",
    async (status) => {
      mocks.edit.mockRejectedValue(new RequestSecurityError(status, "Unable to edit"));
      const response = await PATCH(patch(), context);
      expect(response.status).toBe(status);
      expect(mocks.revalidate).not.toHaveBeenCalled();
    },
  );
  it("hides unexpected database/provider details", async () => {
    mocks.edit.mockRejectedValue(new Error("postgres://private-password@db.example"));
    const response = await PATCH(patch(), context);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).not.toContain("private-password");
  });
  it("returns latest safe offer for lost-response recovery without caching", async () => {
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      offer: { orderHash: hash, listingComment: "Current", listingCommentRevision: 2 },
    });
    expect(mocks.get).toHaveBeenCalledWith(hash);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("denies reading removed/inactive orders and invalid path hashes", async () => {
    mocks.get.mockRejectedValueOnce(new RequestSecurityError(403, "Hidden listing"));
    expect((await GET(new Request(url), context)).status).toBe(403);
    expect((await GET(new Request(url), { params: Promise.resolve({ hash: "bad" }) })).status).toBe(
      400,
    );
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});
