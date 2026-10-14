import { encodeAbiParameters, encodeEventTopics, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { POIDH_SOPA_ABI } from "./abi";
import { chunkRangesForTimestamps, estimateBlockAt } from "./blocks";
import {
  deriveSopaStatus,
  displayAmount,
  mergeSopaBounties,
  sumAmounts,
  type SopaBountyRow,
  type SopaBountyTuple,
} from "./bounty-data";
import { decodeSopaError } from "./errors";
import { extractCreatedBountyId } from "./receipt";

const CONTRACT = "0x1111111111111111111111111111111111111111" as const;
const ISSUER = "0x2222222222222222222222222222222222222222" as const;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;

function tuple(id: number, opts: Partial<{ claimer: `0x${string}`; createdAt: number }> = {}) {
  return [
    BigInt(id),
    ISSUER,
    USDC,
    `Bounty ${id}`,
    "desc",
    250_000_000n,
    opts.claimer ?? zeroAddress,
    BigInt(opts.createdAt ?? 1_700_000_000 + id),
  ] as const satisfies SopaBountyTuple;
}

describe("deriveSopaStatus", () => {
  const base = { issuer: ISSUER, contractAddress: CONTRACT, hasActiveProposal: false };
  it("reads claimer", () => {
    expect(deriveSopaStatus({ ...base, claimer: zeroAddress })).toBe("open");
    expect(deriveSopaStatus({ ...base, claimer: zeroAddress, hasActiveProposal: true })).toBe(
      "voting",
    );
    expect(deriveSopaStatus({ ...base, claimer: ISSUER.toUpperCase().replace("0X", "0x") })).toBe(
      "cancelled",
    );
    expect(deriveSopaStatus({ ...base, claimer: CONTRACT })).toBe("paid");
  });

  it("a cancelled bounty never reads as voting", () => {
    expect(deriveSopaStatus({ ...base, claimer: ISSUER, hasActiveProposal: true })).toBe(
      "cancelled",
    );
  });
});

describe("mergeSopaBounties", () => {
  const rows: SopaBountyRow[] = [
    { tuple: tuple(0), hasActiveProposal: false },
    { tuple: tuple(1, { claimer: CONTRACT }), hasActiveProposal: false },
    { tuple: tuple(2), hasActiveProposal: true },
  ];

  it("joins category and open/solo from logs by id, newest first", () => {
    const out = mergeSopaBounties(
      rows,
      [
        { id: 2, amount: "100", isOpenBounty: true, category: "skate" },
        { id: 0, amount: "250000000", isOpenBounty: false, category: "art" },
      ],
      CONTRACT,
      new Map([[1, true]]),
    );
    expect(out.map((b) => b.id)).toEqual([2, 1, 0]);
    expect(out[0]).toMatchObject({ category: "skate", isOpenBounty: true, status: "voting" });
    expect(out[1]).toMatchObject({ category: null, isOpenBounty: true, status: "paid" });
    expect(out[2]).toMatchObject({
      category: "art",
      isOpenBounty: false,
      status: "open",
      amount: "250000000",
      title: "Bounty 0",
    });
  });

  it("leaves open/solo unknown when neither source answered", () => {
    const out = mergeSopaBounties([rows[0]], [], CONTRACT);
    expect(out[0].isOpenBounty).toBeNull();
    expect(out[0].createdAmount).toBeNull();
  });

  it("displays the creation amount once escrow is emptied", () => {
    expect(displayAmount({ amount: "0", createdAmount: "500" })).toBe("500");
    expect(displayAmount({ amount: "700", createdAmount: "500" })).toBe("700");
    // paid open bounty: participant sum wins over the issuer-only creation amount
    expect(displayAmount({ amount: "0", createdAmount: "250", paidAmount: "300" })).toBe("300");
    expect(displayAmount({ amount: "0", createdAmount: "250", paidAmount: null })).toBe("250");
    expect(sumAmounts(["250", 50n, "0"])).toBe("300");
  });
});

describe("chunkRangesForTimestamps", () => {
  const latest = { number: 1_000_000n, timestamp: 2_000_000 };

  it("estimates with 2s blocks", () => {
    expect(estimateBlockAt(2_000_000 - 200, latest)).toBe(999_900n);
    expect(estimateBlockAt(0, latest)).toBe(0n);
  });

  it("returns deploy-aligned chunks covering each estimate, clamped to head", () => {
    const ranges = chunkRangesForTimestamps([2_000_000 - 20_000 * 2, 2_000_000 - 10], {
      deployBlock: 900_000n,
      latest,
      chunk: 10_000n,
      margin: 100n,
    });
    // estimates: 980_000 (boundary → chunks 970k and 980k) and 999_995 (± margin reaches
    // the head block, which opens the 1_000_000 chunk, clamped to head)
    expect(ranges).toEqual([
      { fromBlock: 970_000n, toBlock: 979_999n },
      { fromBlock: 980_000n, toBlock: 989_999n },
      { fromBlock: 990_000n, toBlock: 999_999n },
      { fromBlock: 1_000_000n, toBlock: 1_000_000n },
    ]);
  });

  it("never goes below the deploy block and de-duplicates", () => {
    const ranges = chunkRangesForTimestamps([1, 2, 3], {
      deployBlock: 950_000n,
      latest,
      chunk: 10_000n,
    });
    expect(ranges).toEqual([{ fromBlock: 950_000n, toBlock: 959_999n }]);
  });
});

describe("extractCreatedBountyId", () => {
  const event = POIDH_SOPA_ABI.find((x) => x.type === "event" && x.name === "BountyCreated")!;
  const topics = encodeEventTopics({
    abi: POIDH_SOPA_ABI,
    eventName: "BountyCreated",
    args: { id: 42n, issuer: ISSUER, token: USDC },
  });
  const nonIndexed = (
    event as { inputs: readonly { indexed?: boolean; type: string; name: string }[] }
  ).inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, [
    "t",
    "d",
    250_000_000n,
    1_700_000_000n,
    true,
    "skate",
  ]);

  it("finds the id from the Sopa contract's log", () => {
    const logs = [
      { address: USDC, data: "0x" as const, topics: [] as [] },
      { address: CONTRACT, data, topics: topics as [`0x${string}`, ...`0x${string}`[]] },
    ];
    expect(extractCreatedBountyId(logs, CONTRACT)).toBe(42);
  });

  it("ignores the same event from another emitter", () => {
    const logs = [{ address: USDC, data, topics: topics as [`0x${string}`, ...`0x${string}`[]] }];
    expect(extractCreatedBountyId(logs, CONTRACT)).toBeNull();
  });
});

describe("decodeSopaError", () => {
  it("maps custom errors and wallet rejections", () => {
    expect(decodeSopaError(new Error('reverted with "SharesMustSumToDenom()"')).key).toBe(
      "SharesMustSumToDenom",
    );
    expect(decodeSopaError(new Error("User rejected the request.")).key).toBe("userRejected");
    expect(decodeSopaError(new Error("ERC20InsufficientBalance(0x…)")).key).toBeNull();
    expect(decodeSopaError(new Error("boom\nstack")).message).toBe("boom");
  });
});
