import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { RequestSecurityError } from "@/lib/server/request-security";
import { getMarketplaceActivity, marketplaceActivityQuerySchema } from "./marketplace-activity";
import {
  MarketplaceServiceError,
  marketplaceUnavailable,
  parseMarketplaceInput,
} from "./marketplace-common";
import { getNativeMarketplaceActivity } from "./marketplace-native-activity";

const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9]\d*)$/);
const coverage = z
  .object({
    startBlock: uint,
    indexedThrough: uint,
    blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  })
  .strict();
const cursorSchema = z
  .object({
    version: z.literal(3),
    collection: z.string(),
    tokenId: uint,
    opensea: z
      .object({
        done: z.boolean(),
        cursor: z.string().max(4096).nullable(),
        offset: z.number().int().min(0).max(20),
        fingerprint: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .strict(),
    native: z
      .object({
        done: z.boolean(),
        cursor: z
          .object({
            blockNumber: uint,
            logIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          })
          .strict()
          .nullable(),
        coverage: coverage.nullable(),
      })
      .strict(),
  })
  .strict();
const querySchema = marketplaceActivityQuerySchema.extend({
  cursor: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

/** Merge sorted streams; retain unconsumed positions instead of skipping a provider page. */
export async function getMarketplaceCombinedActivity(raw: unknown) {
  const input = parseMarketplaceInput(querySchema, raw);
  let state: z.infer<typeof cursorSchema> = {
    version: 3,
    collection: input.collection,
    tokenId: input.tokenId,
    opensea: { done: false, cursor: null, offset: 0, fingerprint: null },
    native: { done: false, cursor: null, coverage: null },
  };
  if (input.cursor) {
    try {
      state = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
      if (
        state.collection !== input.collection ||
        state.tokenId !== input.tokenId ||
        (state.native.cursor && !state.native.coverage) ||
        state.opensea.offset > 0 !== (state.opensea.fingerprint !== null)
      )
        throw new Error("Invalid scope");
    } catch {
      throw new RequestSecurityError(400, "Invalid NFT activity cursor.");
    }
  }
  const [opensea, native] = await Promise.allSettled([
    state.opensea.done
      ? Promise.resolve(null)
      : getMarketplaceActivity({
          collection: input.collection,
          tokenId: input.tokenId,
          ...(state.opensea.cursor ? { cursor: state.opensea.cursor } : {}),
        }),
    state.native.done
      ? Promise.resolve(null)
      : getNativeMarketplaceActivity(
          input.collection,
          input.tokenId,
          state.native.cursor ?? undefined,
          state.native.coverage?.indexedThrough,
        ),
  ]);
  if (opensea.status === "rejected" && native.status === "rejected")
    throw marketplaceUnavailable("NFT activity sources are unavailable.");
  const sources = {
    opensea: { available: opensea.status === "fulfilled" },
    gnars: { available: native.status === "fulfilled" },
  };
  const osPage = opensea.status === "fulfilled" ? opensea.value : null;
  const nativePage = native.status === "fulfilled" ? native.value : null;
  const fingerprint = osPage
    ? createHash("sha256").update(JSON.stringify(osPage)).digest("hex")
    : null;
  if (
    osPage &&
    (state.opensea.offset > osPage.events.length ||
      (state.opensea.fingerprint && state.opensea.fingerprint !== fingerprint))
  )
    throw new MarketplaceServiceError(
      409,
      "NFT activity changed. Refresh its history.",
      "ACTIVITY_CURSOR_EXPIRED",
      false,
    );
  const osEvents =
    osPage?.events
      .slice(state.opensea.offset)
      .map((event) => ({ ...event, source: "opensea" as const })) ?? [];
  const nativeEvents = nativePage?.events ?? [];
  let oi = 0,
    ni = 0;
  const events = [];
  while (events.length < 20) {
    // An exhausted page with a continuation is an unknown watermark: fetch it
    // before emitting older events from the other stream.
    if (
      (oi === osEvents.length && osPage?.nextCursor) ||
      (ni === nativeEvents.length && nativePage?.nextCursor)
    )
      break;
    const osEvent = osEvents[oi],
      nativeEvent = nativeEvents[ni];
    if (!osEvent && !nativeEvent) break;
    if (nativeEvent && (!osEvent || nativeEvent.timestamp >= osEvent.timestamp)) {
      events.push(nativeEvent);
      ni++;
    } else {
      events.push(osEvent);
      oi++;
    }
  }
  if (osPage) {
    const offset = state.opensea.offset + oi;
    state.opensea =
      offset === osPage.events.length
        ? {
            cursor: osPage.nextCursor,
            done: osPage.nextCursor === null,
            offset: 0,
            fingerprint: null,
          }
        : { ...state.opensea, offset, fingerprint: offset ? fingerprint : null };
  }
  if (nativePage) {
    const last = nativeEvents[ni - 1];
    state.native = {
      cursor: last
        ? { blockNumber: last.blockNumber, logIndex: last.logIndex }
        : state.native.cursor,
      done: ni === nativeEvents.length && nativePage.nextCursor === null,
      coverage: state.native.coverage ?? nativePage.coverage,
    };
  }
  // Failed streams retain their cursor and can be retried without losing either source's history.
  return {
    collectionAddress: input.collection,
    tokenId: input.tokenId,
    source: "combined" as const,
    sources,
    ...(state.native.coverage ? { coverage: state.native.coverage } : {}),
    events,
    nextCursor:
      state.opensea.done && state.native.done
        ? null
        : Buffer.from(JSON.stringify(state)).toString("base64url"),
  };
}
