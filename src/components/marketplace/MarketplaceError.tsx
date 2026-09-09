"use client";

import { useTranslations } from "next-intl";
import { CircleAlert } from "lucide-react";

const errorMessages: Record<string, string> = {
  TRANSACTION_REVERTED: "reverted",
  WALLET_CHANGED: "walletChanged",
  OPENSEA_CONDUIT_INVALID: "conduitInvalid",
  OPENSEA_SIGNATURE_INVALID: "signature",
  OPENSEA_FEE_INVALID: "feesChanged",
  OPENSEA_FEES_CHANGED: "feesChanged",
  OPENSEA_ZONE_INVALID: "zoneInvalid",
  ORDER_NO_LONGER_VALID: "orderInvalid",
  ORDER_CHANGED: "orderChanged",
  ORDER_ALREADY_OWNED: "alreadyOwned",
  INSUFFICIENT_BALANCE: "insufficientBalance",
  SIMULATION_FAILED: "simulationFailed",
  INVALID_FULFILLMENT: "invalidFulfillment",
  MARKETPLACE_RPC_UNAVAILABLE: "providerUnavailable",
  wallet: "rejected",
  OPENSEA_ORDER_REJECTED: "orderRejected",
  INVALID_REQUEST: "orderRejected",
  OPENSEA_RATE_LIMITED: "rateLimited",
  OPENSEA_AUTH_ERROR: "providerAuth",
  OPENSEA_UNAVAILABLE: "providerUnavailable",
  OPENSEA_INVALID_RESPONSE: "providerUnavailable",
  MARKETPLACE_UNAVAILABLE: "providerUnavailable",
  REQUEST_FAILED: "providerUnavailable",
  PUBLICATION_UNCONFIRMED: "publication",
  unavailable: "unavailable",
};

export function MarketplaceError({
  error,
}: {
  error: { code: string; message?: string; requestId?: string; retryable?: boolean };
}) {
  const t = useTranslations("marketplace");
  const key = errorMessages[error.code] ?? "generic";
  return (
    <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p>{t(`errors.${key}`)}</p>
        {error.requestId && (
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {t("requestId")}: {error.requestId}
          </p>
        )}
      </div>
    </div>
  );
}
