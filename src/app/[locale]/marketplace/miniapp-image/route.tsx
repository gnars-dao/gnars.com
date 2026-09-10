import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getTranslations } from "next-intl/server";
import { ImageResponse } from "next/og";
import { parseMarketplaceShareQuery } from "@/lib/marketplace/share";
import { MINIAPP_SIZE } from "@/lib/og-utils";
import { getMarketplaceShareData, loadMarketplaceShareArtwork } from "@/services/marketplace-share";

export const runtime = "nodejs";

async function localImage(filename: "marketplace-og-v1.jpg" | "gnars-splash-200.png") {
  const bytes = await readFile(join(process.cwd(), "public", filename));
  return `data:image/${filename.endsWith("jpg") ? "jpeg" : "png"};base64,${bytes.toString("base64")}`;
}

async function renderGeneric(fallback: boolean) {
  const cover = await localImage("marketplace-og-v1.jpg");
  const result = new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          background: "#080808",
          alignItems: "center",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={cover} alt="Gnars Marketplace" width={1200} height={630} />
      </div>
    ),
    MINIAPP_SIZE,
  );
  return new Response(await result.arrayBuffer(), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": fallback
        ? "public, max-age=0, s-maxage=10"
        : "public, max-age=3600, s-maxage=86400",
    },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const query = new URL(request.url).searchParams;
  const target = parseMarketplaceShareQuery(
    Object.fromEntries(
      [...new Set(query.keys())].map((key) => {
        const values = query.getAll(key);
        return [key, values.length === 1 ? values[0] : values];
      }),
    ),
  );
  if (!target) return renderGeneric(false);
  try {
    const data = await getMarketplaceShareData(target);
    if (!data) return renderGeneric(true);
    const t = await getTranslations({ locale, namespace: "marketplace" });
    const artwork = await loadMarketplaceShareArtwork(data.image);
    const logo = await localImage("gnars-splash-200.png");
    const result = new ImageResponse(
      (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            background: "#0a0a0a",
            color: "#fafafa",
            fontFamily: "sans-serif",
            padding: "48px",
            letterSpacing: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18, height: 52 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logo} alt="" width={44} height={44} />
            <span style={{ fontSize: 28, fontWeight: 700 }}>Gnars Marketplace</span>
            <span style={{ marginLeft: "auto", color: "#8baeff", fontSize: 22 }}>Base</span>
          </div>
          <div
            style={{
              display: "flex",
              gap: 42,
              alignItems: "center",
              flex: 1,
              marginTop: 32,
              marginBottom: 28,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={artwork ?? logo}
              alt=""
              width={552}
              height={552}
              style={{ objectFit: "contain", borderRadius: 8, background: "#141414" }}
            />
            <div style={{ display: "flex", flexDirection: "column", width: 510, gap: 28 }}>
              <div
                style={{
                  display: "flex",
                  fontSize: data.name.length > 36 ? 44 : 60,
                  fontWeight: 700,
                  lineHeight: 1.12,
                  overflowWrap: "anywhere",
                }}
              >
                {data.name}
              </div>
              {data.price ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ display: "flex", fontSize: 48, fontWeight: 700, color: "#f8d94f" }}>
                    {data.price}
                  </div>
                  <div style={{ display: "flex", fontSize: 24, color: "#a4b4aa" }}>
                    {data.source === "opensea"
                      ? "OpenSea"
                      : data.source === "gnars"
                        ? "Seaport"
                        : "Gnars"}
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", fontSize: 26, color: "#aaa" }}>
                  {t("share.unavailable")}
                </div>
              )}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              borderTop: "1px solid #383838",
              paddingTop: 18,
              fontSize: 21,
              color: "#aaa",
            }}
          >
            <span>gnars.com</span>
            <span>{t("share.openNft")}</span>
          </div>
        </div>
      ),
      MINIAPP_SIZE,
    );
    return new Response(await result.arrayBuffer(), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": artwork
          ? "public, max-age=60, s-maxage=60, stale-while-revalidate=300"
          : "public, max-age=0, s-maxage=10",
      },
    });
  } catch {
    return renderGeneric(true);
  }
}
