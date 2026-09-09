import { describe, expect, it } from "vitest";
import {
  coinMedia,
  compactUsd,
  deltaPercent,
  onchainToCoin,
  shortDescription,
  zoraCoinUrl,
} from "./coinCardModel";

describe("coinMedia", () => {
  it("prefers the medium preview for an image coin and converts ipfs uris", () => {
    const m = coinMedia({
      mediaContent: {
        mimeType: "image/png",
        originalUri: "ipfs://QmOriginal",
        previewImage: { small: "https://cdn/s.png", medium: "https://cdn/m.png" },
      },
    });
    expect(m).toEqual({ kind: "image", src: "https://cdn/m.png" });
    expect(coinMedia({ mediaContent: { originalUri: "ipfs://QmX" } })?.src).toMatch(
      /^https?:\/\/.+QmX/,
    );
  });

  it("plays the original for a video coin with the preview as poster", () => {
    const m = coinMedia({
      mediaContent: {
        mimeType: "video/mp4",
        originalUri: "https://cdn/clip.mp4",
        previewImage: { small: "https://cdn/s.jpg" },
      },
    });
    expect(m).toEqual({ kind: "video", src: "https://cdn/clip.mp4", poster: "https://cdn/s.jpg" });
  });

  it("is null when the coin has no media at all", () => {
    expect(coinMedia({})).toBeNull();
    expect(coinMedia({ mediaContent: { mimeType: "image/png" } })).toBeNull();
  });
});

describe("compactUsd", () => {
  it("rounds to the unit that reads", () => {
    expect(compactUsd("1234567")).toBe("$1.2M");
    expect(compactUsd("48250.5")).toBe("$48.3K");
    expect(compactUsd(912.4)).toBe("$912");
    expect(compactUsd("12.345")).toBe("$12.35");
    expect(compactUsd(null)).toBe("—");
    expect(compactUsd("nope")).toBe("—");
  });
});

describe("deltaPercent", () => {
  it("reads the 24h move against yesterday's cap", () => {
    expect(deltaPercent({ marketCap: "1100", marketCapDelta24h: "100" })).toBeCloseTo(10);
    expect(deltaPercent({ marketCap: "900", marketCapDelta24h: "-100" })).toBeCloseTo(-10);
    expect(deltaPercent({ marketCap: "100" })).toBeNull();
    expect(deltaPercent({ marketCap: "50", marketCapDelta24h: "60" })).toBeNull();
  });
});

describe("shortDescription", () => {
  it("collapses whitespace, keeps short text, and clamps long text at a word", () => {
    expect(shortDescription("  a   b \n c ")).toBe("a b c");
    const long = "word ".repeat(60).trim();
    const s = shortDescription(long, 100);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(101);
    expect(s).not.toMatch(/wor…$/);
    expect(shortDescription(null)).toBe("");
  });
});

describe("zoraCoinUrl", () => {
  it("points at the coin's Base page, lowercased", () => {
    expect(zoraCoinUrl("0xE19E55F525DF6C7A3FF2FEAFEF705BAF6BE5453B")).toBe(
      "https://zora.co/coin/base:0xe19e55f525df6c7a3ff2feafef705baf6be5453b",
    );
  });
});

describe("onchainToCoin", () => {
  it("maps contractURI metadata into the SDK shape, media included", () => {
    const c = onchainToCoin(
      {
        name: "venê",
        ticker: "Venê",
        description: "1 of each color",
        image: "ipfs://img",
        content: { mime: "image/jpeg", uri: "ipfs://img" },
      },
      "0xabc",
    );
    expect(c).toMatchObject({
      address: "0xabc",
      name: "venê",
      symbol: "Venê",
      description: "1 of each color",
    });
    expect(coinMedia(c!)).toEqual({ kind: "image", src: expect.stringMatching(/img$/) });
    expect(c?.marketCap).toBeUndefined();
  });

  it("is null for metadata that names nothing", () => {
    expect(onchainToCoin(null, "0x1")).toBeNull();
    expect(onchainToCoin({ foo: 1 }, "0x1")).toBeNull();
  });
});
