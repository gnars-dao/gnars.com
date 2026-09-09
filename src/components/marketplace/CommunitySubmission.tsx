"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Tag,
  X,
} from "lucide-react";
import { formatEther, getAddress, isAddress, type Address } from "viem";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/ui/ConnectButton";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMarketplaceActions } from "@/hooks/use-marketplace-actions";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useWriteAccount } from "@/hooks/use-write-account";
import { Link } from "@/i18n/navigation";
import { parseMarketplacePrice } from "@/lib/marketplace-display";
import type { MarketplaceEligibility, MarketplacePage } from "@/types/marketplace";
import { MarketplaceRecovery } from "./MarketplaceRecovery";
import { NftArtwork } from "./NftArtwork";

type Props = { open: boolean; onClose: () => void; onPublished?: () => void };
type Selection = { collectionAddress: Address; tokenId: string };

async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error("Marketplace request unavailable");
  return response.json();
}

export function CommunitySubmission(props: Props) {
  const writer = useWriteAccount();
  return (
    <SubmissionDrawer
      key={writer?.account.address.toLowerCase() ?? "guest"}
      {...props}
      owner={writer ? getAddress(writer.account.address) : undefined}
    />
  );
}

function SubmissionDrawer({ open, onClose, onPublished, owner }: Props & { owner?: Address }) {
  const t = useTranslations("marketplace");
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const reduceMotion = useReducedMotion();
  const actions = useMarketplaceActions();
  const queries = useQueryClient();
  const [step, setStep] = useState(0);
  const [collection, setCollection] = useState("");
  const [token, setToken] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [invalidSelection, setInvalidSelection] = useState(false);
  const [price, setPrice] = useState("");
  const [debouncedPrice, setDebouncedPrice] = useState("");
  const [duration, setDuration] = useState(7);
  const [submitted, setSubmitted] = useState(false);
  const [publishingStarted, setPublishingStarted] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const notified = useRef(false);

  const eligibility = useQuery({
    queryKey: ["marketplace", "community", "eligibility", owner?.toLowerCase()],
    queryFn: ({ signal }) =>
      readJson<MarketplaceEligibility>(
        `/api/marketplace/community/eligibility?owner=${owner}`,
        signal,
      ),
    enabled: open && !!owner,
    staleTime: 30_000,
    retry: false,
  });
  const membership = eligibility.data;
  const eligible =
    !!membership &&
    !eligibility.isError &&
    membership.owner.toLowerCase() === owner?.toLowerCase() &&
    membership.eligible;
  const feeConfigured = membership?.feeBps !== null && membership?.feeBps !== undefined;
  const asset = useQuery({
    queryKey: [
      "marketplace",
      "community",
      "nft",
      selection?.collectionAddress,
      selection?.tokenId,
      owner?.toLowerCase(),
    ],
    queryFn: ({ signal }) =>
      readJson<MarketplacePage>(
        `/api/marketplace/community/nfts/${selection!.collectionAddress}/${selection!.tokenId}?owner=${owner}`,
        signal,
      ),
    enabled: open && eligible && !!selection && !!owner,
    staleTime: 15_000,
    retry: false,
  });
  const item = asset.data?.items.find(
    (nft) =>
      nft.tokenId === selection?.tokenId &&
      nft.collectionAddress?.toLowerCase() === selection?.collectionAddress.toLowerCase(),
  );
  const verifiedOwner =
    !!item &&
    asset.data?.ownershipVerified === true &&
    item.owner?.toLowerCase() === owner?.toLowerCase() &&
    !asset.isError;
  const assetReady =
    eligible && verifiedOwner && !asset.isFetching && !!asset.data?.capabilities.customTrading;
  const priceWei = parseMarketplacePrice(price);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedPrice(price), 400);
    return () => clearTimeout(timer);
  }, [price]);

  const quote = useQuery({
    queryKey: [
      "marketplace",
      "community",
      "quote",
      owner?.toLowerCase(),
      selection?.collectionAddress,
      selection?.tokenId,
      debouncedPrice,
      membership?.feeBps,
    ],
    queryFn: () =>
      actions.quote({
        collectionAddress: selection!.collectionAddress,
        tokenId: selection!.tokenId,
        priceEth: formatEther(parseMarketplacePrice(debouncedPrice)!),
        source: "gnars-contract",
      }),
    enabled:
      open && step === 1 && assetReady && feeConfigured && !!parseMarketplacePrice(debouncedPrice),
    staleTime: 15_000,
    retry: false,
  });
  const expectedFee =
    priceWei && feeConfigured ? (priceWei * BigInt(membership!.feeBps!)) / 10000n : null;
  const quotedFee = quote.data?.fees
    .filter((fee) => fee.recipient.toLowerCase() === membership?.feeRecipient.toLowerCase())
    .reduce((sum, fee) => sum + BigInt(fee.amountWei), 0n);
  const quoteReady =
    !!quote.data &&
    quote.data.source === "gnars-contract" &&
    quote.data.priceWei === priceWei?.toString() &&
    expectedFee === quotedFee &&
    !quote.isFetching &&
    !quote.isError;
  const quoteMismatch =
    !!quote.data &&
    quote.data.priceWei === priceWei?.toString() &&
    expectedFee !== quotedFee &&
    !quote.isFetching;
  const unresolved =
    !!actions.invalidJournal ||
    actions.canCancelSavedListing ||
    actions.canResume ||
    ["pending", "unknown", "confirming", "signing", "saving"].includes(actions.phase);
  const success =
    submitted &&
    publishingStarted &&
    actions.phase === "complete" &&
    actions.recovery?.kind === "list" &&
    actions.recovery.tokenId === selection?.tokenId;

  useEffect(() => {
    if (submitted && actions.phase !== "complete") setPublishingStarted(true);
  }, [submitted, actions.phase]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [step]);
  useEffect(() => {
    if (success && !notified.current) {
      notified.current = true;
      void queries.invalidateQueries({ queryKey: ["marketplace"] });
      onPublished?.();
    }
  }, [success, onPublished, queries]);

  function findAsset(event: FormEvent) {
    event.preventDefault();
    const tokenId = token.trim().replace(/^#/, "");
    if (
      !isAddress(collection.trim(), { strict: false }) ||
      !/^\d{1,78}$/.test(tokenId) ||
      BigInt(tokenId) >= 2n ** 256n
    ) {
      setInvalidSelection(true);
      return;
    }
    setInvalidSelection(false);
    setSelection({
      collectionAddress: getAddress(collection.trim()),
      tokenId: BigInt(tokenId).toString(),
    });
  }

  async function publish() {
    if (!selection || !assetReady || !quoteReady || !priceWei || actions.isBusy || unresolved)
      return;
    setSubmitted(true);
    setPublishingStarted(false);
    setStep(2);
    await actions.list({
      collectionAddress: selection.collectionAddress,
      tokenId: selection.tokenId,
      priceEth: formatEther(priceWei),
      durationDays: duration,
      source: "gnars-contract",
      expectedRoyaltyWei: quote.data!.royaltyWei,
      expectedQuote: quote.data!,
    });
  }

  const canEdit = !actions.isBusy && !unresolved;
  return (
    <Drawer
      open={open}
      direction={isDesktop ? "right" : "bottom"}
      dismissible={!actions.isBusy}
      autoFocus
      fixed
      onOpenChange={(next) => {
        if (!next && !actions.isBusy) onClose();
      }}
    >
      <DrawerContent
        className="overflow-hidden shadow-2xl after:hidden data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:h-[92dvh] data-[vaul-drawer-direction=bottom]:max-h-[92dvh] data-[vaul-drawer-direction=right]:w-[min(560px,100vw)] data-[vaul-drawer-direction=right]:sm:max-w-[560px] motion-reduce:!animate-none motion-reduce:!transition-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
        onInteractOutside={(event) => {
          if (actions.isBusy) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (actions.isBusy) event.preventDefault();
        }}
      >
        <DrawerHeader className="shrink-0 flex-row items-center justify-between gap-3 border-b px-5 py-4 text-left md:px-6 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
          <div className="min-w-0">
            <DrawerTitle
              ref={titleRef}
              tabIndex={-1}
              className="text-xl font-semibold outline-none"
            >
              {t("community.submitTitle")}
            </DrawerTitle>
            <DrawerDescription className="mt-1 flex items-center gap-2 text-xs">
              <span className="size-1.5 rounded-full bg-blue-500" />
              {t("network")} / ERC-721
            </DrawerDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("close")}
            disabled={actions.isBusy}
            onClick={onClose}
          >
            <X className="size-5" />
          </Button>
        </DrawerHeader>

        <ol
          aria-label={t("community.stepsLabel")}
          className="grid shrink-0 grid-cols-3 gap-2 border-b px-5 py-4 md:px-6"
        >
          {(["asset", "terms", "publish"] as const).map((name, index) => (
            <li
              key={name}
              aria-current={step === index ? "step" : undefined}
              className={`flex items-center gap-2 text-xs ${index <= step ? "text-foreground" : "text-muted-foreground"}`}
            >
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] ${index < step ? "border-emerald-500/40 text-emerald-500" : ""}`}
              >
                {index < step ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span>{t(`community.steps.${name}`)}</span>
            </li>
          ))}
        </ol>

        <div
          ref={scrollRef}
          data-vaul-no-drag
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 md:px-6"
        >
          {!owner ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-5 text-center">
              <ImagePlus className="size-9 text-muted-foreground" />
              <h2 className="text-base font-semibold">{t("connect")}</h2>
              <div className="w-48">
                <ConnectButton />
              </div>
            </div>
          ) : eligibility.isPending ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t("community.checkingEligibility")}
            </p>
          ) : eligibility.isError || !membership ? (
            <div role="alert" className="space-y-3 text-sm">
              <p>{t("community.eligibilityError")}</p>
              <Button variant="outline" onClick={() => void eligibility.refetch()}>
                <RefreshCw className="size-4" />
                {t("retry")}
              </Button>
            </div>
          ) : (
            <>
              <div className="mb-5 flex items-start gap-3 border-b pb-4 text-sm">
                {eligible ? (
                  <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-500" />
                ) : (
                  <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-500" />
                )}
                <div className="min-w-0">
                  <p className="font-medium">
                    {t("community.membershipBalance", { balance: membership.balance })}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(eligible ? "community.eligible" : "community.minimumRequired", {
                      count: membership.minimum,
                    })}
                  </p>
                </div>
              </div>
              {!feeConfigured && (
                <p
                  role="status"
                  className="mb-4 flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  {t("community.feeUnconfigured")}
                </p>
              )}
              {unresolved && step !== 2 && (
                <div className="mb-5">
                  <MarketplaceRecovery />
                </div>
              )}
              {eligible && (
                <AnimatePresence mode="wait" initial={false}>
                  <motion.section
                    key={step}
                    initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: reduceMotion ? 0 : -8 }}
                    transition={{ duration: reduceMotion ? 0 : 0.18 }}
                    className="space-y-5"
                  >
                    {step === 0 && (
                      <>
                        <form onSubmit={findAsset} className="space-y-4">
                          <div className="space-y-2">
                            <Label htmlFor="community-collection">
                              {t("community.collectionAddress")}
                            </Label>
                            <Input
                              id="community-collection"
                              value={collection}
                              placeholder="0x..."
                              spellCheck={false}
                              autoCapitalize="off"
                              autoComplete="off"
                              disabled={!canEdit}
                              onChange={(event) => {
                                setCollection(event.target.value);
                                setSelection(null);
                                setInvalidSelection(false);
                              }}
                              className="font-mono text-xs"
                            />
                          </div>
                          <div className="flex items-end gap-3">
                            <div className="min-w-0 flex-1 space-y-2">
                              <Label htmlFor="community-token">{t("tokenId")}</Label>
                              <Input
                                id="community-token"
                                inputMode="numeric"
                                value={token}
                                placeholder="42"
                                disabled={!canEdit}
                                onChange={(event) => {
                                  setToken(event.target.value);
                                  setSelection(null);
                                  setInvalidSelection(false);
                                }}
                              />
                            </div>
                            <Button
                              type="submit"
                              variant="outline"
                              disabled={!canEdit || asset.isFetching || !collection || !token}
                            >
                              {asset.isFetching ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <ImagePlus className="size-4" />
                              )}
                              {t("community.findNft")}
                            </Button>
                          </div>
                          {invalidSelection && (
                            <p role="alert" className="text-xs text-destructive">
                              {t("community.invalidAsset")}
                            </p>
                          )}
                        </form>
                        {asset.isError && (
                          <div role="alert" className="space-y-3 text-sm">
                            <p>{t("community.assetError")}</p>
                            <Button variant="outline" onClick={() => void asset.refetch()}>
                              <RefreshCw className="size-4" />
                              {t("retry")}
                            </Button>
                          </div>
                        )}
                        {item && (
                          <div className="space-y-3 border-t pt-5">
                            <div className="mx-auto w-44 max-w-full overflow-hidden rounded-lg">
                              <NftArtwork item={item} sizes="176px" loading="eager" />
                            </div>
                            <h2 className="break-words text-center text-base font-semibold">
                              {item.name}
                            </h2>
                            <p className="text-center text-xs text-muted-foreground">
                              {item.collectionName ?? t("community.erc721Collection")}
                            </p>
                            {!verifiedOwner && (
                              <p role="alert" className="text-sm text-destructive">
                                {t("community.notOwner")}
                              </p>
                            )}
                            {verifiedOwner && !asset.data?.capabilities.customTrading && (
                              <p role="status" className="text-sm text-muted-foreground">
                                {t("listingUnavailable")}
                              </p>
                            )}
                          </div>
                        )}
                        {asset.isSuccess && !item && (
                          <p role="alert" className="text-sm text-destructive">
                            {t("community.assetError")}
                          </p>
                        )}
                      </>
                    )}

                    {step === 1 && item && (
                      <>
                        <div className="flex items-center gap-4 border-b pb-4">
                          <div className="w-20 shrink-0 overflow-hidden rounded-lg">
                            <NftArtwork item={item} sizes="80px" loading="eager" />
                          </div>
                          <div className="min-w-0">
                            <h2 className="break-words text-base font-semibold">{item.name}</h2>
                            <p className="mt-1 break-words text-xs text-muted-foreground">
                              {item.collectionName ?? t("community.erc721Collection")}
                            </p>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="community-price">{t("price")}</Label>
                          <Input
                            id="community-price"
                            inputMode="decimal"
                            value={price}
                            placeholder="0.02"
                            disabled={!canEdit}
                            onChange={(event) => setPrice(event.target.value)}
                          />
                          {price && !priceWei && (
                            <p role="alert" className="text-xs text-destructive">
                              {t("invalidPrice")}
                            </p>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="community-duration">{t("duration")}</Label>
                          <select
                            id="community-duration"
                            value={duration}
                            disabled={!canEdit}
                            onChange={(event) => setDuration(Number(event.target.value))}
                            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                          >
                            {[1, 7, 30].map((days) => (
                              <option key={days} value={days}>
                                {t("days", { count: days })}
                              </option>
                            ))}
                          </select>
                        </div>
                        {quote.isFetching && (
                          <p
                            role="status"
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            <LoaderCircle className="size-4 animate-spin" />
                            {t("community.checkingFees")}
                          </p>
                        )}
                        {(quote.isError || quoteMismatch) && (
                          <div role="alert" className="space-y-2 text-sm">
                            <p>{t("quoteError")}</p>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                void eligibility.refetch();
                                void quote.refetch();
                              }}
                            >
                              <RefreshCw className="size-4" />
                              {t("retry")}
                            </Button>
                          </div>
                        )}
                        {quoteReady && quote.data && (
                          <dl className="space-y-3 border-y py-4 text-sm">
                            <div className="flex flex-wrap justify-between gap-2">
                              <dt className="text-muted-foreground">
                                {t("community.marketplaceFee", {
                                  percent: (membership.feeBps! / 100).toString(),
                                })}
                              </dt>
                              <dd className="break-all font-mono text-xs">
                                {formatEther(expectedFee!)} ETH
                              </dd>
                            </div>
                            <div className="flex flex-wrap justify-between gap-2">
                              <dt className="text-muted-foreground">{t("royalties")}</dt>
                              <dd className="break-all font-mono text-xs">
                                {formatEther(BigInt(quote.data.royaltyWei))} ETH
                              </dd>
                            </div>
                            <div className="flex flex-wrap justify-between gap-2 font-semibold">
                              <dt>{t("proceeds")}</dt>
                              <dd className="break-all font-mono">
                                {formatEther(BigInt(quote.data.sellerWei))} ETH
                              </dd>
                            </div>
                          </dl>
                        )}
                        {feeConfigured && (
                          <p className="text-xs text-muted-foreground">
                            {t("community.feeRecipient")}{" "}
                            <Link
                              href={`/members/${membership.feeRecipient}`}
                              title={membership.feeRecipient}
                              className="font-mono underline underline-offset-4"
                            >
                              {membership.feeRecipient.slice(0, 6)}...
                              {membership.feeRecipient.slice(-4)}
                            </Link>
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">{t("gas")}</p>
                      </>
                    )}

                    {step === 2 && (
                      <>
                        {item && (
                          <div className="space-y-3">
                            <div className="mx-auto w-36 overflow-hidden rounded-lg">
                              <NftArtwork item={item} sizes="144px" loading="eager" />
                            </div>
                            <h2 className="break-words text-center text-base font-semibold">
                              {item.name}
                            </h2>
                          </div>
                        )}
                        <MarketplaceRecovery showCompleted />
                        {success && (
                          <p
                            role="status"
                            className="flex items-center justify-center gap-2 text-sm font-medium text-emerald-500"
                          >
                            <Check className="size-4" />
                            {t("community.published")}
                          </p>
                        )}
                      </>
                    )}
                  </motion.section>
                </AnimatePresence>
              )}
            </>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-3 border-t bg-background px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
          {step > 0 && !success && (
            <Button
              variant="outline"
              size="icon"
              aria-label={t("back")}
              disabled={!canEdit}
              onClick={() => {
                setStep(step - 1);
                setSubmitted(false);
              }}
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          {step === 0 && (
            <Button
              className="flex-1"
              disabled={!assetReady || !feeConfigured || !canEdit}
              onClick={() => setStep(1)}
            >
              {t("community.continue")}
              <ArrowRight className="size-4" />
            </Button>
          )}
          {step === 1 && (
            <Button
              className="flex-1"
              disabled={!assetReady || !quoteReady || !canEdit}
              onClick={() => void publish()}
            >
              <Tag className="size-4" />
              {t("confirmList")}
            </Button>
          )}
          {step === 2 && (
            <Button
              className="flex-1"
              variant={success ? "default" : "outline"}
              disabled={actions.isBusy}
              onClick={onClose}
            >
              {actions.isBusy ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : success ? (
                <Check className="size-4" />
              ) : (
                <X className="size-4" />
              )}
              {t(success ? "newAction" : "close")}
            </Button>
          )}
        </footer>
      </DrawerContent>
    </Drawer>
  );
}
