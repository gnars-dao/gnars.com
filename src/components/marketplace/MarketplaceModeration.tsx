"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWriteAccount } from "@/hooks/use-write-account";
import { BUILDER_CODE } from "@/lib/config";
import { getMarketplaceProtocolAddress } from "@/lib/marketplace/routing";
import { signWalletRequest } from "@/lib/wallet-authorization";
import type {
  CommunityMarketplacePage,
  MarketplaceEligibility,
  MarketplaceOffer,
} from "@/types/marketplace";

const path = "/api/marketplace/community/moderation";

function useModerator() {
  const writer = useWriteAccount();
  const eligibility = useQuery({
    queryKey: ["marketplace", "community", "eligibility", writer?.account.address.toLowerCase()],
    enabled: !!writer,
    queryFn: async ({ signal }): Promise<MarketplaceEligibility> => {
      const response = await fetch(
        `/api/marketplace/community/eligibility?owner=${writer!.account.address}`,
        { signal },
      );
      if (!response.ok) throw new Error("Eligibility unavailable");
      return response.json();
    },
    staleTime: 30_000,
    retry: 1,
  });
  return { writer, canModerate: eligibility.data?.canModerate === true && !eligibility.isError };
}

export function MarketplaceModeration({ offer }: { offer: MarketplaceOffer }) {
  const { writer, canModerate } = useModerator();
  const t = useTranslations("marketplace.moderation");
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);
  const currentWriter = useRef(writer?.account.address);
  useEffect(() => {
    currentWriter.current = writer?.account.address;
  }, [writer?.account.address]);
  if (!writer || !canModerate || !offer.moderation) return null;
  const hidden = offer.moderation.hidden;
  async function submit() {
    if (!writer || !offer.moderation || inFlight.current || !reason.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    const account = writer.account;
    const payload = {
      builderCode: BUILDER_CODE,
      protocolAddress: offer.protocolAddress,
      orderHash: offer.orderHash,
      action: hidden ? "restore" : "hide",
      expectedRevision: offer.moderation.revision,
      reason: reason.trim(),
    };
    try {
      const authorization = await signWalletRequest(account, { method: "POST", path, payload });
      if (currentWriter.current !== account.address) throw new Error("Wallet changed");
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, authorization }),
      });
      if (!response.ok) throw new Error("Moderation rejected");
      setDone(true);
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["marketplace"] });
    } catch {
      setError(true);
      // A lost response may have committed. Refresh the revision before another signature.
      await queryClient.invalidateQueries({ queryKey: ["marketplace"] });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 border-t pt-3">
      {done ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("success")}
        </p>
      ) : !editing ? (
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
          {t(hidden ? "restore" : "hide")}
        </Button>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={`reason-${offer.orderHash}`}>{t("reason")}</Label>
          <Input
            id={`reason-${offer.orderHash}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            disabled={busy}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !reason.trim()}
              onClick={() => void submit()}
            >
              {busy && <LoaderCircle className="size-4 animate-spin" />}
              {t(busy ? "pending" : "confirm")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t("error")}
        </p>
      )}
    </div>
  );
}

export function MarketplaceModerationQueue() {
  const { writer, canModerate } = useModerator();
  const t = useTranslations("marketplace");
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<CommunityMarketplacePage[]>([]);
  const [loadedFor, setLoadedFor] = useState<string>();
  const currentWriter = useRef(writer?.account.address);
  useEffect(() => {
    currentWriter.current = writer?.account.address;
  }, [writer?.account.address]);
  // Query invalidation after a mutation clears the privileged snapshot, never auto-signs.
  const revision = useQuery({
    queryKey: ["marketplace", "moderation-refresh"],
    queryFn: () => Date.now(),
    staleTime: Infinity,
  });
  const [loadedAt, setLoadedAt] = useState<number>();
  const visible = loadedFor === writer?.account.address && loadedAt === revision.data;
  async function load(more = false) {
    if (!writer || busy) return;
    const account = writer.account;
    const nextCursor = more && visible ? cursor : null;
    setBusy(true);
    setError(false);
    try {
      const authorization = await signWalletRequest(account, {
        method: "GET",
        path,
        payload: {
          cursor: nextCursor,
          builderCode: BUILDER_CODE,
          protocolAddress: getMarketplaceProtocolAddress("gnars-contract"),
        },
      });
      if (currentWriter.current !== account.address) throw new Error("Wallet changed");
      const params = new URLSearchParams();
      if (nextCursor) params.set("cursor", nextCursor);
      const response = await fetch(`${path}?${params}`, {
        headers: { "x-wallet-authorization": JSON.stringify(authorization) },
      });
      if (!response.ok) throw new Error("Moderation unavailable");
      const result: CommunityMarketplacePage = await response.json();
      if (currentWriter.current !== account.address || !result.available)
        throw new Error("Moderation unavailable");
      setPages((previous) => (more && visible ? [...previous, result] : [result]));
      setCursor(result.nextCursor);
      setLoadedFor(account.address);
      setLoadedAt(queryClient.getQueryData<number>(["marketplace", "moderation-refresh"]));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  if (!canModerate) return null;
  return (
    <section className="mt-10 space-y-4 border-t pt-6">
      <Button variant="outline" disabled={busy} onClick={() => void load()}>
        {busy ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <ShieldCheck className="size-4" />
        )}
        {t("moderation.hidden")}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t("moderation.error")}
        </p>
      )}
      {visible &&
        pages
          .flatMap((page) => page.items)
          .map((item) => (
            <div
              key={`${item.collectionAddress}:${item.tokenId}:${item.offers[0]?.orderHash}`}
              className="space-y-2 border-b py-4"
            >
              <p className="break-words font-medium">{item.name}</p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {item.collectionAddress} / #{item.tokenId}
              </p>
              {item.offers.map((offer) => (
                <MarketplaceModeration
                  key={`${offer.orderHash}:${offer.moderation?.revision}`}
                  offer={offer}
                />
              ))}
            </div>
          ))}
      {visible && pages.length > 0 && pages.every((page) => page.items.length === 0) && (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      )}
      {visible && cursor && (
        <Button variant="outline" disabled={busy} onClick={() => void load(true)}>
          {t("loadMore")}
        </Button>
      )}
    </section>
  );
}
