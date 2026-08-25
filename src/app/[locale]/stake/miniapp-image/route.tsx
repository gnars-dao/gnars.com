import { ImageResponse } from "next/og";
import { MOR_GREEN, STAKE_GOLD, stakeCardLabels } from "@/lib/og-stake-labels";
import { MINIAPP_SIZE, OG_COLORS, OG_FONTS } from "@/lib/og-utils";

// The Farcaster embed for /stake (3:2). Until this existed the route declared
// an embed pointing at the generic site card, so a cast of the campaign's main
// call to action showed the Gnars logo and "Nounish Open Source Action Sports
// Brand experiment" — the button said "Stake or Die", the image never did.
//
// Copy is shared with the 1.91:1 link preview via `og-stake-labels`; the layout
// is not. This canvas is 170px taller and the wide card's rhythm (title up top,
// blocks pushed to the floor) leaves a dead band in the middle when stretched
// into it, so here the content is centred as one block.

export const alt = "Stake or Die — Gnars";
export const size = MINIAPP_SIZE;
export const contentType = "image/png";

const CACHE_CONTROL = "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const labels = stakeCardLabels(locale === "pt-br");

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          backgroundColor: OG_COLORS.background,
          fontFamily: OG_FONTS.family,
          padding: "72px",
        }}
      >
        <div
          style={{
            fontSize: 116,
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
            fontSize: 32,
            color: OG_COLORS.mutedLight,
            marginTop: "22px",
            maxWidth: "940px",
          }}
        >
          {labels.sub}
        </div>

        <div style={{ display: "flex", gap: "28px", marginTop: "56px" }}>
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
              <div style={{ fontSize: 36, fontWeight: 700, color: card.c }}>{card.t}</div>
              <div style={{ fontSize: 23, color: OG_COLORS.muted, marginTop: "10px" }}>
                {card.d}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", fontSize: 22, color: OG_COLORS.muted, marginTop: "40px" }}>
          {labels.footer}
        </div>
      </div>
    ),
    { ...size, headers: { "Cache-Control": CACHE_CONTROL } },
  );
}
