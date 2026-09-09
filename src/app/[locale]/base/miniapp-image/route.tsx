import { ImageResponse } from "next/og";
import { BASE_BLUE, baseCardLabels } from "@/lib/og-stake-labels";
import { MINIAPP_SIZE, OG_COLORS, OG_FONTS } from "@/lib/og-utils";

// The Farcaster embed for /base (3:2). The route had no `fc:miniapp` of its
// own, so it inherited the root default and a cast of the Base pitch page
// launched the home mini app behind the generic site card.
//
// Copy is shared with the 1.91:1 link preview via `og-stake-labels`. The chip
// row is capped at a width that breaks it 3 + 3 instead of letting six chips
// wrap 5 + 1 — a lone trailing chip reads as an accident rather than a choice.

export const alt = "Gnars on Base — A Complete Onchain DAO";
export const size = MINIAPP_SIZE;
export const contentType = "image/png";

const CACHE_CONTROL = "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const labels = baseCardLabels(locale === "pt-br");

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
            display: "flex",
            alignSelf: "flex-start",
            backgroundColor: BASE_BLUE,
            color: "#fff",
            borderRadius: "999px",
            padding: "12px 26px",
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: "0.08em",
          }}
        >
          {labels.eyebrow}
        </div>

        <div
          style={{
            fontSize: 84,
            fontWeight: 800,
            color: OG_COLORS.foreground,
            marginTop: "26px",
            lineHeight: 1.05,
            maxWidth: "1000px",
          }}
        >
          {labels.title}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "16px",
            marginTop: "52px",
            maxWidth: "880px",
          }}
        >
          {labels.features.map((f) => (
            <div
              key={f}
              style={{
                display: "flex",
                backgroundColor: OG_COLORS.card,
                border: `2px solid ${OG_COLORS.cardBorder}`,
                borderRadius: "12px",
                padding: "16px 26px",
                fontSize: 27,
                color: OG_COLORS.foreground,
              }}
            >
              {f}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", fontSize: 22, color: OG_COLORS.muted, marginTop: "44px" }}>
          {labels.footer}
        </div>
      </div>
    ),
    { ...size, headers: { "Cache-Control": CACHE_CONTROL } },
  );
}
