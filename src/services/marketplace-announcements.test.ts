import { zeroAddress, zeroHash } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { announcementIdentity } from "@/lib/marketplace/announcement";
import {
  getListingOrderHash,
  SEAPORT_ADDRESS,
  type SignedListing,
} from "@/lib/marketplace/seaport";
import type { MarketplaceOffer } from "@/types/marketplace";
import {
  processMarketplaceAnnouncement,
  scheduleMarketplaceAnnouncement,
} from "./marketplace-announcements";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  after: vi.fn(),
  metadata: vi.fn(),
  community: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("pg", () => ({
  Pool: vi.fn(function () {
    return { query: mocks.query };
  }),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("./marketplace-catalogue", () => ({ getMarketplaceMetadata: mocks.metadata }));
vi.mock("./marketplace-community", () => ({ getCommunityOrder: mocks.community }));

const seller = "0x1111111111111111111111111111111111111111";
const signer = "11111111-1111-4111-8111-111111111111";
const castHash = `0x${"a".repeat(40)}`;
const listing: SignedListing = {
  parameters: {
    offerer: seller,
    zone: zeroAddress,
    zoneHash: zeroHash,
    conduitKey: zeroHash,
    counter: "0",
    salt: "1",
    orderType: 0,
    startTime: "1",
    endTime: "2000000000",
    offer: [
      {
        itemType: 2,
        token: DAO_ADDRESSES.token,
        identifierOrCriteria: "3656",
        startAmount: "1",
        endAmount: "1",
      },
    ],
    consideration: [
      {
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: "10000000000000000",
        endAmount: "10000000000000000",
        recipient: seller,
      },
    ],
  },
  signature: "0xabcd",
};
const offer: MarketplaceOffer = {
  id: "test",
  source: "gnars",
  protocolAddress: SEAPORT_ADDRESS,
  orderHash: getListingOrderHash(listing.parameters),
  seller,
  priceWei: "10000000000000000",
  currency: "ETH",
  expiresAt: 2000000000,
};
type TestJob = {
  chain_id: number;
  protocol_address: string;
  order_hash: string;
  event: string;
  idem: string;
  signer_uuid: string;
  payload: unknown;
  status: string;
  attempts: number;
  lease_token: string | null;
  uncertain_since: number | null;
  leaseUntil: number;
  nextAttempt: number;
  last_error_code?: string;
  cast_hash?: string;
};
let job: TestJob | undefined;
let callbacks: (() => Promise<void>)[];
const signerResponse = (extra = {}) =>
  Response.json({ signer_uuid: signer, status: "approved", fid: 3757, ...extra });
const posted = () =>
  Response.json({ success: true, cast: { hash: castHash, author: { fid: 3757 } } });
const postCalls = () => mocks.fetch.mock.calls.filter(([, options]) => options.method === "POST");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T23:00:00Z"));
  vi.stubEnv("MARKETPLACE_DATABASE_URL", "postgres://localhost/announcement-test-only");
  vi.stubEnv("MARKETPLACE_FARCASTER_ANNOUNCEMENTS_ENABLED", "true");
  vi.stubEnv("NEYNAR_API_KEY", "test-primary-key");
  vi.stubEnv("NEYNAR_API_KEY_FALLBACK", "");
  vi.stubEnv("NEYNAR_SIGNER_UUID", signer);
  vi.stubGlobal("fetch", mocks.fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  job = undefined;
  callbacks = [];
  mocks.after.mockImplementation((callback) => {
    callbacks.push(callback);
  });
  mocks.metadata.mockResolvedValue([{ tokenId: "3656", name: "Gnar #3656" }]);
  mocks.fetch.mockImplementation(async (url) =>
    String(url).includes("/signer/") ? signerResponse() : posted(),
  );
  mocks.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("SELECT *")) return { rows: job ? [{ ...job }] : [], rowCount: job ? 1 : 0 };
    if (sql.startsWith("INSERT INTO")) {
      job ??= {
        chain_id: 8453,
        protocol_address: String(values[0]),
        order_hash: String(values[1]),
        event: String(values[2]),
        idem: String(values[3]),
        signer_uuid: String(values[4]),
        payload: JSON.parse(String(values[5])),
        status: "queued",
        attempts: 0,
        lease_token: null,
        uncertain_since: null,
        leaseUntil: 0,
        nextAttempt: 0,
      };
      return { rows: [], rowCount: 1 };
    }
    if (!job) return { rows: [], rowCount: 0 };
    if (sql.includes("status = 'manual_review'")) {
      if (
        job.status !== "sent" &&
        job.leaseUntil <= Date.now() &&
        ((job.uncertain_since !== null && job.uncertain_since < Date.now() - Number(values[3])) ||
          job.attempts >= Number(values[4]))
      ) {
        job.status = "manual_review";
        job.last_error_code = "IDEMPOTENCY_WINDOW_EXPIRED";
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("status = 'sending'")) {
      if (
        ["sent", "manual_review"].includes(job.status) ||
        job.leaseUntil > Date.now() ||
        job.nextAttempt > Date.now()
      )
        return { rows: [], rowCount: 0 };
      job.status = "sending";
      job.lease_token = String(values[3]);
      job.leaseUntil = Date.now() + Number(values[4]) * 1000;
      job.attempts++;
      return { rows: [{ ...job }], rowCount: 1 };
    }
    if (sql.includes("first_post_at =")) {
      if (job.lease_token !== values[3] || job.leaseUntil <= Date.now())
        return { rows: [], rowCount: 0 };
      job.uncertain_since ??= Date.now();
      return { rows: [{ idem: job.idem }], rowCount: 1 };
    }
    if (sql.includes("status = 'sent'")) {
      if (job.lease_token !== values[3]) return { rows: [], rowCount: 0 };
      job.status = "sent";
      job.cast_hash = String(values[4]);
      job.lease_token = null;
      job.leaseUntil = 0;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("status = $5")) {
      if (job.lease_token !== values[3]) return { rows: [], rowCount: 0 };
      job.status = String(values[4]);
      job.last_error_code = String(values[5]);
      job.nextAttempt = Date.now() + Number(values[6]);
      if (!values[7]) job.uncertain_since = null;
      job.lease_token = null;
      job.leaseUntil = 0;
      return { rows: [], rowCount: 1 };
    }
    throw new Error("Unrecognized test query");
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function runBackground() {
  const pending = Promise.all(callbacks.map((callback) => callback()));
  await vi.runAllTimersAsync();
  await pending;
}

describe("durable marketplace announcements", () => {
  it("stores a frozen job before scheduling; duplicate triggers cause one POST", async () => {
    await scheduleMarketplaceAnnouncement(offer, listing);
    expect(job?.status).toBe("queued");
    expect(mocks.fetch).not.toHaveBeenCalled();
    await scheduleMarketplaceAnnouncement(offer, listing);
    await runBackground();
    expect(postCalls()).toHaveLength(1);
    expect(job).toMatchObject({ status: "sent", cast_hash: castHash, attempts: 1 });
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
    const body = JSON.parse(postCalls()[0][1].body);
    expect(body).toMatchObject({ signer_uuid: signer, channel_id: "gnars", idem: job!.idem });
    expect(body.embeds[0].url).toContain("https://gnars.com/marketplace?nft=3656");
  });
  it("protects concurrent workers with an atomic lease", async () => {
    await scheduleMarketplaceAnnouncement(offer, listing);
    await Promise.all([
      processMarketplaceAnnouncement(announcementIdentity(offer, listing)),
      processMarketplaceAnnouncement(announcementIdentity(offer, listing)),
    ]);
    expect(postCalls()).toHaveLength(1);
    expect(job?.attempts).toBe(1);
  });
  it("retries a timeout with identical frozen body and idem", async () => {
    let posts = 0;
    mocks.fetch.mockImplementation(async (url) => {
      if (String(url).includes("/signer/")) return signerResponse();
      if (posts++ === 0) throw new Error("timeout");
      return posted();
    });
    await scheduleMarketplaceAnnouncement(offer, listing);
    await runBackground();
    expect(postCalls()).toHaveLength(2);
    expect(postCalls()[0][1].body).toBe(postCalls()[1][1].body);
    expect(job?.status).toBe("sent");
  });
  it("preserves queued work when after registration fails, then retries accepted publication", async () => {
    mocks.after.mockImplementationOnce(() => {
      throw new Error("after unavailable");
    });
    await expect(scheduleMarketplaceAnnouncement(offer, listing)).resolves.toBeUndefined();
    expect(job?.status).toBe("queued");
    await scheduleMarketplaceAnnouncement(offer, listing);
    await runBackground();
    expect(postCalls()).toHaveLength(1);
  });
  it("caps ambiguous provider retries and preserves the same idempotency key", async () => {
    mocks.fetch.mockImplementation(async (url) =>
      String(url).includes("/signer/")
        ? signerResponse()
        : new Response("unavailable", { status: 503 }),
    );
    await scheduleMarketplaceAnnouncement(offer, listing);
    await runBackground();
    expect(postCalls()).toHaveLength(2);
    expect(postCalls()[0][1].body).toBe(postCalls()[1][1].body);
    expect(job).toMatchObject({
      status: "ambiguous",
      last_error_code: "NEYNAR_UNAVAILABLE",
      attempts: 2,
    });
    expect(job!.uncertain_since).not.toBeNull();
  });
  it("reuses the frozen payload when database confirmation fails after a successful POST", async () => {
    const query = mocks.query.getMockImplementation()!;
    let failOnce = true;
    mocks.query.mockImplementation(async (sql, values) => {
      if (String(sql).includes("status = 'sent'") && failOnce) {
        failOnce = false;
        throw new Error("database acknowledgement lost");
      }
      return query(sql, values);
    });
    await scheduleMarketplaceAnnouncement(offer, listing);
    await runBackground();
    expect(postCalls()).toHaveLength(2);
    expect(postCalls()[0][1].body).toBe(postCalls()[1][1].body);
    expect(job).toMatchObject({ status: "sent", cast_hash: castHash });
  });
  it.each([401, 403])(
    "records distinct credential/permission block %s without rejecting the listing",
    async (status) => {
      mocks.fetch.mockResolvedValue(new Response("provider secret", { status }));
      await expect(scheduleMarketplaceAnnouncement(offer, listing)).resolves.toBeUndefined();
      await runBackground();
      expect(job).toMatchObject({
        status: "blocked",
        last_error_code: status === 401 ? "NEYNAR_UNAUTHORIZED" : "NEYNAR_FORBIDDEN",
      });
      expect(postCalls()).toHaveLength(0);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("provider secret");
    },
  );
  it("honors long429 cooldown without sleeping or rejecting listing", async () => {
    mocks.fetch.mockImplementation(async (url) =>
      String(url).includes("/signer/")
        ? signerResponse()
        : new Response("limited", { status: 429, headers: { "retry-after": "60" } }),
    );
    await scheduleMarketplaceAnnouncement(offer, listing);
    await runBackground();
    expect(job).toMatchObject({
      status: "retryable",
      last_error_code: "NEYNAR_RATE_LIMITED",
      uncertain_since: null,
    });
    expect(job!.nextAttempt).toBeGreaterThan(Date.now());
    expect(postCalls()).toHaveLength(1);
  });
  it("uses fallback only after primary signer401 and independently validates its signer", async () => {
    vi.stubEnv("NEYNAR_API_KEY_FALLBACK", "test-fallback-key");
    mocks.fetch.mockImplementation(async (url, options) =>
      String(url).includes("/signer/") && options.headers["x-api-key"] === "test-primary-key"
        ? new Response("invalid", { status: 401 })
        : String(url).includes("/signer/")
          ? signerResponse()
          : posted(),
    );
    await scheduleMarketplaceAnnouncement(offer, listing);
    await runBackground();
    expect(postCalls()[0][1].headers["x-api-key"]).toBe("test-fallback-key");
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logs).toContain("NEYNAR_PRIMARY_CREDENTIALS_UNAUTHORIZED");
    expect(logs).toContain("NEYNAR_VERIFIED_FALLBACK_SELECTED");
    expect(logs).not.toContain("test-primary-key");
    expect(logs).not.toContain("test-fallback-key");
  });
  it("does not blindly switch keys after a POST401", async () => {
    vi.stubEnv("NEYNAR_API_KEY_FALLBACK", "test-fallback-key");
    mocks.fetch.mockImplementation(async (url) =>
      String(url).includes("/signer/")
        ? signerResponse()
        : new Response("invalid", { status: 401 }),
    );
    await scheduleMarketplaceAnnouncement(offer, listing);
    await runBackground();
    expect(postCalls()).toHaveLength(1);
    expect(
      mocks.fetch.mock.calls.some(
        ([, options]) => options.headers["x-api-key"] === "test-fallback-key",
      ),
    ).toBe(false);
    expect(job?.status).toBe("blocked");
  });
  it("rejects a fallback key whose signer belongs to another account", async () => {
    vi.stubEnv("NEYNAR_API_KEY_FALLBACK", "test-fallback-key");
    mocks.fetch.mockImplementation(async (_url, options) =>
      options.headers["x-api-key"] === "test-primary-key"
        ? new Response("invalid", { status: 401 })
        : signerResponse({ fid: 99 }),
    );
    await scheduleMarketplaceAnnouncement(offer, listing);
    await runBackground();
    expect(postCalls()).toHaveLength(0);
    expect(job).toMatchObject({
      status: "blocked",
      last_error_code: "SIGNER_NOT_APPROVED_FOR_GNARS",
    });
  });
  it.each([{ fid: 1 }, { status: "pending_approval" }, { permissions: ["READ_ONLY"] }])(
    "blocks unsuitable signer %j before posting",
    async (change) => {
      mocks.fetch.mockResolvedValue(signerResponse(change));
      await scheduleMarketplaceAnnouncement(offer, listing);
      await runBackground();
      expect(postCalls()).toHaveLength(0);
      expect(job?.status).toBe("blocked");
    },
  );
  it("never considers wrong-author or malformed success confirmed", async () => {
    mocks.fetch.mockImplementation(async (url) =>
      String(url).includes("/signer/")
        ? signerResponse()
        : Response.json({ success: true, cast: { hash: castHash, author: { fid: 99 } } }),
    );
    await scheduleMarketplaceAnnouncement(offer, listing);
    await runBackground();
    expect(job?.status).toBe("manual_review");
    expect(postCalls()).toHaveLength(1);
  });
  it("does not retry an old ambiguous job outside the short idempotency window", async () => {
    await scheduleMarketplaceAnnouncement(offer, listing);
    job!.uncertain_since = Date.now() - 6 * 60 * 1000;
    job!.status = "ambiguous";
    await runBackground();
    expect(job?.status).toBe("manual_review");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("keeps metadata optional and frozen across retries", async () => {
    mocks.metadata.mockRejectedValue(new Error("metadata unavailable"));
    await scheduleMarketplaceAnnouncement(offer, listing);
    expect(JSON.stringify(job?.payload)).toContain("Gnar #3656");
    const frozen = JSON.stringify(job?.payload);
    mocks.metadata.mockResolvedValue([{ tokenId: "3656", name: "Changed" }]);
    await scheduleMarketplaceAnnouncement(offer, listing);
    expect(JSON.stringify(job?.payload)).toBe(frozen);
  });
  it("fails closed when disabled, misconfigured, hidden or expired", async () => {
    vi.stubEnv("MARKETPLACE_FARCASTER_ANNOUNCEMENTS_ENABLED", "false");
    await scheduleMarketplaceAnnouncement(offer, listing);
    expect(mocks.query).not.toHaveBeenCalled();
    vi.stubEnv("MARKETPLACE_FARCASTER_ANNOUNCEMENTS_ENABLED", "true");
    await scheduleMarketplaceAnnouncement({ ...offer, expiresAt: 1 }, listing);
    await scheduleMarketplaceAnnouncement(
      { ...offer, moderation: { hidden: true, revision: 1 } },
      listing,
    );
    vi.stubEnv("NEYNAR_SIGNER_UUID", "invalid");
    await scheduleMarketplaceAnnouncement(offer, listing);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
