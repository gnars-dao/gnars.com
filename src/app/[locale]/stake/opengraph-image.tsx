import { ImageResponse } from "next/og";
import { MOR_GREEN, STAKE_GOLD, stakeCardLabels } from "@/lib/og-stake-labels";
import { OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og-utils";

// Link preview for /stake — the URL every campaign piece calls to action.
// Deliberately static: this card is shared far more often than it is rebuilt,
// and a chain read here would put an RPC in the path of every crawler hit.

export const alt = "Stake or Die — Gnars";
export const size = OG_SIZE;
export const contentType = "image/png";

const OG_CACHE_CONTROL = "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";

export default async function Image({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const isPt = locale === "pt-br";

  const labels = stakeCardLabels(isPt);

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
        <div
          style={{
            fontSize: 96,
            fontWeight: 800,
            color: STAKE_GOLD,
            lineHeight: 1,
            letterSpacing: "-0.02em",
          }}
        >
          {labels.title}
        </div>
        <div
          style={{
            fontSize: 30,
            color: OG_COLORS.mutedLight,
            marginTop: "18px",
            maxWidth: "900px",
          }}
        >
          {labels.sub}
        </div>

        <div style={{ display: "flex", gap: "28px", marginTop: "auto" }}>
          {[
            { t: labels.a, d: labels.aDesc, c: STAKE_GOLD },
            { t: labels.b, d: labels.bDesc, c: MOR_GREEN },
          ].map((card) => (
            <div
              key={card.t}
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
              <div style={{ fontSize: 34, fontWeight: 700, color: card.c }}>{card.t}</div>
              <div style={{ fontSize: 22, color: OG_COLORS.muted, marginTop: "10px" }}>
                {card.d}
              </div>
            </div>
          ))}
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
