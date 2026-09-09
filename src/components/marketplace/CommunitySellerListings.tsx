"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMarketplaceActions } from "@/hooks/use-marketplace-actions";
import { useWriteAccount } from "@/hooks/use-write-account";
import { Link } from "@/i18n/navigation";
import { BUILDER_CODE } from "@/lib/config";
import { formatMarketplacePrice } from "@/lib/marketplace-display";
import { getMarketplaceProtocolAddress } from "@/lib/marketplace/routing";
import { signWalletRequest } from "@/lib/wallet-authorization";
import type {
  CommunityMarketplacePage,
  MarketplaceItem,
  MarketplaceOffer,
} from "@/types/marketplace";
import { NftArtwork } from "./NftArtwork";

const path = "/api/marketplace/community/manage";

export function CommunitySellerListings() {
  const writer = useWriteAccount();
  return writer ? <SellerListings key={writer.account.address.toLowerCase()} /> : null;
}

function SellerListings() {
  const writer = useWriteAccount();
  const actions = useMarketplaceActions();
  const t = useTranslations("marketplace");
  const queries = useQueryClient();
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (actions.phase === "complete" && actions.recovery?.kind === "cancel") {
      setItems([]);
      setLoaded(false);
      setCursor(null);
    }
  }, [actions.phase, actions.recovery?.kind]);
  const unresolved =
    !!actions.invalidJournal ||
    actions.canResume ||
    actions.canCancelSavedListing ||
    actions.isBusy;
  async function load(more = false) {
    if (!writer || inFlight.current || unresolved) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    try {
      const nextCursor = more ? cursor : null;
      const authorization = await signWalletRequest(writer.account, {
        method: "GET",
        path,
        payload: {
          cursor: nextCursor,
          builderCode: BUILDER_CODE,
          protocolAddress: getMarketplaceProtocolAddress("gnars-contract"),
        },
      });
      if (!active.current) return;
      const params = new URLSearchParams();
      if (nextCursor) params.set("cursor", nextCursor);
      const response = await fetch(`${path}?${params}`, {
        headers: { "x-wallet-authorization": JSON.stringify(authorization) },
      });
      if (!response.ok) throw new Error("Seller listings unavailable");
      const result: CommunityMarketplacePage = await response.json();
      if (!result.available) throw new Error("Seller listings unavailable");
      if (!active.current) return;
      setItems((previous) => {
        const grouped = new Map<string, MarketplaceItem>();
        for (const item of [...(more ? previous : []), ...result.items]) {
          const key = `${item.collectionAddress?.toLowerCase()}:${item.tokenId}`;
          const old = grouped.get(key);
          grouped.set(key, {
            ...item,
            offers: [
              ...new Map(
                [...(old?.offers ?? []), ...item.offers].map((offer) => [offer.orderHash, offer]),
              ).values(),
            ],
          });
        }
        return [...grouped.values()];
      });
      setCursor(result.nextCursor);
      setLoaded(true);
    } catch {
      if (active.current) setError(true);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function cancel(offer: MarketplaceOffer, tokenId: string) {
    if (busy || unresolved) return;
    await actions.cancel(offer, tokenId);
    setConfirm(null);
    void queries.invalidateQueries({ queryKey: ["marketplace"] });
  }
  return (
    <section className="mt-10 space-y-5 border-t pt-6">
      <h2 className="text-lg font-semibold">{t("sections.community")}</h2>
      <Button variant="outline" disabled={busy || unresolved} onClick={() => void load()}>
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        {t("community.manage")}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t("community.managementError")}
        </p>
      )}
      {loaded && !items.length && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
      {items.map((item) => (
        <div key={`${item.collectionAddress}:${item.tokenId}`} className="flex gap-4 border-b pb-5">
          <div className="w-20 shrink-0 self-start overflow-hidden rounded-md">
            <NftArtwork item={item} sizes="80px" loading="eager" />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <p className="break-words font-medium">{item.name}</p>
            <Link
              href={`/members/${item.collectionAddress}`}
              className="block break-all font-mono text-xs text-muted-foreground underline underline-offset-4"
            >
              {item.collectionAddress} / #{item.tokenId}
            </Link>
            {item.offers.map((offer) => (
              <div key={offer.orderHash} className="space-y-2">
                <p
                  className="font-mono text-sm"
                  title={`${formatMarketplacePrice(offer.priceWei).exact} ETH`}
                >
                  {formatMarketplacePrice(offer.priceWei).display} ETH
                </p>
                {offer.moderation?.hidden && (
                  <p className="text-xs text-muted-foreground">{t("moderation.hidden")}</p>
                )}
                {confirm === offer.orderHash ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || unresolved}
                      onClick={() => void cancel(offer, item.tokenId)}
                    >
                      <X className="size-4" />
                      {t("cancel")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || unresolved}
                      onClick={() => setConfirm(null)}
                    >
                      {t("back")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || unresolved}
                    onClick={() => setConfirm(offer.orderHash)}
                  >
                    <X className="size-4" />
                    {t("cancel")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {cursor && (
        <Button variant="outline" disabled={busy || unresolved} onClick={() => void load(true)}>
          <ArrowDown className="size-4" />
          {t("loadMore")}
        </Button>
      )}
    </section>
  );
}
