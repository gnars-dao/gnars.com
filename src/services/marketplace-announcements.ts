import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { Pool } from "pg";
import { z } from "zod";
import {
  ANNOUNCEMENT_AMBIGUITY_MS,
  ANNOUNCEMENT_FID,
  announcementIdentity,
  announcementPayloadSchema,
  announcementRetryDelay,
  buildAnnouncementPayload,
  type AnnouncementIdentity,
} from "@/lib/marketplace/announcement";
import { readLimitedResponse } from "@/lib/read-limited-response";
import { marketplaceDatabaseConnection } from "@/lib/server/marketplace-database";
import type { MarketplaceOffer } from "@/types/marketplace";
import { getMarketplaceMetadata } from "./marketplace-catalogue";
import { getCommunityOrder } from "./marketplace-community";

const API = "https://api.neynar.com/v2/farcaster";
const LEASE_SECONDS = 45;
const MAX_ATTEMPTS = 10;
let pool: Pool | undefined;

type Job = {
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
  uncertain_since: Date | string | null;
};

function database() {
  const connectionString =
    process.env.MARKETPLACE_DATABASE_URL ||
    process.env.ROUNDS_DATABASE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Announcement database is not configured");
  return (pool ??= new Pool({
    ...marketplaceDatabaseConnection(connectionString, process.env.MARKETPLACE_DATABASE_SSL_CA),
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
    query_timeout: 6000,
  }));
}

function config() {
  if (process.env.MARKETPLACE_FARCASTER_ANNOUNCEMENTS_ENABLED !== "true") return null;
  const key = process.env.NEYNAR_API_KEY;
  const signer = z.string().uuid().safeParse(process.env.NEYNAR_SIGNER_UUID);
  if (!key || !signer.success) throw new Error("Announcement signer is not configured");
  return { key, fallbackKey: process.env.NEYNAR_API_KEY_FALLBACK, signer: signer.data };
}

function audit(
  code: string,
  identity?: Pick<AnnouncementIdentity, "orderHash" | "protocolAddress">,
) {
  console.error("[marketplace-announcement]", {
    code,
    orderHash: identity?.orderHash,
    protocolAddress: identity?.protocolAddress,
  });
}

class ProviderFailure extends Error {
  constructor(
    public state: "blocked" | "retryable" | "ambiguous" | "manual_review",
    public code: string,
    public delay = 1000,
  ) {
    super(code);
  }
}

async function providerResponse(response: Response, posting: boolean) {
  if (response.ok) return JSON.parse(await readLimitedResponse(response, 128 * 1024)) as unknown;
  if (response.status === 401) throw new ProviderFailure("blocked", "NEYNAR_UNAUTHORIZED", 60000);
  if (response.status === 403) throw new ProviderFailure("blocked", "NEYNAR_FORBIDDEN", 60000);
  if (response.status === 429)
    throw new ProviderFailure(
      "retryable",
      "NEYNAR_RATE_LIMITED",
      announcementRetryDelay(response.headers.get("retry-after")),
    );
  if (response.status >= 500)
    throw new ProviderFailure(posting ? "ambiguous" : "retryable", "NEYNAR_UNAVAILABLE");
  throw new ProviderFailure("blocked", "NEYNAR_REJECTED", 60000);
}

async function verifySigner(key: string, signer: string) {
  let body: unknown;
  try {
    body = await providerResponse(
      await fetch(`${API}/signer/?signer_uuid=${encodeURIComponent(signer)}`, {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(6000),
        redirect: "error",
        cache: "no-store",
      }),
      false,
    );
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure("retryable", "SIGNER_LOOKUP_UNAVAILABLE");
  }
  const verified = z
    .object({
      signer_uuid: z.string().uuid(),
      status: z.literal("approved"),
      fid: z.literal(ANNOUNCEMENT_FID),
      permissions: z.array(z.string()).optional(),
    })
    .safeParse(body);
  if (
    !verified.success ||
    verified.data.signer_uuid !== signer ||
    (verified.data.permissions &&
      !verified.data.permissions.some(
        (permission) => permission === "WRITE_ALL" || permission === "PUBLISH_CAST",
      ))
  )
    throw new ProviderFailure("blocked", "SIGNER_NOT_APPROVED_FOR_GNARS", 60000);
}

async function approvedApiKey(
  settings: NonNullable<ReturnType<typeof config>>,
  identity: AnnouncementIdentity,
) {
  try {
    await verifySigner(settings.key, settings.signer);
    return settings.key;
  } catch (error) {
    if (
      !(error instanceof ProviderFailure) ||
      error.code !== "NEYNAR_UNAUTHORIZED" ||
      !settings.fallbackKey ||
      settings.fallbackKey === settings.key
    )
      throw error;
    audit("NEYNAR_PRIMARY_CREDENTIALS_UNAUTHORIZED", identity);
    await verifySigner(settings.fallbackKey, settings.signer);
    audit("NEYNAR_VERIFIED_FALLBACK_SELECTED", identity);
    return settings.fallbackKey;
  }
}

async function metadataName(offer: MarketplaceOffer, tokenId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = offer.collectionAddress
      ? getCommunityOrder(offer.orderHash).then(
          ({ row }) => z.object({ name: z.string() }).parse(row.metadata).name,
        )
      : getMarketplaceMetadata([tokenId]).then(
          (items) => items.find((item) => item.tokenId === tokenId)?.name,
        );
    return await Promise.race([
      lookup.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 2000);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function enqueue(offer: MarketplaceOffer, listing: unknown, signer: string) {
  if (offer.moderation?.hidden || offer.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  const identity = announcementIdentity(offer, listing);
  const keys = [identity.protocolAddress, identity.orderHash, identity.event];
  const existing = await database().query<Job>(
    "SELECT * FROM public.marketplace_announcements WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2 AND event = $3",
    keys,
  );
  if (!existing.rows[0]) {
    const payload = buildAnnouncementPayload(
      identity,
      offer,
      await metadataName(offer, identity.tokenId),
    );
    await database().query(
      "INSERT INTO public.marketplace_announcements (chain_id, protocol_address, order_hash, event, idem, signer_uuid, payload) VALUES (8453, $1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (chain_id, protocol_address, order_hash, event) DO NOTHING",
      [...keys, identity.idem, signer, JSON.stringify(payload)],
    );
  }
  return identity;
}

async function claim(identity: AnnouncementIdentity) {
  const keys = [identity.protocolAddress, identity.orderHash, identity.event];
  await database().query(
    "UPDATE public.marketplace_announcements SET status = 'manual_review', last_error_code = 'IDEMPOTENCY_WINDOW_EXPIRED', lease_token = NULL, lease_until = NULL, updated_at = NOW() WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2 AND event = $3 AND status NOT IN ('sent', 'manual_review') AND (lease_until IS NULL OR lease_until < NOW()) AND (uncertain_since < NOW() - ($4 * INTERVAL '1 millisecond') OR attempts >= $5)",
    [...keys, ANNOUNCEMENT_AMBIGUITY_MS, MAX_ATTEMPTS],
  );
  const result = await database().query<Job>(
    "UPDATE public.marketplace_announcements SET status = 'sending', lease_token = $4, lease_until = NOW() + ($5 * INTERVAL '1 second'), attempts = attempts + 1, updated_at = NOW() WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2 AND event = $3 AND status IN ('queued', 'sending', 'retryable', 'ambiguous', 'blocked') AND (lease_until IS NULL OR lease_until < NOW()) AND next_attempt_at <= NOW() AND attempts < $6 RETURNING *",
    [...keys, randomUUID(), LEASE_SECONDS, MAX_ATTEMPTS],
  );
  return result.rows[0] ?? null;
}

async function recordFailure(identity: AnnouncementIdentity, job: Job, failure: ProviderFailure) {
  await database().query(
    "UPDATE public.marketplace_announcements SET status = $5, last_error_code = $6, next_attempt_at = NOW() + ($7 * INTERVAL '1 millisecond'), uncertain_since = CASE WHEN $8 THEN uncertain_since ELSE NULL END, lease_token = NULL, lease_until = NULL, updated_at = NOW() WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2 AND event = $3 AND lease_token = $4",
    [
      identity.protocolAddress,
      identity.orderHash,
      identity.event,
      job.lease_token,
      failure.state,
      failure.code,
      failure.delay,
      failure.state === "ambiguous" ||
        failure.state === "manual_review" ||
        job.uncertain_since !== null,
    ],
  );
  audit(failure.code, identity);
}

export async function processMarketplaceAnnouncement(identity: AnnouncementIdentity) {
  const settings = config();
  if (!settings) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const job = await claim(identity);
    if (!job) return;
    let posting = false;
    try {
      if (job.signer_uuid !== settings.signer || job.idem !== identity.idem)
        throw new ProviderFailure("blocked", "ANNOUNCEMENT_CONFIGURATION_CHANGED", 60000);
      const payload = announcementPayloadSchema.parse(job.payload);
      if (payload.idem !== job.idem)
        throw new ProviderFailure("manual_review", "ANNOUNCEMENT_PAYLOAD_MISMATCH");
      const apiKey = await approvedApiKey(settings, identity);
      const started = await database().query(
        "UPDATE public.marketplace_announcements SET first_post_at = COALESCE(first_post_at, NOW()), uncertain_since = COALESCE(uncertain_since, NOW()), updated_at = NOW() WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2 AND event = $3 AND lease_token = $4 AND lease_until > NOW() RETURNING idem",
        [identity.protocolAddress, identity.orderHash, identity.event, job.lease_token],
      );
      if (started.rowCount !== 1) return;
      posting = true;
      const body = await providerResponse(
        await fetch(`${API}/cast/`, {
          method: "POST",
          headers: { "x-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({ ...payload, signer_uuid: job.signer_uuid }),
          signal: AbortSignal.timeout(8000),
          redirect: "error",
          cache: "no-store",
        }),
        true,
      );
      const result = z
        .object({
          success: z.literal(true),
          cast: z.object({
            hash: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            author: z.object({ fid: z.literal(ANNOUNCEMENT_FID) }),
          }),
        })
        .safeParse(body);
      if (!result.success)
        throw new ProviderFailure("manual_review", "CAST_RESPONSE_IDENTITY_MISMATCH");
      await database().query(
        "UPDATE public.marketplace_announcements SET status = 'sent', cast_hash = $5, last_error_code = NULL, lease_token = NULL, lease_until = NULL, updated_at = NOW() WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2 AND event = $3 AND lease_token = $4",
        [
          identity.protocolAddress,
          identity.orderHash,
          identity.event,
          job.lease_token,
          result.data.cast.hash.toLowerCase(),
        ],
      );
      return;
    } catch (error) {
      const failure =
        error instanceof ProviderFailure
          ? error
          : new ProviderFailure(
              posting ? "ambiguous" : "retryable",
              posting ? "CAST_RESULT_UNKNOWN" : "ANNOUNCEMENT_PREPARATION_FAILED",
            );
      await recordFailure(identity, job, failure);
      if (
        attempt === 1 ||
        !["retryable", "ambiguous"].includes(failure.state) ||
        failure.delay > 2000
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, failure.delay));
    }
  }
}

/** Never let notification setup, provider errors, or scheduling failure reject an accepted sale listing. */
export async function scheduleMarketplaceAnnouncement(offer: MarketplaceOffer, listing: unknown) {
  try {
    const settings = config();
    if (!settings) return;
    const identity = await enqueue(offer, listing, settings.signer);
    if (!identity) return;
    after(async () => {
      try {
        await processMarketplaceAnnouncement(identity);
      } catch {
        audit("ANNOUNCEMENT_BACKGROUND_FAILED", identity);
      }
    });
  } catch {
    audit("ANNOUNCEMENT_SCHEDULING_FAILED");
  }
}
