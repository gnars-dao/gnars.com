"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import type { Hex } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMarketplaceActions } from "@/hooks/use-marketplace-actions";
import { Link } from "@/i18n/navigation";
import { formatMarketplacePrice } from "@/lib/marketplace-display";
import { MarketplaceError } from "./MarketplaceError";

export function MarketplaceRecovery({ showCompleted = false }: { showCompleted?: boolean }) {
  const actions = useMarketplaceActions();
  const t = useTranslations("marketplace");
  const query = useQueryClient();
  const id = useId();
  const [hash, setHash] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  async function run(action: () => Promise<void>) {
    await action();
    void query.invalidateQueries({ queryKey: ["marketplace"] });
  }

  if (actions.invalidJournal) {
    const saved = actions.invalidJournal;
    return (
      <section className="space-y-3 border-y py-4" aria-label={t("invalidJournalTitle")}>
        <h2 className="text-sm font-semibold">{t("invalidJournalTitle")}</h2>
        <p role="alert" className="text-sm text-destructive">
          {t("invalidJournalDescription")}
        </p>
        {actions.error && <MarketplaceError error={actions.error} />}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([saved.raw], { type: "application/json" }));
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = "gnars-marketplace-recovery.json";
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Download className="size-4" />
            {t("exportRecovery")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={actions.isBusy}
            onClick={() => void run(actions.recoverInvalidJournal)}
          >
            <RefreshCw className="size-4" />
            {t("recoverJournal")}
          </Button>
        </div>
      </section>
    );
  }

  const active =
    actions.recovery &&
    (!["idle", "complete", "failed"].includes(actions.phase) || actions.canCancelSavedListing);
  if (
    !active &&
    !actions.sweepResult &&
    !(showCompleted && (actions.phase === "complete" || actions.error))
  )
    return null;
  const complete = actions.phase === "complete";
  const resumable = actions.canResume && actions.error?.retryable !== false;
  const onchain = !!actions.txStep && ["unknown", "pending", "confirming"].includes(actions.phase);
  const phaseKey = complete
    ? "success"
    : onchain
      ? actions.isBusy
        ? "confirming"
        : "pending"
      : actions.phase === "failed"
        ? "error"
        : actions.phase === "unknown"
          ? "signatureUnknown"
          : actions.phase;
  const listingStep =
    actions.phase === "complete"
      ? 3
      : actions.phase === "saving"
        ? 2
        : actions.phase === "signing"
          ? 1
          : 0;
  const collectionAddress = actions.recovery?.input?.collectionAddress;
  const recoveryTitle = actions.recovery
    ? actions.recovery.sweepCount
      ? t("sweep.recoveryTitle", { count: actions.recovery.sweepCount })
      : t(collectionAddress ? "community.recoveryTitle" : "recoveryTitle", {
          id: actions.recovery.tokenId,
        })
    : t("steps.error");
  return (
    <section aria-label={recoveryTitle} className="space-y-3 border-y py-4">
      {actions.recovery && (
        <div className="flex items-center gap-2">
          {actions.isBusy ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin" />
          ) : complete ? (
            <Check className="size-4 shrink-0 text-emerald-500" />
          ) : null}
          <h2 className="text-sm font-semibold">
            {complete
              ? actions.sweepResult
                ? t("sweep.completed", { count: actions.sweepResult.purchasedTokenIds.length })
                : actions.listingOutcome
                  ? t("statusVerified")
                  : t(`completed.${actions.recovery.kind}`)
              : recoveryTitle}
          </h2>
        </div>
      )}
      {complete && actions.sweepResult && (
        <div className="space-y-2 text-sm" role="status">
          <p className="break-words font-mono">
            {actions.sweepResult.purchasedTokenIds.map((tokenId) => `#${tokenId}`).join(", ")}
          </p>
          {actions.sweepResult.skippedTokenIds.length > 0 && (
            <p className="text-muted-foreground">
              {t("sweep.skipped", { count: actions.sweepResult.skippedTokenIds.length })}:{" "}
              {actions.sweepResult.skippedTokenIds.map((tokenId) => `#${tokenId}`).join(", ")}
            </p>
          )}
          <p>
            {t("sweep.spent")}:{" "}
            <span className="font-mono">
              {formatMarketplacePrice(actions.sweepResult.spentWei).display} ETH
            </span>
          </p>
        </div>
      )}
      {collectionAddress && (
        <p className="break-all text-xs text-muted-foreground">
          {t("community.collectionAddress")}:{" "}
          <Link
            href={`/members/${collectionAddress}`}
            className="font-mono underline underline-offset-4"
          >
            {collectionAddress}
          </Link>
        </p>
      )}
      {actions.recovery?.input && (
        <p className="font-mono text-xs tabular-nums">
          {actions.recovery.input.priceEth} ETH /{" "}
          {t("days", { count: actions.recovery.input.durationDays })}
        </p>
      )}
      {actions.recovery?.kind === "list" && !actions.listingOutcome && (
        <ol
          aria-label={t("listingProgress")}
          className="grid grid-cols-3 gap-2 border-b pb-3 text-[11px]"
        >
          {(["approval", "signature", "publication"] as const).map((step, index) => (
            <li
              key={step}
              aria-current={index === listingStep ? "step" : undefined}
              className={`flex min-w-0 items-center gap-1.5 ${index <= listingStep ? "text-foreground" : "text-muted-foreground"}`}
            >
              {index < listingStep ? (
                <Check className="size-3 shrink-0 text-emerald-500" />
              ) : (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px]">
                  {index + 1}
                </span>
              )}
              <span className="break-words">{t(`progress.${step}`)}</span>
            </li>
          ))}
        </ol>
      )}
      {actions.listingOutcome ? (
        <p role="status" className="text-sm">
          {t(`outcomes.${actions.listingOutcome}`)}
        </p>
      ) : (
        !complete && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(`steps.${phaseKey}`)}
          </p>
        )
      )}
      {actions.error && <MarketplaceError error={actions.error} />}
      <div className="flex flex-wrap gap-2">
        {complete && actions.sweepResult && !actions.isBusy && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("close")}
            onClick={() => void run(actions.reset)}
          >
            <X className="size-4" />
          </Button>
        )}
        {!complete && !actions.isBusy && active && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void run(resumable ? actions.resume : actions.checkStatus)}
          >
            <RefreshCw className="size-4" />
            {t(
              resumable
                ? actions.recovery?.kind === "list"
                  ? "resume"
                  : "continueAction"
                : onchain
                  ? "checkStatus"
                  : "verifyRequest",
            )}
          </Button>
        )}
        {actions.txHash && (
          <a
            href={`https://basescan.org/tx/${actions.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs underline underline-offset-4"
          >
            {t("transaction")}
            <ExternalLink className="size-3" />
          </a>
        )}
        {!actions.isBusy && actions.canAbandonSignature && (
          <Button size="sm" variant="ghost" onClick={() => void run(actions.abandonSignature)}>
            <X className="size-4" />
            {t("abandonSignature")}
          </Button>
        )}
        {!actions.isBusy && actions.canCancelSavedListing && !confirmCancel && (
          <Button size="sm" variant="outline" onClick={() => setConfirmCancel(true)}>
            <X className="size-4" />
            {t("cancelSaved")}
          </Button>
        )}
      </div>
      {actions.canCancelSavedListing && confirmCancel && !actions.isBusy && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">{t("cancelSavedConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setConfirmCancel(false);
                void run(actions.cancelSavedListing);
              }}
            >
              <X className="size-4" />
              {t("confirmCancel")}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("back")}
              onClick={() => setConfirmCancel(false)}
            >
              <ArrowLeft className="size-4" />
            </Button>
          </div>
        </div>
      )}
      {actions.phase === "unknown" && actions.txStep && !actions.txHash && !actions.isBusy && (
        <div className="space-y-2">
          <Label htmlFor={id}>{t("transactionHash")}</Label>
          <div className="flex gap-2">
            <Input
              id={id}
              value={hash}
              onChange={(event) => setHash(event.target.value.trim())}
              placeholder="0x..."
              autoComplete="off"
              className="min-w-0 font-mono text-xs"
            />
            <Button
              size="icon"
              variant="outline"
              aria-label={t("attachHash")}
              disabled={!/^0x[\da-fA-F]{64}$/.test(hash)}
              onClick={() => void run(() => actions.attachTransactionHash(hash as Hex))}
            >
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
