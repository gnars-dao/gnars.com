"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { MarketplaceItem } from "@/types/marketplace";
import { NftArtwork } from "./NftArtwork";

export function NftVideo({ item }: { item: MarketplaceItem }) {
  const t = useTranslations("marketplace");
  const [failed, setFailed] = useState(false);
  return (
    <div>
      <div className="relative aspect-square overflow-hidden bg-muted">
        <NftArtwork item={item} sizes="(max-width: 767px) 36vh, 512px" />
        {!failed && item.animationUrl && (
          <video
            src={item.animationUrl}
            poster={item.image ?? undefined}
            aria-label={t("nftVideo", { name: item.name })}
            controls
            playsInline
            preload="none"
            className="absolute inset-0 size-full bg-black object-contain"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      {failed && (
        <p role="status" className="px-1 pt-2 text-sm text-muted-foreground">
          {t("videoUnavailable")}
        </p>
      )}
    </div>
  );
}
