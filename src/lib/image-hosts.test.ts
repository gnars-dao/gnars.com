import { expect, it } from "vitest";
import { canOptimizeImage } from "./image-hosts";

it("optimizes known media without accepting lookalike or arbitrary origins", () => {
  expect(canOptimizeImage("/logo.png")).toBe(true);
  expect(canOptimizeImage("https://ipfs.skatehive.app/ipfs/abc")).toBe(true);
  expect(canOptimizeImage("https://gnars.mypinata.cloud/ipfs/abc")).toBe(true);
  expect(canOptimizeImage("https://ipfs.skatehive.app.evil.test/a")).toBe(false);
  expect(canOptimizeImage("https://evil.test/a")).toBe(false);
  expect(canOptimizeImage("//evil.test/a")).toBe(false);
  expect(canOptimizeImage("https://user@ipfs.io/a")).toBe(false);
});
