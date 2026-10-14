"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Wallet } from "lucide-react";
import { useReadContracts } from "wagmi";
import { Button } from "@/components/ui/button";
import { sopaCalls, usePoidhSopaWrite } from "@/hooks/use-poidh-sopa-write";
import { POIDH_SOPA, type PoidhSopaToken } from "@/lib/config";
import { POIDH_SOPA_ABI } from "@/lib/poidh-sopa/abi";
import { formatTokenAmount } from "@/lib/poidh-sopa/tokens";
import { getTxUrl } from "@/lib/poidh/config";

function TokenRow({
  token,
  amount,
  onDone,
}: {
  token: PoidhSopaToken;
  amount: bigint;
  onDone: () => void;
}) {
  const t = useTranslations("bounties");
  const write = usePoidhSopaWrite();

  // Fire once per successful withdraw (onDone's identity changes on every parent render).
  const notified = useRef(false);
  useEffect(() => {
    if (write.isSuccess && !notified.current) {
      notified.current = true;
      onDone();
    }
    if (!write.isSuccess) notified.current = false;
  }, [write.isSuccess, onDone]);

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 p-3 rounded-md border border-amber-500/30 bg-amber-500/10 text-sm">
      <Wallet className="w-4 h-4 text-amber-400 shrink-0 mt-0.5 sm:mt-0" />
      <div className="flex-1 min-w-0">
        <span className="font-medium text-amber-300">
          {t("sopa.withdrawal.claimable", {
            amount: formatTokenAmount(amount, token.decimals, token.decimals <= 6 ? 2 : 6),
            token: token.symbol,
          })}
        </span>
        <p className="text-xs text-muted-foreground mt-0.5">{t("sopa.withdrawal.description")}</p>
      </div>
      {write.isSuccess ? (
        <div className="flex items-center gap-1.5 text-emerald-400 text-xs shrink-0">
          <CheckCircle2 className="w-4 h-4" />
          <span>{t("pendingWithdrawal.withdrawn")}</span>
          {write.hash && (
            <a
              href={getTxUrl(POIDH_SOPA.chainId, write.hash)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-0.5 hover:underline ml-1"
            >
              {t("detail.viewTx")} <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 whitespace-nowrap cursor-pointer"
            disabled={write.isPending}
            onClick={() => write.run({ build: sopaCalls.withdraw(token.address) }).catch(() => {})}
          >
            {write.isPending ? (
              <>
                <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                {t("detail.withdrawing")}
              </>
            ) : (
              t("sopa.withdrawal.withdraw", { token: token.symbol })
            )}
          </Button>
          {write.error && (
            <div className="flex items-start gap-1 text-destructive text-xs max-w-[12rem]">
              <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
              <span className="break-words">
                {write.error.key ? t(`sopa.errors.${write.error.key}`) : write.error.message}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Per-token pending balances on PoidhSopa (`pendingWithdrawals(account, token)`). */
export function SopaWithdrawalBanner({ userAddress }: { userAddress: `0x${string}` }) {
  const address = POIDH_SOPA.address;
  const { data, refetch } = useReadContracts({
    allowFailure: true,
    contracts: POIDH_SOPA.tokens.map((token) => ({
      address: address ?? undefined,
      abi: POIDH_SOPA_ABI,
      functionName: "pendingWithdrawals" as const,
      args: [userAddress, token.address] as const,
      chainId: POIDH_SOPA.chainId,
    })),
    query: { enabled: !!address, refetchInterval: 30_000 },
  });

  // Rows withdrawn this session stay mounted (showing "withdrawn" + tx link) after the
  // refetch reads 0, instead of vanishing the moment the withdraw confirms.
  const [withdrawn, setWithdrawn] = useState<ReadonlySet<string>>(() => new Set());
  const onDone = useCallback(
    (tokenAddress: string) => {
      setWithdrawn((prev) => new Set(prev).add(tokenAddress.toLowerCase()));
      void refetch();
    },
    [refetch],
  );

  if (!address || !data) return null;

  return (
    <>
      {POIDH_SOPA.tokens.map((token, i) => {
        const r = data[i];
        const amount = r?.status === "success" ? (r.result as bigint) : 0n;
        if (amount === 0n && !withdrawn.has(token.address.toLowerCase())) return null;
        return (
          <TokenRow
            key={token.address}
            token={token}
            amount={amount}
            onDone={() => onDone(token.address)}
          />
        );
      })}
    </>
  );
}
