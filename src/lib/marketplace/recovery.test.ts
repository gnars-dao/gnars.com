import { zeroAddress, zeroHash, type Address, type PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { COMMUNITY_FEE_RECIPIENT, GNARS_MARKETPLACE_FEE_POLICY } from "./community-policy";
import { parseMarketplaceApiError } from "./errors";
import { canCancelSavedListing } from "./listing-intent";
import {
  canResumeMarketplacePreflight,
  canRetryMarketplacePublication,
  inspectSavedMarketplaceListing,
  marketplaceActionError,
  repairMarketplaceJournal,
} from "./recovery";
import { getListingOrderHash, SEAPORT_ADDRESS, validateListingStructure } from "./seaport";

afterEach(() => vi.unstubAllEnvs());

const owner = "0x1111111111111111111111111111111111111111" as Address;
const listing = {
  parameters: {
    offerer: owner,
    zone: zeroAddress,
    zoneHash: zeroHash,
    conduitKey: zeroHash,
    offer: [
      {
        itemType: 2,
        token: DAO_ADDRESSES.token,
        identifierOrCriteria: "5423",
        startAmount: "1",
        endAmount: "1",
      },
    ],
    consideration: [
      {
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: "20000000000000000",
        endAmount: "20000000000000000",
        recipient: owner,
      },
    ],
    orderType: 0,
    startTime: "1000",
    endTime: "87400",
    salt: "1",
    counter: "0",
  },
  signature: "0x1234",
};
describe("marketplace recovery guards", () => {
  it.each(["gnars", "gnars-contract"])(
    "preserves the native 1%% fee and signature for %s",
    (source) => {
      const custom = "0x3333333333333333333333333333333333333333";
      vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", custom);
      const signed = structuredClone(listing);
      signed.parameters.consideration = [
        {
          ...listing.parameters.consideration[0],
          startAmount: "19800000000000000",
          endAmount: "19800000000000000",
        },
        {
          ...listing.parameters.consideration[0],
          recipient: COMMUNITY_FEE_RECIPIENT,
          startAmount: "200000000000000",
          endAmount: "200000000000000",
        },
      ];
      const repaired = JSON.parse(
        repairMarketplaceJournal(
          JSON.stringify({
            account: owner,
            listing: signed,
            input: {
              source,
              ...(source === "gnars-contract" ? { protocolAddress: custom } : {}),
              expectedQuote: { feePolicy: GNARS_MARKETPLACE_FEE_POLICY },
            },
          }),
          owner,
        ),
      );
      expect(repaired.listing).toEqual(signed);
      expect(repaired.input.collectionAddress).toBeUndefined();
      expect(repaired.input.expectedQuote).toMatchObject({
        source,
        sellerWei: "19800000000000000",
        feePolicy: GNARS_MARKETPLACE_FEE_POLICY,
      });
      expect(getListingOrderHash(repaired.listing.parameters)).toBe(
        getListingOrderHash(validateListingStructure(signed, { allowExpired: true }).parameters),
      );
    },
  );
  it("preserves community collection and signed fee snapshot across journal repair", () => {
    const custom = "0x3333333333333333333333333333333333333333";
    const collectionAddress = "0x4444444444444444444444444444444444444444";
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", custom);
    vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", "999");
    const community = structuredClone(listing);
    community.parameters.offer[0].token = collectionAddress;
    community.parameters.consideration = [
      {
        ...community.parameters.consideration[0],
        startAmount: "19500000000000000",
        endAmount: "19500000000000000",
      },
      {
        ...community.parameters.consideration[0],
        recipient: COMMUNITY_FEE_RECIPIENT,
        startAmount: "500000000000000",
        endAmount: "500000000000000",
      },
    ];
    const feePolicy = { basisPoints: 250, recipient: COMMUNITY_FEE_RECIPIENT };
    const raw = {
      account: owner,
      listing: community,
      input: {
        source: "gnars-contract",
        listingComment: "A collector's note",
        protocolAddress: custom,
        collectionAddress,
        expectedQuote: { feePolicy },
      },
    };
    const repaired = JSON.parse(repairMarketplaceJournal(JSON.stringify(raw), owner));
    expect(repaired.listing).toEqual(community);
    expect(repaired.collectionAddress).toBe(collectionAddress);
    expect(repaired.input.collectionAddress).toBe(collectionAddress);
    expect(repaired.input.listingComment).toBe("A collector's note");
    expect(repaired.input.expectedQuote.feePolicy).toEqual(feePolicy);
    expect(repaired.input.expectedQuote.sellerWei).toBe("19500000000000000");
    expect(() =>
      repairMarketplaceJournal(
        JSON.stringify({ ...raw, input: { ...raw.input, expectedQuote: undefined } }),
        owner,
      ),
    ).toThrow("fee policy");
  });
  it("inspects only the explicit protocol and never rewrites legacy source defaults", async () => {
    const custom = "0x3333333333333333333333333333333333333333";
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", custom);
    const signed = validateListingStructure(listing, { allowExpired: true });
    const reader = {
      readContract: vi.fn().mockResolvedValue([false, true, 0n, 0n]),
      getBlock: vi.fn(),
    };
    await inspectSavedMarketplaceListing(reader, signed, { source: "gnars-contract" });
    expect(reader.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: custom }),
    );
    await inspectSavedMarketplaceListing(reader, signed);
    expect(reader.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: SEAPORT_ADDRESS }),
    );
    const raw = JSON.stringify({ account: owner, listing });
    expect(JSON.parse(repairMarketplaceJournal(raw, owner)).input.source).toBe("gnars");
    const customRaw = JSON.stringify({
      account: owner,
      listing,
      input: { source: "gnars-contract", protocolAddress: custom },
    });
    expect(JSON.parse(repairMarketplaceJournal(customRaw, owner)).input.source).toBe(
      "gnars-contract",
    );
    expect(JSON.parse(repairMarketplaceJournal(customRaw, owner)).input.protocolAddress).toBe(
      custom,
    );
    expect(() =>
      repairMarketplaceJournal(
        JSON.stringify({ account: owner, listing, input: { source: "gnars-contract" } }),
        owner,
      ),
    ).toThrow("Saved listing protocol");
  });
  it("allows only explicit retryable publication failures to be retried", () => {
    expect(canRetryMarketplacePublication({})).toBe(true);
    expect(canRetryMarketplacePublication({ error: { retryable: true } })).toBe(true);
    expect(canRetryMarketplacePublication({ error: { retryable: false } })).toBe(false);
  });
  it.each([
    { status: [false, false, 0n, 0n], timestamp: 2000n, outcome: null },
    { status: [false, true, 0n, 0n], timestamp: 2000n, outcome: "cancelled" },
    { status: [false, false, 1n, 1n], timestamp: 2000n, outcome: "filled" },
    { status: [false, false, 0n, 0n], timestamp: 90000n, outcome: "expired" },
  ])(
    "inspects saved order outcome $outcome using only exact chain reads",
    async ({ status, timestamp, outcome }) => {
      const signed = validateListingStructure(listing, { allowExpired: true });
      const reader = {
        readContract: vi.fn().mockResolvedValue(status),
        getBlock: vi.fn().mockResolvedValue({ timestamp }),
      };
      expect(
        await inspectSavedMarketplaceListing(
          reader as unknown as Pick<PublicClient, "readContract" | "getBlock">,
          signed,
        ),
      ).toBe(outcome);
      expect(reader.readContract).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          functionName: "getOrderStatus",
          args: [getListingOrderHash(signed.parameters)],
        }),
      );
      expect(reader.getBlock).toHaveBeenCalledTimes(
        outcome === "cancelled" || outcome === "filled" ? 0 : 1,
      );
    },
  );
  it("preserves permanent publication rejection metadata through the action error mapper", () => {
    const error = parseMarketplaceApiError(
      {
        error: "The signed order was rejected",
        code: "OPENSEA_ORDER_REJECTED",
        retryable: false,
        requestId: "trace-42",
      },
      422,
    );
    expect(marketplaceActionError(error, "unknown")).toEqual({
      code: "OPENSEA_ORDER_REJECTED",
      message: "The signed order was rejected",
      retryable: false,
      requestId: "trace-42",
    });
  });
  it.each(["approving", "buying", "cancelling"])("resumes %s only before broadcasting", (phase) => {
    expect(canResumeMarketplacePreflight({ phase })).toBe(true);
    expect(canResumeMarketplacePreflight({ phase, transactionIntent: {} })).toBe(false);
    expect(canResumeMarketplacePreflight({ phase, txHash: zeroHash })).toBe(false);
  });
  it("retains cancellation recovery after a rejected or reverted cancellation", () => {
    expect(canCancelSavedListing({ kind: "cancel", phase: "failed", listing })).toBe(true);
    expect(
      canCancelSavedListing({
        kind: "cancel",
        phase: "failed",
        listing,
        txHash: zeroHash,
        transactionIntent: {},
        transactionFailed: true,
      }),
    ).toBe(true);
    expect(
      canCancelSavedListing({ kind: "cancel", phase: "unknown", listing, transactionIntent: {} }),
    ).toBe(false);
  });
  it("repairs journal metadata while preserving the exact signed order and destination", () => {
    const repaired = JSON.parse(
      repairMarketplaceJournal(
        JSON.stringify({
          account: owner,
          listing,
          input: { source: "opensea" },
          phase: "old-invalid-phase",
        }),
        owner,
      ),
    );
    expect(repaired.listing).toEqual(listing);
    expect(repaired.input).toMatchObject({ source: "opensea", tokenId: "5423", priceEth: "0.02" });
    expect(repaired.phase).toBe("saving");
  });
  it("never repairs away a possible broadcast, unknown signature, malformed JSON or other owner", () => {
    for (const raw of [
      "broken JSON",
      JSON.stringify({ account: owner }),
      JSON.stringify({ account: owner, listing, txHash: zeroHash }),
      JSON.stringify({ account: owner, listing, transactionIntent: {} }),
      JSON.stringify({ account: zeroAddress, listing }),
    ])
      expect(() => repairMarketplaceJournal(raw, owner)).toThrow();
  });
});
