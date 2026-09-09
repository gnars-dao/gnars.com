import Image from "@/components/ui/content-image";
import type { MarketplaceSource } from "@/types/marketplace";

export function MarketplaceSourceLogo({ source }: { source: MarketplaceSource }) {
  if (source === "gnars") {
    return (
      <span
        aria-hidden="true"
        className="size-6 shrink-0 rounded-sm bg-[url('/logos/seaport-brand.avif')] bg-[length:800%_auto] bg-[position:28%_50%]"
      />
    );
  }
  return (
    <Image
      src={source === "opensea" ? "/logos/opensea.png" : "/gnars.webp"}
      alt=""
      width={24}
      height={24}
      className="size-6 shrink-0 rounded-sm object-contain"
    />
  );
}
