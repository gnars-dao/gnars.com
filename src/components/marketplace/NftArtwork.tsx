"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";
import Image from "@/components/ui/content-image";
import type { MarketplaceItem } from "@/types/marketplace";

export function NftArtwork({ item, sizes }: { item: MarketplaceItem; sizes: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-square overflow-hidden bg-muted">
      {item.image && !failed ? (
        <Image
          src={item.image}
          alt={item.name}
          fill
          sizes={sizes}
          className="object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
          <ImageOff className="size-8" aria-hidden="true" />
          <span className="font-mono text-sm">#{item.tokenId}</span>
        </div>
      )}
    </div>
  );
}
