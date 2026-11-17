import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { SopaBounty } from "@/lib/poidh-sopa/types";
import {
  handTotals,
  rankHand,
  selectSopaShowcase,
  sopaCode,
  type HandEntry,
  type ShowcaseBounty,
} from "./bounty-hand";

const TEAM = "0x1111111111111111111111111111111111111111" as const;
const STRANGER = "0x2222222222222222222222222222222222222222" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const isTeam = (issuer: string) => issuer.toLowerCase() === TEAM;

function sopa(id: number, opts: Partial<SopaBounty> = {}): SopaBounty {
  return {
    id,
    issuer: STRANGER,
    token: zeroAddress,
    title: `sopa ${id}`,
    description: "",
    amount: "0",
    createdAmount: null,
    paidAmount: null,
    createdAt: 1_000 + id,
    isOpenBounty: true,
    category: "skate",
    status: "open",
    ...opts,
  };
}

function poidh(id: number, eth: number): ShowcaseBounty {
  return {
    bounty: { id } as ShowcaseBounty["bounty"],
    discipline: "skate",
    eth,
  };
}

const ids = (hand: HandEntry[]) =>
  hand.map((e) => (e.kind === "sopa" ? `sopa-${e.sopa.bounty.id}` : `poidh-${e.item.bounty.id}`));

describe("selectSopaShowcase", () => {
  it("keeps open bounties only and parses the reward in token units", () => {
    const out = selectSopaShowcase(
      [
        sopa(0, { token: USDC, amount: "30000000", issuer: TEAM }),
        sopa(1, { status: "paid" }),
        sopa(2, { status: "voting" }),
      ],
      isTeam,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ amount: 30, team: true });
    expect(out[0].token?.symbol).toBe("USDC");
  });
});

describe("rankHand", () => {
  it("puts team bounties first, newest first, whatever their value", () => {
    const hand = rankHand(
      selectSopaShowcase(
        [
          sopa(0, { issuer: TEAM, amount: "1", createdAt: 10 }),
          sopa(1, { issuer: TEAM, amount: "1", createdAt: 20 }),
        ],
        isTeam,
      ),
      [poidh(7, 1)],
      3000,
    );
    expect(ids(hand)).toEqual(["sopa-1", "sopa-0", "poidh-7"]);
  });

  it("ranks community Sopa and poidh bounties together by USD value", () => {
    const hand = rankHand(
      selectSopaShowcase(
        [
          sopa(0, { amount: "1" }), // 1 wei: sinks
          sopa(1, { token: USDC, amount: "50000000" }), // $50
        ],
        isTeam,
      ),
      [poidh(7, 0.02), poidh(8, 0.01)], // $60, $30 at $3000
      3000,
    );
    expect(ids(hand)).toEqual(["poidh-7", "sopa-1", "poidh-8", "sopa-0"]);
  });

  it("without an ETH price, ranks ETH rewards first and the rest after", () => {
    const hand = rankHand(
      selectSopaShowcase([sopa(1, { token: USDC, amount: "50000000" })], isTeam),
      [poidh(8, 0.01), poidh(7, 0.02)],
      0,
    );
    expect(ids(hand)).toEqual(["poidh-7", "poidh-8", "sopa-1"]);
  });
});

describe("handTotals", () => {
  it("sums ETH rewards in ETH and USDC at face value", () => {
    const hand = rankHand(
      selectSopaShowcase(
        [
          sopa(0, { token: USDC, amount: "30000000" }),
          sopa(1, { amount: "10000000000000000" }), // 0.01 ETH
        ],
        isTeam,
      ),
      [poidh(7, 0.02)],
      3000,
    );
    const totals = handTotals(hand);
    expect(totals.eth).toBeCloseTo(0.03);
    expect(totals.stableUsd).toBe(30);
  });
});

describe("sopaCode", () => {
  it("is prefixed so it never matches a poidh code with the same id", () => {
    expect(sopaCode(sopa(5, { category: "skate" }))).toBe("GN-SK8-05");
    expect(sopaCode(sopa(0, { category: "tech" }))).toBe("GN-TECH-00");
    expect(sopaCode(sopa(3, { category: null }))).toBe("GN-GNARS-03");
  });

  it("does not resolve inherited keys from an arbitrary on-chain slug", () => {
    expect(sopaCode(sopa(3, { category: "constructor" }))).toBe("GN-CONST-03");
  });
});
