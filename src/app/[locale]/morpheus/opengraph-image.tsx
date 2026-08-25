import { ImageResponse } from "next/og";
import { MorpheusCard, readMorpheusCardData } from "@/lib/og-morpheus";
import { OG_SIZE } from "@/lib/og-utils";

// The link preview for /morpheus — the URL the Morpheus subnet bio points at
// and the one every campaign piece links. Without this file the route served no
// og:image at all, so posts rendered a bare card.
//
// The layout is shared with the Farcaster embed at /morpheus/miniapp-image; see
// `src/lib/og-morpheus.tsx`.

export const alt = "Gnars × Morpheus — Stake or Die";
export const size = OG_SIZE;
export const contentType = "image/png";

// 6h at the edge, not 30min: this card reads the subnet over RPC, so every
// revalidation costs a function invocation that sits waiting on the network —
// runtime CPU, the axis that actually blows the quota. Total staked moves
// slowly; a preview that lags a few hours costs nothing and saves 12x the
// renders.
const OG_CACHE_CONTROL = "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";

export default async function Image({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const isPt = locale === "pt-br";
  const data = await readMorpheusCardData(isPt);

  return new ImageResponse(
    (
      <MorpheusCard
        {...data}
        isPt={isPt}
        height={size.height}
        figureHeight={431}
        padding={56}
        titleSize={54}
      />
    ),
    { ...size, headers: { "Cache-Control": OG_CACHE_CONTROL } },
  );
}
