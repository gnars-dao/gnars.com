import { describe, expect, it, vi } from "vitest";
import {
  advanceTraitIndex,
  matchIndexedTraits,
  traitIndexComplete,
  validateTraitIndex,
  type TraitIndex,
} from "./trait-index";

const hash = `0x${"ab".repeat(32)}`;
const initial = (): TraitIndex => ({
  version: 1,
  chainId: 8453,
  collection: `0x${"11".repeat(20)}`,
  blockNumber: "100",
  blockHash: hash,
  expectedCount: 2,
  cursor: null,
  enumerated: false,
  entries: [],
});
const yellow = [{ type: "Background", value: "Yellow" }];
describe("complete trait index", () => {
  it("rechecks even a complete snapshot without rereading metadata", async () => {
    const index = { ...initial(), expectedCount: 0, enumerated: true };
    const page = vi.fn(async () => []);
    const read = vi.fn(async () => []);
    const blockHash = vi.fn(async () => hash);
    await expect(advanceTraitIndex(index, { blockHash, page, read })).resolves.toEqual(index);
    expect(blockHash).toHaveBeenCalledTimes(2);
    expect(page).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    blockHash.mockResolvedValueOnce(`0x${"cd".repeat(32)}`);
    await expect(advanceTraitIndex(index, { blockHash, page, read })).rejects.toThrow(
      "block changed",
    );
  });
  it("requires exhaustion and all metadata, and resumes failures before advancing", async () => {
    const io = {
      blockHash: vi.fn(async () => hash),
      page: vi.fn(async () => ["4", "2"]),
      read: vi.fn(async (): Promise<Array<typeof yellow | null>> => [yellow, null]),
    };
    const first = await advanceTraitIndex(initial(), io);
    expect(traitIndexComplete(first)).toBe(false);
    expect(() => matchIndexedTraits(first, {})).toThrow("incomplete");
    io.read.mockResolvedValueOnce([[]]);
    const second = await advanceTraitIndex(first, io);
    expect(io.page).toHaveBeenCalledTimes(1);
    expect(io.read).toHaveBeenLastCalledWith(["2"]);
    expect(first.entries[1].traits).toBeNull();
    io.page.mockResolvedValueOnce([]);
    const done = await advanceTraitIndex(second, io);
    expect(traitIndexComplete(done)).toBe(true);
    expect(matchIndexedTraits(done, { Background: ["Yellow"] })).toEqual(["4"]);
  });
  it("uses OR within each trait and AND between traits", () => {
    const index = {
      ...initial(),
      cursor: "2",
      enumerated: true,
      entries: [
        { tokenId: "4", traits: [...yellow, { type: "Head", value: "Mirror" }] },
        { tokenId: "2", traits: [{ type: "Background", value: "Blue" }] },
      ],
    };
    expect(matchIndexedTraits(index, { Background: ["Blue", "Yellow"] })).toEqual(["4", "2"]);
    expect(matchIndexedTraits(index, { Background: ["Blue", "Yellow"], Head: ["Mirror"] })).toEqual(
      ["4"],
    );
    expect(matchIndexedTraits(index, { Head: [] })).toEqual(["4", "2"]);
  });
  it("rejects truncated enumeration instead of reporting no matches", async () => {
    await expect(
      advanceTraitIndex(initial(), {
        blockHash: async () => hash,
        page: async () => [],
        read: async () => [],
      }),
    ).rejects.toThrow("supply mismatch");
  });
  it.each([["4", "4"], ["2", "4"], ["-1"], ["01"], [String(2n ** 256n)]])(
    "rejects malformed/repeated IDs %j",
    async (...ids) => {
      await expect(
        advanceTraitIndex(initial(), {
          blockHash: async () => hash,
          page: async () => ids,
          read: async () => [],
        }),
      ).rejects.toThrow();
    },
  );
  it("rejects reorgs before or during a batch", async () => {
    const blockHash = vi.fn(async () => hash).mockResolvedValueOnce(`0x${"cd".repeat(32)}`);
    const page = vi.fn(async () => ["4", "2"]);
    const io = { blockHash, page, read: async () => [yellow, []] };
    await expect(advanceTraitIndex(initial(), io)).rejects.toThrow("block changed");
    expect(page).not.toHaveBeenCalled();
    blockHash
      .mockReset()
      .mockResolvedValueOnce(hash)
      .mockResolvedValueOnce(`0x${"cd".repeat(32)}`);
    await expect(advanceTraitIndex(initial(), io)).rejects.toThrow("block changed");
  });
  it("rejects wrong cursor, supply, batch and response size", async () => {
    expect(() => validateTraitIndex({ ...initial(), cursor: "1" })).toThrow("cursor");
    const io = {
      blockHash: async () => hash,
      page: async () => ["4", "2"],
      read: async () => [yellow],
    };
    await expect(advanceTraitIndex(initial(), io)).rejects.toThrow("count mismatch");
    await expect(advanceTraitIndex(initial(), io, 1)).rejects.toThrow("exceeds batch");
    await expect(advanceTraitIndex(initial(), io, 0)).rejects.toThrow("batch size");
    await expect(advanceTraitIndex({ ...initial(), expectedCount: 1 }, io)).rejects.toThrow(
      "exceeds supply",
    );
  });
});
