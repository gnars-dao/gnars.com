"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Pencil, RefreshCw, Tag, X } from "lucide-react";
import { formatEther, type Address } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMarketplaceActions } from "@/hooks/use-marketplace-actions";
import { useWriteAccount } from "@/hooks/use-write-account";
import { DAO_ADDRESSES } from "@/lib/config";
import { parseMarketplacePrice } from "@/lib/marketplace-display";
import {
  completedListingEdit,
  LISTING_EDIT_EVENT,
  listingEditDraftSchema,
  listingEditKey,
  matchesCompletedListingEdit,
  notifyListingEditChanged,
  readListingEditDraft,
  validateListingEditInput,
  type ListingEditDraft,
} from "@/lib/marketplace/listing-edit";
import type {
  MarketplaceEligibility,
  MarketplaceItem,
  MarketplaceOffer,
} from "@/types/marketplace";
import { MarketplaceRecovery } from "./MarketplaceRecovery";

export function MarketplaceListingEditor({
  item,
  offer,
}: {
  item: MarketplaceItem;
  offer: MarketplaceOffer;
}) {
  const t = useTranslations("marketplace");
  const writer = useWriteAccount();
  const actions = useMarketplaceActions();
  const queryClient = useQueryClient();
  const collection = offer.collectionAddress ?? DAO_ADDRESSES.token;
  const owner = writer?.account.address;
  const [draft] = useState(() =>
    owner ? readListingEditDraft(owner, collection, item.tokenId) : null,
  );
  const matchingDraft = draft?.offer.orderHash === offer.orderHash ? draft : null;
  const [price, setPrice] = useState(matchingDraft?.price ?? formatEther(BigInt(offer.priceWei)));
  const [duration, setDuration] = useState<1 | 7 | 30>(matchingDraft?.duration ?? 7);
  const [comment, setComment] = useState(matchingDraft?.comment ?? offer.listingComment ?? "");
  const [quotePrice, setQuotePrice] = useState(price);
  const [storageError, setStorageError] = useState(false);
  const [requested, setRequested] = useState(false);
  const [persistedComplete, setPersistedComplete] = useState(false);
  const currentOwner = owner?.toLowerCase() === offer.seller.toLowerCase();
  const complete =
    persistedComplete ||
    (!!owner &&
      matchesCompletedListingEdit(
        actions.recovery
          ? { ...actions.recovery, id: actions.recovery.journalId, account: owner }
          : null,
        owner,
        offer,
        item.tokenId,
      ));
  const unresolved =
    !!actions.invalidJournal ||
    actions.canCancelSavedListing ||
    actions.canResume ||
    ["pending", "unknown", "confirming", "signing", "saving"].includes(actions.phase);
  const disabled = actions.isBusy || unresolved || complete || !currentOwner;
  const storageKey = owner ? listingEditKey(owner, collection, item.tokenId) : null;
  useEffect(() => {
    const check = () => {
      if (!owner) return;
      try {
        setPersistedComplete(completedListingEdit(owner, offer, item.tokenId));
      } catch {
        setStorageError(true);
      }
    };
    check();
    window.addEventListener(LISTING_EDIT_EVENT, check);
    window.addEventListener("storage", check);
    return () => {
      window.removeEventListener(LISTING_EDIT_EVENT, check);
      window.removeEventListener("storage", check);
    };
  }, [owner, offer, item.tokenId]);
  useEffect(() => {
    const timer = setTimeout(() => setQuotePrice(price), 400);
    return () => clearTimeout(timer);
  }, [price]);
  useEffect(() => {
    if (!storageKey || !currentOwner) return;
    try {
      if (!complete && !completedListingEdit(owner!, offer, item.tokenId)) {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ version: 1, tokenId: item.tokenId, offer, price, duration, comment }),
        );
        notifyListingEditChanged();
      }
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [storageKey, owner, currentOwner, complete, item.tokenId, offer, price, duration, comment]);
  const cancellation = useQuery({
    queryKey: [
      "marketplace",
      "edit-cancelled",
      offer.protocolAddress,
      offer.orderHash,
      actions.phase,
    ],
    queryFn: () => actions.isListingCancelled(offer),
    enabled: !!owner && currentOwner && !complete,
    staleTime: 0,
    retry: false,
  });
  const cancelled = cancellation.data === true && !cancellation.isError;
  const eligibility = useQuery({
    queryKey: ["marketplace", "community", "eligibility", owner?.toLowerCase()],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/marketplace/community/eligibility?owner=${owner}`, {
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Community eligibility unavailable");
      return response.json() as Promise<MarketplaceEligibility>;
    },
    enabled: !!offer.collectionAddress && !!owner && currentOwner && !complete,
    staleTime: 0,
    retry: false,
  });
  const eligible =
    !offer.collectionAddress ||
    (!eligibility.isError &&
      eligibility.data?.owner.toLowerCase() === owner?.toLowerCase() &&
      eligibility.data?.eligible === true);
  const amount = parseMarketplacePrice(price);
  const quote = useQuery({
    queryKey: [
      "marketplace",
      "edit-quote",
      owner,
      collection,
      item.tokenId,
      offer.source,
      quotePrice,
      cancelled,
    ],
    queryFn: () =>
      actions.quote({
        tokenId: item.tokenId,
        collectionAddress: offer.collectionAddress,
        source: offer.source,
        priceEth: quotePrice,
      }),
    enabled: !!owner && currentOwner && !!parseMarketplacePrice(quotePrice) && !complete,
    staleTime: 15000,
    retry: false,
  });
  const quoteReady =
    !!amount &&
    quote.data?.priceWei === amount.toString() &&
    quote.data?.source === offer.source &&
    !quote.isFetching &&
    !quote.isError;
  async function submit() {
    setRequested(true);
    if (
      disabled ||
      !storageKey ||
      !quoteReady ||
      !eligible ||
      !validateListingEditInput(price, comment)
    )
      return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ version: 1, tokenId: item.tokenId, offer, price, duration, comment }),
      );
      notifyListingEditChanged();
    } catch {
      setStorageError(true);
      return;
    }
    if (!cancelled) {
      if (offer.collectionAddress) {
        const checked = await eligibility.refetch();
        if (
          checked.isError ||
          checked.data?.eligible !== true ||
          checked.data.owner.toLowerCase() !== owner?.toLowerCase()
        )
          return;
      }
      await actions.cancel(offer, item.tokenId);
    } else
      await actions.replaceListing(
        {
          tokenId: item.tokenId,
          collectionAddress: offer.collectionAddress,
          source: offer.source,
          priceEth: formatEther(amount!),
          durationDays: duration,
          expectedRoyaltyWei: quote.data!.royaltyWei,
          expectedQuote: quote.data!,
          ...(offer.collectionAddress && comment.trim() ? { listingComment: comment.trim() } : {}),
        },
        offer,
      );
    await queryClient.invalidateQueries({ queryKey: ["marketplace"] });
  }
  return (
    <section className="space-y-5" aria-label={t("edit.listing")}>
      <h3 className="text-base font-semibold">{t("edit.listing")}</h3>
      <p className="text-sm text-muted-foreground">
        {t(cancelled ? "edit.cancelled" : "edit.replaceNotice")}
      </p>
      <div className="space-y-2">
        <Label htmlFor="edit-listing-price">{t("price")}</Label>
        <Input
          id="edit-listing-price"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          disabled={disabled}
          aria-invalid={requested && !amount}
        />
        {requested && !amount && (
          <p role="alert" className="text-xs text-destructive">
            {t("invalidPrice")}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="edit-listing-duration">{t("edit.newDuration")}</Label>
        <select
          id="edit-listing-duration"
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value) as 1 | 7 | 30)}
          disabled={disabled}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        >
          {[1, 7, 30].map((days) => (
            <option key={days} value={days}>
              {t("days", { count: days })}
            </option>
          ))}
        </select>
      </div>
      {!!offer.collectionAddress && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="edit-listing-comment">{t("edit.commentLabel")}</Label>
            <span className="text-xs tabular-nums text-muted-foreground">{comment.length}/280</span>
          </div>
          <Textarea
            id="edit-listing-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={280}
            rows={4}
            disabled={disabled}
          />
        </div>
      )}
      {quoteReady && quote.data && !complete && (
        <dl className="space-y-2 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <dt>{t("edit.marketplaceFee")}</dt>
            <dd className="font-mono">
              {formatEther(quote.data.fees.reduce((sum, fee) => sum + BigInt(fee.amountWei), 0n))}{" "}
              ETH
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt>{t("royalties")}</dt>
            <dd className="font-mono">{formatEther(BigInt(quote.data.royaltyWei))} ETH</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2 font-semibold">
            <dt>{t("proceeds")}</dt>
            <dd className="font-mono">{formatEther(BigInt(quote.data.sellerWei))} ETH</dd>
          </div>
        </dl>
      )}
      {!!offer.collectionAddress && eligibility.data && !eligible && !eligibility.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("community.minimumRequired", { count: eligibility.data.minimum })}
        </p>
      )}
      {(quote.isError || cancellation.isError || eligibility.isError) && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {t("edit.verificationError")}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void quote.refetch();
              void cancellation.refetch();
              if (offer.collectionAddress) void eligibility.refetch();
            }}
          >
            <RefreshCw className="size-4" />
            {t("retry")}
          </Button>
        </div>
      )}
      {storageError && (
        <p role="alert" className="text-sm text-destructive">
          {t("edit.storageError")}
        </p>
      )}
      {complete ? (
        <p role="status" className="flex items-center gap-2">
          <Check className="size-4 text-emerald-500" />
          {t("edit.replaced")}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t("gas")}</p>
          <Button
            className="w-full"
            onClick={() => void submit()}
            disabled={
              disabled ||
              storageError ||
              !quoteReady ||
              !eligible ||
              (!!offer.collectionAddress && eligibility.isFetching) ||
              cancellation.isFetching ||
              cancellation.isError ||
              !validateListingEditInput(price, comment)
            }
          >
            {actions.isBusy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : cancelled ? (
              <Tag className="size-4" />
            ) : (
              <X className="size-4" />
            )}
            {t(cancelled ? "edit.publishReplacement" : "edit.cancelToReplace")}
          </Button>
        </>
      )}
      <MarketplaceRecovery showCompleted={false} />
    </section>
  );
}

export function MarketplaceEditRecovery({
  onResume,
}: {
  onResume: (collection: Address, tokenId: string) => void;
}) {
  const writer = useWriteAccount();
  const actions = useMarketplaceActions();
  const t = useTranslations("marketplace.edit");
  const [drafts, setDrafts] = useState<ListingEditDraft[]>([]);
  const owner = writer?.account.address.toLowerCase();
  useEffect(() => {
    const load = () => {
      const found: ListingEditDraft[] = [];
      if (owner) {
        try {
          for (let i = 0; i < localStorage.length && found.length < 25; i++) {
            const key = localStorage.key(i)!;
            if (!key.startsWith(`gnars:listing-edit:8453:${owner}:`)) continue;
            const draft = listingEditDraftSchema.safeParse(JSON.parse(localStorage.getItem(key)!));
            if (draft.success && draft.data.offer.seller.toLowerCase() === owner)
              found.push(draft.data);
          }
        } catch {
          /* The editor reports unavailable browser storage before cancelling. */
        }
      }
      setDrafts(found);
    };
    load();
    window.addEventListener("storage", load);
    window.addEventListener(LISTING_EDIT_EVENT, load);
    return () => {
      window.removeEventListener("storage", load);
      window.removeEventListener(LISTING_EDIT_EVENT, load);
    };
  }, [owner]);
  return (
    <div className="space-y-2 empty:hidden">
      {drafts
        .filter((draft) => draft.offer.seller.toLowerCase() === owner)
        .map((draft) => (
          <Button
            key={draft.offer.orderHash}
            variant="outline"
            disabled={actions.isBusy}
            onClick={() =>
              onResume(
                (draft.offer.collectionAddress ?? DAO_ADDRESSES.token) as Address,
                draft.tokenId,
              )
            }
          >
            <Pencil className="size-4" />
            {t("resumeToken", { tokenId: draft.tokenId })}
          </Button>
        ))}
    </div>
  );
}
