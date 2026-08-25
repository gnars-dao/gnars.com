import { ImageResponse } from "next/og";
import { MorpheusCard, readMorpheusCardData } from "@/lib/og-morpheus";
import { MINIAPP_SIZE } from "@/lib/og-utils";

// The Farcaster embed image for /morpheus (3:2, taller than the 1.91:1 OG).
// Same composition as the link preview — see `src/lib/og-morpheus.tsx`.

export const alt = "Gnars × Morpheus — Stake or Die";
export const size = MINIAPP_SIZE;
export const contentType = "image/png";

// Same 6h reasoning as the OG card: it reads the subnet over RPC, and total
// staked moves slowly enough that a few hours of lag costs nothing.
const CACHE_CONTROL = "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const isPt = locale === "pt-br";
  const data = await readMorpheusCardData(isPt);

  return new ImageResponse(
    (
      <MorpheusCard
        {...data}
        isPt={isPt}
        figureHeight={620}
        padding={64}
        numberSize={140}
        titleSize={42}
      />
    ),
    { ...size, headers: { "Cache-Control": CACHE_CONTROL } },
  );
}
