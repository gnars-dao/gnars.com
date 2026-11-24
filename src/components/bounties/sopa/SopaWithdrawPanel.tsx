"use client";

import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSopaPendingWithdrawals, useSopaWithdrawAll } from "@/hooks/use-sopa-withdrawals";
import { useUserAddress } from "@/hooks/use-user-address";
import { Link } from "@/i18n/navigation";
import { POIDH_SOPA } from "@/lib/config";
import { formatTokenAmount } from "@/lib/poidh-sopa/tokens";
import type { SopaPendingItem } from "@/lib/poidh-sopa/withdrawals";
import { getTxUrl } from "@/lib/poidh/config";
import { cn } from "@/lib/utils";

/** Errors a withdraw can hit that have copy under `wallet.prizes.errors`. */
type TranslatedError =
  | "userRejected"
  | "insufficientFunds"
  | "NothingToWithdraw"
  | "TransferFailed"
  | "noSigner";
const TRANSLATED_ERRORS: ReadonlySet<string> = new Set<TranslatedError>([
  "userRejected",
  "insufficientFunds",
  "NothingToWithdraw",
  "TransferFailed",
  "noSigner",
]);

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const formatItem = ({ token, amount }: SopaPendingItem) =>
  `${formatTokenAmount(amount, token.decimals, token.decimals <= 6 ? 2 : 6)} ${token.symbol}`;

interface SopaWithdrawPanelProps {
  /** "compact" is the one-line row in the wallet panel. */
  variant?: "banner" | "compact";
  className?: string;
}

/**
 * Every PoidhSopa balance the user can pull, from both of their accounts, behind one
 * button. Renders nothing while there is nothing to withdraw (or before connecting).
 */
export function SopaWithdrawPanel({ variant = "banner", className }: SopaWithdrawPanelProps) {
  const t = useTranslations("wallet");
  const { address: viewAddress, canSwitchView } = useUserAddress();
  const { pending, totals, hasPending, readFailed, refetch } = useSopaPendingWithdrawals();
  const withdraw = useSopaWithdrawAll();

  const onWithdraw = async () => {
    await withdraw.run(pending);
    void refetch();
  };

  // After a withdraw the balance reads 0: keep the confirmation up instead of vanishing.
  // Also after a partial run (one account withdrew, the next failed).
  const showDone = withdraw.withdrawn.length > 0;

  const profile = (address: string) => (
    <Link href={`/members/${address}`} className="underline-offset-2 hover:underline">
      {short(address)}
    </Link>
  );

  if (!hasPending && !showDone && !withdraw.error) {
    if (!readFailed) return null;
    if (variant === "compact") {
      return (
        <div className={cn("flex items-center justify-between gap-3", className)}>
          <span className="text-muted-foreground">{t("prizes.drawerLabel")}</span>
          <span className="text-xs text-destructive">{t("prizes.readFailedShort")}</span>
        </div>
      );
    }
    return (
      <div
        className={cn(
          "flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive",
          className,
        )}
      >
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t("prizes.readFailed")}</span>
      </div>
    );
  }

  const amounts = totals.map(formatItem).join(" + ");
  // Say where the money sits when it is not the account on screen: the signer follows it.
  const elsewhere =
    canSwitchView && viewAddress
      ? pending.find((p) => p.address.toLowerCase() !== viewAddress.toLowerCase())
      : undefined;

  const button = (
    <Button
      size="sm"
      variant="outline"
      className="cursor-pointer whitespace-nowrap border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
      disabled={withdraw.isPending}
      onClick={onWithdraw}
    >
      {withdraw.isPending ? (
        <>
          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
          {withdraw.phase === "confirming"
            ? t("prizes.waitingConfirmation")
            : t("prizes.confirmInWallet")}
          {withdraw.step && ` (${withdraw.step.current}/${withdraw.step.total})`}
        </>
      ) : variant === "compact" ? (
        t("prizes.drawerWithdraw")
      ) : totals.length === 1 ? (
        t("prizes.withdraw", { token: totals[0].token.symbol })
      ) : (
        t("prizes.withdrawAll")
      )}
    </Button>
  );

  const done = showDone ? (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="h-4 w-4 shrink-0" />
      <span>{t("prizes.withdrawn")}</span>
      {withdraw.withdrawn.map((p) => (
        <span key={p.address}>
          {t.rich("prizes.sent", {
            amounts: p.items.map(formatItem).join(" + "),
            address: () => profile(p.address),
          })}
        </span>
      ))}
      {withdraw.hashes.map((hash) => (
        <a
          key={hash}
          href={getTxUrl(POIDH_SOPA.chainId, hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-0.5 hover:underline"
        >
          {t("prizes.viewTx")} <ExternalLink className="h-3 w-3" />
        </a>
      ))}
    </div>
  ) : null;

  const error = withdraw.error ? (
    <div className="flex items-start gap-1 text-xs text-destructive">
      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="break-words">
        {withdraw.error.key && TRANSLATED_ERRORS.has(withdraw.error.key)
          ? t(`prizes.errors.${withdraw.error.key as TranslatedError}`)
          : withdraw.error.message}
      </span>
    </div>
  ) : null;

  // Some balance could not be read: the total shown may be short.
  const partial =
    readFailed && hasPending ? (
      <div className="flex items-start gap-1 text-xs text-destructive">
        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{t("prizes.readPartial")}</span>
      </div>
    ) : null;

  if (variant === "compact") {
    return (
      <div className={cn("space-y-2", className)}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{t("prizes.drawerLabel")}</span>
          {hasPending ? (
            <span className="flex items-center gap-2">
              <span className="font-medium tabular-nums">{amounts}</span>
              {button}
            </span>
          ) : null}
        </div>
        {done}
        {error}
        {partial}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm sm:flex-row sm:items-center",
        className,
      )}
    >
      <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-amber-500 sm:mt-0" />
      <div className="min-w-0 flex-1 space-y-1">
        {hasPending ? (
          <p className="font-medium text-amber-700 dark:text-amber-300">
            {t("prizes.title", { amounts })}
          </p>
        ) : null}
        {hasPending ? (
          <p className="text-xs text-muted-foreground">
            {elsewhere
              ? t.rich("prizes.heldIn", {
                  account:
                    elsewhere.kind === "eoa" ? t("prizes.accountAdmin") : t("prizes.accountSa"),
                  address: () => profile(elsewhere.address),
                })
              : t("prizes.description")}
          </p>
        ) : null}
        {done}
        {error}
        {partial}
      </div>
      {hasPending ? <div className="shrink-0">{button}</div> : null}
    </div>
  );
}
