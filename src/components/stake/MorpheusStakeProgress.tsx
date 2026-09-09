"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowRight, Check, Circle, ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import type { Hex } from "viem";
import { Link } from "@/i18n/navigation";
import { RIDER_LIST } from "@/lib/gnars-vaults";
import type { MorpheusStakeFlow } from "@/lib/morpheus-stake-flow";

export interface MorpheusStakeProgressProps {
  flow: MorpheusStakeFlow;
  busy: boolean;
  error: string | null;
  onContinue: () => Promise<void>;
  onCheck: () => Promise<void>;
  onAttachHash: (hash: Hex) => Promise<void>;
  onClose: () => void;
  onComplete: () => void;
}

const STEPS = ["approval", "deposit", "receiver"] as const;
const buttonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400";

export function MorpheusStakeProgress({
  flow,
  busy,
  error,
  onContinue,
  onCheck,
  onAttachHash,
  onClose,
  onComplete,
}: MorpheusStakeProgressProps) {
  const t = useTranslations("stake.flow");
  const [hash, setHash] = useState("");
  const [verifying, setVerifying] = useState(false);
  const verify = async (action: () => Promise<void>) => {
    if (verifying) return;
    setVerifying(true);
    try {
      await action();
    } finally {
      setVerifying(false);
    }
  };
  const complete = flow.status === "complete";
  const canContinue =
    !busy && (flow.status === "ready" || (flow.status === "failed" && flow.retryable));
  const current = STEPS.indexOf(flow.step);
  const uncertain = ["unknown", "wallet", "confirming", "pending"].includes(flow.status);
  const validHash = /^0x[0-9a-fA-F]{64}$/.test(hash.trim());
  const rawError = error || flow.error;
  const displayError =
    rawError === "Transaction cancelled in the wallet" ? t("cancelled") : rawError;
  const rider = RIDER_LIST.find(
    (candidate) => candidate.wallet?.toLowerCase() === flow.athlete.toLowerCase(),
  );

  return (
    <section aria-label={t("title")} className="min-w-0 space-y-5" data-testid="stake-progress">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xl font-bold">{t(complete ? "completeTitle" : "title")}</h3>
          <p className="mt-1 break-words text-sm text-white/65">
            {flow.amount} {flow.asset === "stEth" ? "stETH" : "USDC"} <span aria-hidden>·</span>{" "}
            Ethereum
          </p>
        </div>
        <Link
          href={`/members/${flow.account}`}
          className="inline-flex items-center gap-1.5 text-xs text-white/60 underline underline-offset-4"
        >
          {flow.account.slice(0, 6)}...{flow.account.slice(-4)}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      <p className="text-sm text-white/65">
        {t("rider")}{" "}
        <Link
          href={`/members/${flow.athlete}`}
          className="break-all text-white underline underline-offset-4"
        >
          {rider?.handle ?? flow.athlete}
        </Link>
      </p>

      <ol className="divide-y divide-white/10 border-y border-white/10">
        {STEPS.map((step, index) => {
          const done = complete || index < current || (step === "deposit" && flow.depositConfirmed);
          const active = !complete && index === current;
          const spinning =
            active && busy && !["unknown", "pending", "failed"].includes(flow.status);
          const Icon = done ? Check : spinning ? Loader2 : Circle;
          const transactionHash = flow.hashes[step];
          return (
            <li
              key={step}
              className="flex min-h-20 items-center gap-3 py-4"
              aria-current={active ? "step" : undefined}
            >
              <Icon
                aria-hidden
                className={`h-5 w-5 shrink-0 ${done ? "text-green-400" : active ? "text-amber-400" : "text-white/35"} ${spinning ? "animate-spin" : ""}`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{t(`steps.${step}`)}</div>
                <div
                  className={`mt-1 text-xs ${active && flow.status === "failed" ? "text-red-300" : "text-white/60"}`}
                >
                  {t(
                    done ? "states.confirmed" : active ? `states.${flow.status}` : "states.waiting",
                  )}
                </div>
              </div>
              {transactionHash && (
                <a
                  href={`https://etherscan.io/tx/${transactionHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("viewTransaction", { step: t(`steps.${step}`) })}
                  title={t("viewTransaction", { step: t(`steps.${step}`) })}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-amber-400"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                </a>
              )}
            </li>
          );
        })}
      </ol>

      {flow.previousHashes.length > 0 && (
        <details className="text-sm text-white/65">
          <summary className="cursor-pointer py-2">{t("previousTransactions")}</summary>
          <ul className="space-y-2 py-2">
            {Array.from(new Set(flow.previousHashes)).map((previousHash) => (
              <li key={previousHash}>
                <a
                  href={`https://etherscan.io/tx/${previousHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-2 underline underline-offset-4"
                >
                  {previousHash.slice(0, 10)}...{previousHash.slice(-6)}
                  <ExternalLink className="h-4 w-4" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div aria-live="polite" className="space-y-2 text-sm leading-relaxed">
        <p className={complete ? "text-green-300" : "text-white/75"}>
          {t(
            complete
              ? "completeDescription"
              : uncertain
                ? "uncertainDescription"
                : flow.depositConfirmed
                  ? "depositSafe"
                  : "stepDescription",
          )}
        </p>
        {displayError && (
          <p role="alert" className="break-words text-red-300">
            {displayError}
          </p>
        )}
      </div>

      {flow.status === "unknown" && !flow.hashes[flow.step] && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (validHash && !verifying) void verify(() => onAttachHash(hash.trim() as Hex));
          }}
        >
          <label htmlFor={`stake-hash-${flow.asset}`} className="block text-sm font-medium">
            {t("hashLabel")}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={`stake-hash-${flow.asset}`}
              value={hash}
              onChange={(event) => setHash(event.target.value)}
              placeholder="0x..."
              autoComplete="off"
              spellCheck={false}
              disabled={verifying}
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-white/20 bg-white/5 px-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-amber-400"
            />
            <button
              type="submit"
              disabled={!validHash || verifying}
              className={`${buttonClass} border border-white/20`}
            >
              <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
              {t("verifyHash")}
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {complete ? (
          <button
            type="button"
            onClick={onComplete}
            className={`${buttonClass} bg-amber-400 text-black`}
          >
            <Check className="h-4 w-4 shrink-0" aria-hidden />
            {t("done")}
          </button>
        ) : (
          <>
            {canContinue && (
              <button
                type="button"
                onClick={() => void onContinue()}
                className={`${buttonClass} bg-amber-400 text-black`}
              >
                <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
                {t(`actions.${flow.step}`)}
              </button>
            )}
            <button
              type="button"
              onClick={() => void verify(onCheck)}
              disabled={verifying}
              className={`${buttonClass} border border-white/20`}
            >
              <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
              {t("check")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className={`${buttonClass} text-white/70 hover:bg-white/5`}
            >
              <X className="h-4 w-4 shrink-0" aria-hidden />
              {t("close")}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
