import { ImageResponse } from "next/og";
import { getGnarsSubnetTotalStaked } from "@/lib/morpheus-builder";
import { OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og-utils";
import { nextMilestone } from "@/lib/stake-milestones";

// The link preview for /morpheus — the URL the Morpheus subnet bio points at
// and the one every campaign piece links. Without this file the route served no
// og:image at all, so posts rendered a bare card.

export const alt = "Gnars × Morpheus — Stake or Die";
export const size = OG_SIZE;
export const contentType = "image/png";

// 6h at the edge, not 30min: this card reads the subnet over RPC, so every
// revalidation costs a function invocation that sits waiting on the network —
// runtime CPU, the axis that actually blows the quota. Total staked moves
// slowly; a preview that lags a few hours costs nothing and saves 12x the
// renders.
const OG_CACHE_CONTROL = "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";
const MOR_GREEN = "#2be58b";

export default async function Image({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const isPt = locale === "pt-br";

  // A failed read renders as a dash, never as "0 MOR" — an empty subnet is a
  // very different claim from an unreadable one.
  let staked: number | null = null;
  try {
    staked = await getGnarsSubnetTotalStaked();
  } catch (error) {
    console.error("[morpheus OG] subnet read failed:", error);
  }

  const next = staked == null ? null : nextMilestone(staked);
  const stakedLabel =
    staked == null ? "—" : Math.floor(staked).toLocaleString(isPt ? "pt-BR" : "en-US");
  const nextLabel = next == null ? "—" : next.amountMor.toLocaleString(isPt ? "pt-BR" : "en-US");

  const labels = {
    eyebrow: "GNARS × MORPHEUS",
    title: isPt ? "A Gnars constrói na Morpheus" : "Gnars builds on Morpheus",
    sub: isPt
      ? "Faça stake de MOR na subnet Gnars Builder"
      : "Stake MOR into the Gnars Builder subnet",
    staked: isPt ? "MOR em stake" : "MOR staked",
    next: isPt ? "Próximo marco" : "Next milestone",
    footer: isPt ? "gnars.com/pt-br/morpheus" : "gnars.com/morpheus",
  };

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: OG_COLORS.background,
          fontFamily: OG_FONTS.family,
          padding: "60px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: MOR_GREEN,
              letterSpacing: "0.12em",
            }}
          >
            {labels.eyebrow}
          </div>
          <div
            style={{
              fontSize: 68,
              fontWeight: 800,
              color: OG_COLORS.foreground,
              marginTop: "14px",
              lineHeight: 1.05,
            }}
          >
            {labels.title}
          </div>
          <div style={{ fontSize: 30, color: OG_COLORS.mutedLight, marginTop: "14px" }}>
            {labels.sub}
          </div>
        </div>

        <div style={{ display: "flex", gap: "28px", marginTop: "auto" }}>
          <div
            style={{
              flex: 1,
              backgroundColor: OG_COLORS.card,
              borderRadius: "16px",
              border: `2px solid ${OG_COLORS.cardBorder}`,
              padding: "32px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ fontSize: 22, color: OG_COLORS.muted }}>{labels.staked}</div>
            <div style={{ fontSize: 72, fontWeight: 800, color: MOR_GREEN, marginTop: "6px" }}>
              {stakedLabel}
            </div>
          </div>
          <div
            style={{
              flex: 1,
              backgroundColor: OG_COLORS.card,
              borderRadius: "16px",
              border: `2px solid ${OG_COLORS.cardBorder}`,
              padding: "32px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ fontSize: 22, color: OG_COLORS.muted }}>{labels.next}</div>
            <div
              style={{
                fontSize: 72,
                fontWeight: 800,
                color: OG_COLORS.accentYellow,
                marginTop: "6px",
              }}
            >
              {nextLabel}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: "36px",
            fontSize: 20,
            color: OG_COLORS.muted,
          }}
        >
          <div>Gnars DAO · Base</div>
          <div>{labels.footer}</div>
        </div>
      </div>
    ),
    { ...size, headers: { "Cache-Control": OG_CACHE_CONTROL } },
  );
}
