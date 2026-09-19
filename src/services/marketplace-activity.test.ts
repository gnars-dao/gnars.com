import { zeroAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketplaceActivity } from "./marketplace-activity";

const provider = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("./marketplace-opensea", () => ({ requestOpenSeaNftActivity: provider }));
const collection = "0x880fb3cf5c6cc2d7dfc13a993e839a9411200c17";
const from = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const transaction = `0x${"a".repeat(64)}`;
const input = { collection, tokenId: "1830" };
const transfer = () => ({
  event_type: "transfer",
  transfer_type: "transfer",
  event_timestamp: 1789818065,
  transaction,
  chain: "base",
  quantity: 1,
  from_address: from,
  to_address: to,
  nft: { identifier: "1830", contract: collection, token_standard: "erc721" },
});
const sale = () => ({
  ...transfer(),
  event_type: "sale",
  seller: from,
  buyer: to,
  payment: {
    quantity: "1300000000000000",
    token_address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    symbol: "WETH",
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  provider.mockResolvedValue({ asset_events: [], next: null });
});

describe("OpenSea indexed NFT activity", () => {
  it("preserves exact payment and separate sale/transfer identities, dropping duplicates", async () => {
    provider.mockResolvedValue({ asset_events: [sale(), transfer(), transfer()], next: null });
    const page = await getMarketplaceActivity(input);
    expect(page.source).toBe("opensea");
    expect(page.events).toHaveLength(2);
    expect(page.events[0]).toMatchObject({
      id: `${transaction}:sale:${from}:${to}`,
      from,
      to,
      payment: { quantity: "1300000000000000", symbol: "WETH", decimals: 18 },
    });
    expect(page.events[1].id).toBe(`${transaction}:transfer:${from}:${to}`);
  });
  it("classifies mints and burns from transfer addresses", async () => {
    provider.mockResolvedValue({
      asset_events: [
        { ...transfer(), from_address: zeroAddress, transfer_type: "mint" },
        { ...transfer(), to_address: zeroAddress, transfer_type: "burn" },
      ],
    });
    expect((await getMarketplaceActivity(input)).events).toMatchObject([
      { type: "mint", from: null, to },
      { type: "burn", from, to: null },
    ]);
  });
  it("binds provider pagination to the exact asset", async () => {
    provider.mockResolvedValueOnce({ asset_events: [], next: "opaque+/page==" });
    const page = await getMarketplaceActivity(input);
    expect(page.nextCursor).toBeTruthy();
    await getMarketplaceActivity({ ...input, cursor: page.nextCursor });
    expect(provider).toHaveBeenLastCalledWith(collection, "1830", "opaque+/page==");
    await expect(
      getMarketplaceActivity({ ...input, tokenId: "1831", cursor: page.nextCursor }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      getMarketplaceActivity({ ...input, collection: to, cursor: page.nextCursor }),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it("fails when the provider repeats a continuation cursor", async () => {
    provider.mockResolvedValue({ asset_events: [], next: "same" });
    const first = await getMarketplaceActivity(input);
    await expect(
      getMarketplaceActivity({ ...input, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("skips unrelated event types but preserves continuation", async () => {
    provider.mockResolvedValue({ asset_events: [{ event_type: "listing" }], next: "more" });
    expect(await getMarketplaceActivity(input)).toMatchObject({
      events: [],
      nextCursor: expect.any(String),
    });
  });
  it.each([
    { chain: "ethereum" },
    { transaction: "https://malicious.example" },
    { from_address: "invalid" },
    { nft: { ...transfer().nft, contract: to } },
    { nft: { ...transfer().nft, identifier: "1" } },
    { nft: undefined },
    { nft: { ...transfer().nft, token_standard: "erc1155" } },
    { quantity: 2 },
    { quantity: Number.MAX_SAFE_INTEGER + 1 },
    { event_timestamp: 1.5 },
    { event_timestamp: Number.MAX_SAFE_INTEGER },
    { protocol_address: "invalid" },
    { order_hash: "invalid" },
    { transfer_type: "mint" },
    { transfer_type: "unknown" },
  ])("rejects malformed or mismatched known events: %j", async (patch) => {
    provider.mockResolvedValue({ asset_events: [{ ...transfer(), ...patch }] });
    await expect(getMarketplaceActivity(input)).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    { quantity: Number.MAX_SAFE_INTEGER + 1 },
    { quantity: "1e18" },
    { quantity: "-1" },
    { quantity: (2n ** 256n).toString() },
    { decimals: 255 },
    { decimals: 1.1 },
    { token_address: from },
    { symbol: "ETH" },
    { symbol: "ETH\n" },
  ])("rejects malformed or spoofed payment: %j", async (patch) => {
    const event = sale();
    provider.mockResolvedValue({
      asset_events: [{ ...event, payment: { ...event.payment, ...patch } }],
    });
    await expect(getMarketplaceActivity(input)).rejects.toMatchObject({ status: 503 });
  });
  it("retains other payment token identity without assuming ETH", async () => {
    const event = sale();
    provider.mockResolvedValue({
      asset_events: [
        {
          ...event,
          payment: { quantity: "1200000", decimals: 6, token_address: from, symbol: "USDC" },
        },
      ],
    });
    expect((await getMarketplaceActivity(input)).events[0].payment).toEqual({
      quantity: "1200000",
      decimals: 6,
      tokenAddress: from,
      symbol: "USDC",
    });
  });
  it.each([
    {},
    { asset_events: null },
    { asset_events: Array(21).fill(transfer()) },
    { asset_events: [], next: "a".repeat(1025) },
    { asset_events: [], next: "line\nbreak" },
  ])("rejects malformed page envelopes", async (response) => {
    provider.mockResolvedValue(response);
    await expect(getMarketplaceActivity(input)).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    { cursor: "bad" },
    { cursor: "x".repeat(4097) },
    { tokenId: "01" },
    { collection: zeroAddress },
    { limit: "200" },
  ])("rejects invalid request input", async (patch) => {
    await expect(getMarketplaceActivity({ ...input, ...patch })).rejects.toMatchObject({
      status: 400,
    });
    expect(provider).not.toHaveBeenCalled();
  });
  it("propagates provider failure instead of empty history", async () => {
    const failure = new Error("provider failed");
    provider.mockRejectedValue(failure);
    await expect(getMarketplaceActivity(input)).rejects.toBe(failure);
  });
});
