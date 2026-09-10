import { describe, expect, it } from "vitest";
import { IPFS_GATEWAYS } from "@/lib/ipfs";
import { nftVideoUrl } from "./video";

const cid = "bafkreicxejfi5jgli57mzuweeavfnvt2w2foaanpzprqnhrzuysvvbl4um";

describe("NFT MP4 URLs", () => {
  it("resolves typed IPFS videos without a filename through fixed gateways", () => {
    expect(nftVideoUrl(`ipfs://${cid}`, "video/mp4")).toBe(IPFS_GATEWAYS[0] + cid);
    expect(nftVideoUrl(`https://other.example/ipfs/${cid}`, "video/mp4")).toBe(
      IPFS_GATEWAYS[0] + cid,
    );
  });
  it("supports HTTPS MP4 paths and signed query parameters", () => {
    expect(nftVideoUrl("https://media.example/clip.MP4?signature=test")).toBe(
      "https://media.example/clip.MP4?signature=test",
    );
  });
  it.each([
    undefined,
    "javascript:alert(1)",
    "data:video/mp4;base64,abcd",
    "http://media.example/clip.mp4",
    "https://user:password@media.example/clip.mp4",
    "https://127.0.0.1/clip.mp4",
    "https://2130706433/clip.mp4",
    "https://[::1]/clip.mp4",
    "https://localhost/clip.mp4",
    "https://private.local/clip.mp4",
    `ipfs://${cid}/%2e%2e/private.mp4`,
    `ipfs://${cid}/%5cprivate.mp4`,
    `ipfs://${cid}?redirect=evil`,
    "ipfs://invalid",
  ])("rejects unsafe video URL %s", (value) => {
    expect(nftVideoUrl(value, "video/mp4")).toBeNull();
  });
  it("does not treat untyped animation content as a video", () => {
    expect(nftVideoUrl(`ipfs://${cid}`)).toBeNull();
    expect(nftVideoUrl("https://media.example/animation.html", "text/html")).toBeNull();
    expect(nftVideoUrl("https://media.example/animation.mp4", "text/html")).toBeNull();
    expect(nftVideoUrl("https://media.example/animation", "video/webm")).toBeNull();
  });
});
