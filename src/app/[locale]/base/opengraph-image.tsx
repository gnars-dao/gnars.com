import { ImageResponse } from "next/og";
import { OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og-utils";

// Link preview for /base — the pitch page shared with Base ecosystem programs.

export const alt = "Gnars on Base — A Complete Onchain DAO";
export const size = OG_SIZE;
export const contentType = "image/png";

const OG_CACHE_CONTROL = "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";
const BASE_BLUE = "#0052FF";

export default async function Image({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const isPt = locale === "pt-br";

  const labels = {
    eyebrow: isPt ? "CONSTRUÍDO NA BASE · CHAIN 8453" : "BUILT ON BASE · CHAIN 8453",
    title: isPt ? "A Gnars roda inteira na Base" : "Gnars runs entirely on Base",
    features: isPt
      ? ["Leilões diários", "Governança onchain", "Tesouro", "Droposals", "Swap", "Staking"]
      : ["Daily auctions", "Onchain governance", "Treasury", "Droposals", "Swap", "Staking"],
    footer: isPt ? "gnars.com/pt-br/base" : "gnars.com/base",
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
        <div
          style={{
            display: "flex",
            alignSelf: "flex-start",
            backgroundColor: BASE_BLUE,
            color: "#fff",
            borderRadius: "999px",
            padding: "10px 22px",
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: "0.08em",
          }}
        >
          {labels.eyebrow}
        </div>

        <div
          style={{
            fontSize: 76,
            fontWeight: 800,
            color: OG_COLORS.foreground,
            marginTop: "22px",
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
            gap: "14px",
            marginTop: "auto",
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
                padding: "16px 24px",
                fontSize: 26,
                color: OG_COLORS.foreground,
              }}
            >
              {f}
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
          <div>Gnars DAO</div>
          <div>{labels.footer}</div>
        </div>
      </div>
    ),
    { ...size, headers: { "Cache-Control": OG_CACHE_CONTROL } },
  );
}
