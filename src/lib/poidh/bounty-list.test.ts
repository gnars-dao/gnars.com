import { describe, expect, it } from "vitest";
import type { PoidhSopaToken } from "@/lib/config";
import type { SopaBounty } from "@/lib/poidh-sopa/types";
import type { PoidhBounty } from "@/types/poidh";
import {
  filterCommunityBounties,
  filterTeamBounties,
  markdownPreview,
  mergeNewest,
  summarizePool,
} from "./bounty-list";

const ETH = "0x0000000000000000000000000000000000000000" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const OTHER = "0x1111111111111111111111111111111111111111" as const;
const TOKENS: PoidhSopaToken[] = [
  { symbol: "ETH", address: ETH, decimals: 18 },
  { symbol: "USDC", address: USDC, decimals: 6, usdStable: true },
  { symbol: "GNAR", address: OTHER, decimals: 18 },
];

function sopa(overrides: Partial<SopaBounty>): SopaBounty {
  return {
    id: 0,
    issuer: ETH,
    token: ETH,
    title: "Bounty",
    description: "",
    amount: "0",
    createdAmount: null,
    paidAmount: null,
    createdAt: 0,
    isOpenBounty: true,
    category: "skate",
    status: "open",
    ...overrides,
  };
}

function poidh(overrides: Partial<PoidhBounty>): PoidhBounty {
  return {
    id: 1,
    chainId: 8453,
    title: "Bounty",
    description: "",
    amount: "0",
    createdAt: 0,
    ...overrides,
  } as PoidhBounty;
}

describe("filterTeamBounties", () => {
  const list = [
    sopa({ id: 1, status: "open", title: "Gnars x Nouns Mini App", category: "tech" }),
    sopa({ id: 2, status: "paid", title: "Stylish Ollie" }),
    sopa({ id: 3, status: "cancelled", title: "Old one" }),
    sopa({ id: 4, status: "voting", title: "Kickflip line" }),
  ];
  const ids = (b: SopaBounty[]) => b.map((x) => x.id);

  it("maps each status tab to its Sopa statuses", () => {
    expect(ids(filterTeamBounties(list, { status: "open", query: "" }))).toEqual([1]);
    expect(ids(filterTeamBounties(list, { status: "voting", query: "" }))).toEqual([4]);
    expect(ids(filterTeamBounties(list, { status: "closed", query: "" }))).toEqual([2, 3]);
    expect(ids(filterTeamBounties(list, { status: "all", query: "" }))).toEqual([1, 2, 3, 4]);
  });

  it("searches title and description, case- and whitespace-insensitive", () => {
    expect(ids(filterTeamBounties(list, { status: "all", query: "  OLLIE " }))).toEqual([2]);
  });
});

describe("filterCommunityBounties", () => {
  const list = [
    poidh({ id: 1, title: "impossible late flip for poidh" }),
    poidh({ id: 2, title: "Teach someone bitcoin", description: "post it on YouTube" }),
    poidh({ id: 3, title: "Get barreled on a glassy wave" }),
  ];
  const ids = (b: PoidhBounty[]) => b.map((x) => x.id);

  it("files bounties by the shared discipline classifier", () => {
    expect(ids(filterCommunityBounties(list, { query: "", category: "skate" }))).toEqual([1]);
    // "tube" inside "YouTube" used to file this under surf.
    expect(ids(filterCommunityBounties(list, { query: "", category: "surf" }))).toEqual([3]);
    // "flip" alone no longer puts a skate trick under parkour.
    expect(ids(filterCommunityBounties(list, { query: "", category: "parkour" }))).toEqual([]);
  });

  it("keeps everything under 'all' and still applies the search", () => {
    expect(ids(filterCommunityBounties(list, { query: "", category: "all" }))).toEqual([1, 2, 3]);
    expect(ids(filterCommunityBounties(list, { query: "bitcoin", category: "all" }))).toEqual([2]);
  });
});

describe("summarizePool", () => {
  const ONE_ETH = 10n ** 18n;

  it("adds POIDH and Sopa ETH, and stablecoins at face value", () => {
    const pool = summarizePool(
      [poidh({ amount: (ONE_ETH / 2n).toString() })],
      [
        sopa({ token: ETH, amount: (ONE_ETH / 2n).toString() }),
        sopa({ token: USDC, amount: "30000000" }),
      ],
      2000,
      TOKENS,
    );
    expect(pool.totalWei).toBe(ONE_ETH);
    expect(pool.usd).toBe(2030);
    expect(pool.count).toBe(3);
    expect(pool.others).toEqual([{ token: TOKENS[1], raw: 30_000_000n }]);
  });

  it("lists non-stable tokens without counting them in dollars", () => {
    const pool = summarizePool(
      [],
      [sopa({ token: OTHER, amount: ONE_ETH.toString() })],
      2000,
      TOKENS,
    );
    expect(pool.usd).toBe(0);
    expect(pool.others.map((o) => o.token.symbol)).toEqual(["GNAR"]);
  });

  it("has no dollar value when there is ETH and no price, never a smaller one", () => {
    const pool = summarizePool(
      [poidh({ amount: ONE_ETH.toString() })],
      [sopa({ token: USDC, amount: "30000000" })],
      0,
      TOKENS,
    );
    expect(pool.usd).toBeNull();
  });

  it("still prices a stablecoin-only pool without an ETH price", () => {
    expect(summarizePool([], [sopa({ token: USDC, amount: "5000000" })], 0, TOKENS).usd).toBe(5);
  });

  it("uses the paid-out amount once a Sopa bounty is closed", () => {
    const pool = summarizePool(
      [],
      [
        sopa({
          status: "paid",
          amount: "0",
          createdAmount: "1000000",
          paidAmount: "7000000",
          token: USDC,
        }),
      ],
      0,
      TOKENS,
    );
    expect(pool.usd).toBe(7);
  });
});

describe("markdownPreview", () => {
  it("drops images, alt text included", () => {
    expect(markdownPreview("![seattle poidh sticker](https://x.io/a.png) find it")).toBe("find it");
  });

  it("keeps link text and drops empty links", () => {
    expect(
      markdownPreview("Reward: 30 USDC [](https://x.io/a.png) see [the rules](https://x.io)"),
    ).toBe("Reward: 30 USDC see the rules");
  });

  it("keeps URLs with parentheses in one piece", () => {
    expect(
      markdownPreview("[Ollie](https://en.wikipedia.org/wiki/Ollie_(skateboarding)) now"),
    ).toBe("Ollie now");
  });

  it("strips emphasis and headings and collapses whitespace", () => {
    expect(markdownPreview("*🎁 Lil' Gnarly*\n\n## Goal\n\nLand a **clean** ollie")).toBe(
      "🎁 Lil' Gnarly Goal Land a clean ollie",
    );
  });
});

describe("mergeNewest", () => {
  it("interleaves lists newest first and keeps the first `limit`", () => {
    const merged = mergeNewest(
      [
        [{ createdAt: 5 }, { createdAt: 1 }],
        [{ createdAt: 4 }],
        [{ createdAt: 9 }, { createdAt: 2 }],
      ],
      4,
    );
    expect(merged.map((x) => x.createdAt)).toEqual([9, 5, 4, 2]);
  });
});
