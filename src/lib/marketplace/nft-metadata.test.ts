import { describe, expect, it } from "vitest";
import { decodeInlineNftMetadata, NFT_METADATA_MAX_BYTES, parseNftTraits } from "./nft-metadata";

const properties = {
  background: "Blue",
  body: "Skater",
  accessory: "Board",
  head: "Cap",
  glasses: "Black",
};
describe("NFT metadata traits", () => {
  it.each([false, true])(
    "reads all five Gnars properties from inline JSON (base64 %s)",
    (base64) => {
      const json = JSON.stringify({ name: "Gnar #12", properties });
      const uri = base64
        ? `data:application/json;base64,${Buffer.from(json).toString("base64")}`
        : `data:application/json,${encodeURIComponent(json)}`;
      expect(parseNftTraits(decodeInlineNftMetadata(uri))).toEqual(
        Object.entries(properties).map(([type, value]) => ({ type, value })),
      );
    },
  );
  it("supports attributes without losing decimal, zero, and false values", () => {
    expect(
      parseNftTraits({
        attributes: [
          { trait_type: "Level", value: 1.25 },
          { trait_type: "Count", value: 0 },
          { trait_type: "Animated", value: false },
        ],
      }),
    ).toEqual([
      { type: "Level", value: "1.25" },
      { type: "Count", value: "0" },
      { type: "Animated", value: "false" },
    ]);
  });
  it("prefers authoritative scalar properties and ignores structural properties", () => {
    expect(
      parseNftTraits({
        properties: { head: "Cap", files: [{}] },
        attributes: [{ trait_type: "head", value: "Wrong" }],
      }),
    ).toEqual([{ type: "head", value: "Cap" }]);
    expect(parseNftTraits({ name: "Art", properties: { files: [{}] } })).toEqual([]);
  });
  it.each([
    null,
    [],
    "bad",
    { properties: [] },
    { attributes: {} },
    { attributes: [null] },
    { attributes: [{ trait_type: "", value: "x" }] },
    { attributes: [{ trait_type: "x", value: {} }] },
    { properties: { level: Infinity } },
    { properties: { level: Number.MAX_SAFE_INTEGER + 1 } },
    { properties: { ["x".repeat(81)]: "x" } },
    { properties: { x: "y".repeat(201) } },
    { attributes: Array.from({ length: 65 }, () => ({ trait_type: "x", value: "y" })) },
  ])("rejects malformed or unbounded traits", (value) =>
    expect(() => parseNftTraits(value)).toThrow(),
  );
  it.each([
    "data:text/html,{}",
    "data:application/json;base64,%%%",
    "data:application/json;base64,e30",
    "data:application/json,%zz",
    "data:application/json,[]",
    "data:application/json,not-json",
  ])("rejects malformed inline URI %s", (uri) => {
    expect(() => decodeInlineNftMetadata(uri)).toThrow();
  });
  it("rejects oversized decoded and encoded payloads", () => {
    const json = JSON.stringify({ name: "x".repeat(NFT_METADATA_MAX_BYTES) });
    expect(() =>
      decodeInlineNftMetadata(
        `data:application/json;base64,${Buffer.from(json).toString("base64")}`,
      ),
    ).toThrow();
    expect(() => decodeInlineNftMetadata(`data:application/json,${"x".repeat(350001)}`)).toThrow();
  });
});
