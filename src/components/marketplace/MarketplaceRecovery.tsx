"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, RefreshCw, X } from "lucide-react";
import type { Hex } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMarketplaceActions } from "@/hooks/use-marketplace-actions";

export function MarketplaceRecovery() {
  const actions = useMarketplaceActions();
  const t = useTranslations("marketplace");
  const query = useQueryClient();
  const id = useId();
  const [hash, setHash] = useState("");
  if (
    !actions.recovery ||
    actions.isBusy ||
    !["unknown", "pending", "confirming", "signing", "saving"].includes(actions.phase)
  )
    return null;
  const resumable = actions.phase === "signing" || actions.phase === "saving";
  async function run(action: () => Promise<void>) {
    await action();
    void query.invalidateQueries({ queryKey: ["marketplace"] });
  }
  return (
    <section
      aria-label={t("recoveryTitle", { id: actions.recovery.tokenId })}
      className="space-y-3 border-y py-4"
    >
      <h2 className="text-sm font-semibold">
        {t("recoveryTitle", { id: actions.recovery.tokenId })}
      </h2>
      {actions.recovery.input && (
        <p className="break-all font-mono text-xs">
          {actions.recovery.input.priceEth} ETH /{" "}
          {t("days", { count: actions.recovery.input.durationDays })}
        </p>
      )}
      <p role="status" className="text-xs text-muted-foreground">
        {resumable
          ? t(`steps.${actions.phase === "saving" ? "saving" : "signing"}`)
          : t("transactionPending")}
      </p>
      {actions.error && (
        <p role="alert" className="text-xs text-destructive">
          {t("errors.generic")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void run(resumable ? actions.resume : actions.checkStatus)}
        >
          <RefreshCw className="size-4" />
          {t(resumable ? "resume" : "checkStatus")}
        </Button>
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
        {actions.canAbandonSignature && (
          <Button size="sm" variant="ghost" onClick={() => void run(actions.abandonSignature)}>
            <X className="size-4" />
            {t("abandonSignature")}
          </Button>
        )}
      </div>
      {actions.phase === "unknown" && !actions.txHash && !resumable && (
        <div className="space-y-2">
          <Label htmlFor={id}>{t("transactionHash")}</Label>
          <div className="flex gap-2">
            <Input
              id={id}
              value={hash}
              onChange={(e) => setHash(e.target.value.trim())}
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
