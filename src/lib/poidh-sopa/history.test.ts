import { describe, expect, it } from "vitest";
import { buildHistoryEntry, paidBounties, summarizeHistory } from "./history";
import type { SopaBounty } from "./types";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ETH = "0x0000000000000000000000000000000000000000" as const;
const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;

function bounty(overrides: Partial<SopaBounty>): SopaBounty {
  return {
    id: 0,
    issuer: A,
    token: USDC,
    title: "Bounty",
    description: "",
    amount: "0",
    createdAmount: null,
    paidAmount: "30000000",
    createdAt: 0,
    isOpenBounty: true,
    category: "skate",
    status: "paid",
    ...overrides,
  };
}

const claims = new Map([
  [6, { claimer: A, name: "Trick log" }],
  [5, { claimer: B, name: "Grip stencil" }],
]);

describe("buildHistoryEntry", () => {
  it("pays each winner their share of the total net of the fee snapshot", () => {
    // Bounty #0 on Base: 30 USDC, 1.5% + 1% fees, 92% / 8%.
    const entry = buildHistoryEntry(
      bounty({}),
      { claimIds: [6n, 5n], sharesBps: [9200n, 800n] },
      [150, 100],
      claims,
    );
    expect(entry.winners).toEqual([
      { claimId: 6, claimer: A, name: "Trick log", shareBps: 9200, amount: "26910000" },
      { claimId: 5, claimer: B, name: "Grip stencil", shareBps: 800, amount: "2340000" },
    ]);
  });

  it("shows no winners rather than a partial split when a claim is unreadable", () => {
    const entry = buildHistoryEntry(
      bounty({}),
      { claimIds: [6n, 9n], sharesBps: [5000n, 5000n] },
      [150, 100],
      claims,
    );
    expect(entry.winners).toEqual([]);
  });

  it("shows no winners when the winners or fees read failed", () => {
    expect(buildHistoryEntry(bounty({}), null, [150, 100], claims).winners).toEqual([]);
    expect(
      buildHistoryEntry(bounty({}), { claimIds: [6n], sharesBps: [10000n] }, null, claims).winners,
    ).toEqual([]);
  });
});

describe("paidBounties", () => {
  it("keeps only paid bounties, newest first", () => {
    const list = [
      bounty({ id: 1, createdAt: 10 }),
      bounty({ id: 2, createdAt: 30, status: "cancelled" }),
      bounty({ id: 3, createdAt: 20 }),
      bounty({ id: 4, createdAt: 40, status: "open" }),
    ];
    expect(paidBounties(list).map((b) => b.id)).toEqual([3, 1]);
  });
});

describe("summarizeHistory", () => {
  it("sums net payouts by token and counts distinct winning wallets", () => {
    const s = summarizeHistory([
      {
        bounty: bounty({ id: 0 }),
        winners: [
          { claimId: 6, claimer: A, name: "", shareBps: 9200, amount: "26910000" },
          { claimId: 5, claimer: B, name: "", shareBps: 800, amount: "2340000" },
        ],
      },
      {
        bounty: bounty({ id: 1, token: ETH }),
        winners: [
          {
            claimId: 7,
            claimer: A.toUpperCase().replace("0X", "0x") as `0x${string}`,
            name: "",
            shareBps: 10000,
            amount: "1000",
          },
        ],
      },
    ]);
    expect(s.finished).toBe(2);
    expect(s.winners).toBe(2);
    expect(s.paidByToken.get(USDC.toLowerCase())).toBe(29250000n);
    expect(s.paidByToken.get(ETH)).toBe(1000n);
    expect(s.incomplete).toBe(false);
  });

  it("flags totals as incomplete when a finished bounty has no readable winners", () => {
    expect(summarizeHistory([{ bounty: bounty({}), winners: [] }]).incomplete).toBe(true);
  });
});
