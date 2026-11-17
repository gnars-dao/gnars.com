import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POIDH_SOPA } from "@/lib/config";
import type { SopaBounty } from "@/lib/poidh-sopa/types";
import type { PoidhBounty } from "@/types/poidh";
import enBounties from "../../../messages/en/bounties.json";
import enHome from "../../../messages/en/newhome.json";
import ptBounties from "../../../messages/pt-br/bounties.json";
import ptHome from "../../../messages/pt-br/newhome.json";
import { BountiesSection } from "./BountiesSection";

vi.mock("@/i18n/navigation", () => ({ Link: "a" }));

// Query state per test: each source can be loaded, loading or failed on its own.
type Query<T> = { data: T | undefined; isLoading: boolean; isError: boolean };
const state: {
  poidh: Query<{ bounties: PoidhBounty[] }>;
  sopa: Query<{ bounties: SopaBounty[]; error: null }>;
  ethPrice: number;
} = {
  poidh: { data: undefined, isLoading: false, isError: false },
  sopa: { data: undefined, isLoading: false, isError: false },
  ethPrice: 3000,
};

vi.mock("@/hooks/usePoidhBounties", () => ({ usePoidhBounties: () => state.poidh }));
vi.mock("@/hooks/use-poidh-sopa-bounties", () => ({ usePoidhSopaBounties: () => state.sopa }));
vi.mock("@/hooks/use-eth-price", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-eth-price")>()),
  useEthPrice: () => ({ ethPrice: state.ethPrice }),
}));

const TEAM = POIDH_SOPA.teamIssuers[0];
const STRANGER = "0x2222222222222222222222222222222222222222" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const NOW = Math.floor(Date.now() / 1000);

function sopa(id: number, opts: Partial<SopaBounty> = {}): SopaBounty {
  return {
    id,
    issuer: STRANGER,
    token: USDC,
    title: `Sopa bounty ${id}`,
    description: "![](https://example.com/a.png)\n[](https://example.com/b.png)\nLand it.",
    amount: "30000000",
    createdAmount: "30000000",
    paidAmount: null,
    createdAt: NOW - 86_400,
    isOpenBounty: true,
    category: "tech",
    status: "open",
    ...opts,
  };
}

function poidh(id: number, eth: string, title = `Skate trick ${id}`): PoidhBounty {
  return {
    id,
    onChainId: id,
    chainId: 8453,
    title: `${title} skateboard kickflip`,
    name: title,
    description: "skate",
    amount: (BigInt(Math.round(Number(eth) * 1e6)) * 10n ** 12n).toString(),
    issuer: STRANGER,
    createdAt: NOW - 2 * 86_400,
    inProgress: true,
    isJoinedBounty: false,
    isCanceled: false,
    isMultiplayer: false,
    isVoting: false,
    deadline: null,
    amountSort: 0,
    hasClaims: false,
    hasParticipants: false,
  };
}

const loaded = <T,>(data: T): Query<T> => ({ data, isLoading: false, isError: false });
const failed = <T,>(): Query<T> => ({ data: undefined, isLoading: false, isError: true });
const loading = <T,>(): Query<T> => ({ data: undefined, isLoading: true, isError: false });

const catalogs = [
  { locale: "en", home: enHome, bounties: enBounties },
  { locale: "pt-br", home: ptHome, bounties: ptBounties },
] as const;

describe.each(catalogs)("BountiesSection ($locale)", ({ locale, home, bounties }) => {
  const t = home.bounties;
  const unavailable = home.dataUnavailable;

  function render() {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale={locale}
        messages={{ newhome: home, bounties }}
        timeZone="UTC"
        onError={(e) => {
          throw e;
        }}
      >
        <BountiesSection />
      </NextIntlClientProvider>,
    );
    // The fan and the phone row render the same hand; count cards in the row only.
    const row = html.slice(html.lastIndexOf("snap-x"));
    return { html, row, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") };
  }

  beforeEach(() => {
    state.poidh = loaded({ bounties: [poidh(235, "0.023"), poidh(1453, "0.0115")] });
    state.sopa = loaded({ bounties: [], error: null });
    state.ethPrice = 3000;
  });

  it("shows a team Sopa bounty first, with the team mark, a GN- code and an on-site claim link", () => {
    state.sopa = loaded({
      bounties: [sopa(0, { issuer: TEAM, amount: "1000000" })], // 1 USDC, still first
      error: null,
    });
    const { html, row, text } = render();
    expect(text).toContain(t.card.team);
    expect(text).toContain("GN-TECH-00");
    expect(text).toContain(t.card.typeSopa);
    // Rank order on the phone row: the team card leads.
    expect(row.indexOf("Sopa bounty 0")).toBeLessThan(row.indexOf("Skate trick 235"));
    expect(html).toContain('href="/community/bounties/sopa/0"');
    expect(html).not.toContain("poidh.xyz/base/bounty/0");
    // poidh cards still claim on poidh.xyz.
    expect(html).toContain('href="https://poidh.xyz/base/bounty/235"');
    expect(text).toContain("USDC");
  });

  it("does not mark or lead with a stranger's bounty; it ranks by value", () => {
    state.sopa = loaded({ bounties: [sopa(1, { amount: "1" })], error: null }); // 0.000001 USDC
    const { row, text } = render();
    expect(text).not.toContain(t.card.team);
    expect(row.indexOf("Skate trick 235")).toBeLessThan(row.indexOf("Sopa bounty 1"));
    expect(row.indexOf("Skate trick 1453")).toBeLessThan(row.indexOf("Sopa bounty 1"));
  });

  it("strips markdown images, bare or not, from the card back", () => {
    state.sopa = loaded({ bounties: [sopa(0, { issuer: TEAM })], error: null });
    const { html } = render();
    expect(html).not.toContain("example.com/a.png");
    expect(html).not.toContain("example.com/b.png");
    expect(html).toContain("Land it.");
  });

  it("totals both sources: ETH pool, count, and USD with USDC at face value", () => {
    state.sopa = loaded({ bounties: [sopa(0, { issuer: TEAM })], error: null });
    const { text } = render();
    expect(text).toContain("0.03 ETH"); // 0.023 + 0.0115 rounded
    // 0.0345 ETH × 3000 + 30 USDC = $133.50
    expect(text).toMatch(/133[.,]50/);
    expect(text).toMatch(new RegExp(`3 ${t.stats.open}`, "i"));
  });

  it("shows the USD total for a USDC-only pool even without an ETH price", () => {
    state.poidh = loaded({ bounties: [] });
    state.sopa = loaded({ bounties: [sopa(0, { issuer: TEAM })], error: null });
    state.ethPrice = 0;
    const { text } = render();
    expect(text).toMatch(/30[.,]00/);
    expect(text).not.toContain(unavailable);
  });

  it("reads the USD total as unavailable when ETH is in the pool and there is no price", () => {
    state.ethPrice = 0;
    const { text } = render();
    expect(text).toContain(unavailable);
  });

  it("keeps Sopa cards when poidh fails, with a notice, and totals unavailable", () => {
    state.poidh = failed();
    state.sopa = loaded({ bounties: [sopa(0, { issuer: TEAM })], error: null });
    const { text } = render();
    expect(text).toContain("Sopa bounty 0");
    expect(text).toContain(t.partial.poidh);
    expect(text).not.toContain(home.gov.loadFailed);
    expect(text).not.toContain("0.00 ETH");
    expect(text).toContain(unavailable);
  });

  it("keeps poidh cards when Sopa fails, with a notice, and totals unavailable", () => {
    state.sopa = failed();
    const { text } = render();
    expect(text).toContain("Skate trick 235");
    expect(text).toContain(t.partial.sopa);
    expect(text).toContain(unavailable);
    expect(text).not.toContain("0.03 ETH");
  });

  it("shows the load-failed message only when both sources fail", () => {
    state.poidh = failed();
    state.sopa = failed();
    const { text } = render();
    expect(text).toContain(home.gov.loadFailed);
    expect(text).not.toContain(t.partial.poidh);
  });

  it("shows pending tiles, not zeros, while Sopa is still loading", () => {
    state.sopa = loading();
    const { text } = render();
    expect(text).toContain("Skate trick 235");
    expect(text).not.toContain("0.03 ETH");
    expect(text).not.toContain(unavailable);
    expect(text).not.toContain(t.partial.sopa);
  });

  it("renders the empty state with zero totals when nothing is open", () => {
    state.poidh = loaded({ bounties: [] });
    const { text } = render();
    expect(text).toContain("0.00 ETH");
    expect(text).toContain(t.empty);
  });

  it("keeps the hand at six cards and serials over the full count", () => {
    state.poidh = loaded({
      bounties: Array.from({ length: 7 }, (_, i) => poidh(100 + i, `0.0${i + 1}`)),
    });
    state.sopa = loaded({ bounties: [sopa(0, { issuer: TEAM })], error: null });
    const { row, text } = render();
    expect(row.match(/snap-center/g)).toHaveLength(6);
    expect(text).toContain("001 / 008");
    expect(text).not.toContain("007 / 008");
  });
});
