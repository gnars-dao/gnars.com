"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ExternalLink,
  Lock,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { formatEther, parseEther } from "viem";
import { useBalance } from "wagmi";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConnectButton } from "@/components/ui/ConnectButton";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  EOA_GAS_RESERVE,
  SEQUENTIAL_PROMPTS_PER_COIN,
  useExecuteMigration,
  type CoinToMigrate,
  type MigrationStep,
} from "@/hooks/use-execute-migration";
import {
  buildRoute,
  formatCoinAmount,
  useCoinQuotes,
  useMigratableCoins,
  type CoinQuote,
  type MigratableCoin,
  type RouteHop,
} from "@/hooks/use-gnars-migration";
import { useOldGnarsPosition } from "@/hooks/use-old-gnars-position";
import { useUpgradeDeposit } from "@/hooks/use-upgrade-deposit";
import { useUpgraderPosition, type UpgraderPosition } from "@/hooks/use-upgrader-position";
import { useUserAddress } from "@/hooks/use-user-address";
import { useWriteAccount } from "@/hooks/use-write-account";
import {
  CHAIN,
  GNARS_CREATOR_COIN,
  isMigrationDepositLive,
  MIGRATION_CONFIG_ERROR,
  UPGRADER_ADDRESS,
} from "@/lib/config";
import { normalizeDecimalInput } from "@/lib/decimal-input";
import { cn } from "@/lib/utils";

const OLD_GNARS_KEY = GNARS_CREATOR_COIN.toLowerCase();

/**
 * The migration as a ledger: what you hold on the left (the sources), the
 * deposit on the right (the destination). The right column carries the
 * arithmetic — wallet ETH plus the sells equals what can be deposited — and
 * never leaves the screen: sticky on desktop, first on mobile.
 */
export function MigrationWidget() {
  const t = useTranslations("migrate");
  const { address, isConnected, canSwitchView, viewMode, adminAddress } = useUserAddress();
  const { coins, isLoading, isError, refetch } = useMigratableCoins(address);
  const position = useUpgraderPosition();
  const writer = useWriteAccount();
  const live = isMigrationDepositLive();

  // Selection is keyed by lowercase address.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  // Old $gnars is not in the Zora list (it is the coin being migrated away
  // from); the holder opts it into the sale explicitly from its own row, and
  // chooses how much — selling everything is the recommendation, not a rule.
  const [includeOldGnars, setIncludeOldGnars] = React.useState(false);
  // The portion to sell, as typed. Empty means "not chosen yet" and reads as
  // the whole balance, so opting in without touching the field sells it all.
  const [oldGnarsAmount, setOldGnarsAmount] = React.useState("");
  const typedOldGnars = React.useMemo(() => {
    const raw = oldGnarsAmount.trim();
    if (!raw) return undefined;
    try {
      const v = parseEther(raw);
      return v > 0n ? v : undefined;
    } catch {
      return undefined;
    }
  }, [oldGnarsAmount]);
  const oldGnars = useOldGnarsPosition(address, typedOldGnars);

  const wallet = useBalance({ address: address as `0x${string}` | undefined, chainId: CHAIN.id });
  // An EOA pays its own gas: "max" must leave a reserve or the deposit itself
  // cannot be mined. A sponsored smart account keeps the whole balance.
  const gasReserve = writer?.isEoaSigner ? EOA_GAS_RESERVE : 0n;
  const usableWallet =
    wallet.data && wallet.data.value > gasReserve ? wallet.data.value - gasReserve : 0n;

  const selectedZora = React.useMemo(
    () => coins.filter((c) => selected.has(c.address.toLowerCase())),
    [coins, selected],
  );
  const selectedCoins = React.useMemo(() => {
    const picked = [...selectedZora];
    // `sellAmount` is the clamped portion the quote was actually made for —
    // using the raw typed value here could send a sell larger than the balance.
    if (includeOldGnars && oldGnars.sellAmount !== undefined && oldGnars.sellAmount > 0n) {
      picked.push(oldGnarsAsCoin(oldGnars.sellAmount));
    }
    return picked;
  }, [selectedZora, includeOldGnars, oldGnars.sellAmount]);

  const {
    quotes,
    totalEthOut,
    isLoading: quotesLoading,
    failedCount,
    refetchFailed,
  } = useCoinQuotes(selectedCoins, address);

  const quoteByAddr = React.useMemo(
    () => new Map(quotes.map((q) => [q.address.toLowerCase(), q])),
    [quotes],
  );
  // The receipt splits the sells into their two sources; the total the run
  // deposits is still the hook's own `totalEthOut`.
  const zoraEthOut = React.useMemo(
    () =>
      selectedZora.reduce((sum, c) => {
        const q = quoteByAddr.get(c.address.toLowerCase());
        return sum + (q?.routable ? q.out : 0n);
      }, 0n),
    [selectedZora, quoteByAddr],
  );
  const oldGnarsQuote = quoteByAddr.get(OLD_GNARS_KEY);
  const oldGnarsEthOut = oldGnarsQuote?.routable ? oldGnarsQuote.out : 0n;

  const { execute, swapAndDeposit, isRunning, steps, canBatch, lastResult } = useExecuteMigration();

  // Only migrate coins that actually have a route (skip the dead-pool ones).
  const routableAddrs = React.useMemo(
    () => new Set(quotes.filter((q) => q.routable).map((q) => q.address.toLowerCase())),
    [quotes],
  );
  const providerByAddr = React.useMemo(
    () => new Map(quotes.map((q) => [q.address.toLowerCase(), q.provider])),
    [quotes],
  );
  const routableCoins: CoinToMigrate[] = selectedCoins
    .filter((c) => routableAddrs.has(c.address.toLowerCase()))
    .map((c) => ({
      address: c.address,
      symbol: c.symbol,
      balance: c.balance,
      provider: providerByAddr.get(c.address.toLowerCase()),
    }));
  const routableCount = quotes.filter((q) => q.routable).length;
  const kyberCount = quotes.filter((q) => q.provider === "kyber").length;
  // Sequential: the Zora SDK may prompt up to three times per coin (approve,
  // permit signature, swap), then once for the deposit.
  const signatureCount = routableCount * SEQUENTIAL_PROMPTS_PER_COIN + (live ? 1 : 0);

  const toggle = (addr: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = addr.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // Selected coins the router cannot handle right now: a dead pool ("no-route")
  // and a quote service that fell over ("quote-failed") are different failures
  // and stay labelled apart per row, but neither can be sold in this run, so one
  // action clears both out of the selection.
  const unroutableSelected = React.useMemo(
    () =>
      selectedZora.filter((c) => {
        const q = quoteByAddr.get(c.address.toLowerCase());
        return q?.status === "no-route" || q?.status === "quote-failed";
      }),
    [selectedZora, quoteByAddr],
  );

  const selectAll = () => setSelected(new Set(coins.map((c) => c.address.toLowerCase())));
  const deselectUnroutable = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of unroutableSelected) next.delete(c.address.toLowerCase());
      return next;
    });
  const clearAll = () => {
    setSelected(new Set());
    setIncludeOldGnars(false);
    setOldGnarsAmount("");
  };

  const run = async (deposit: boolean) => {
    const result = deposit
      ? await swapAndDeposit(routableCoins)
      : await execute(routableCoins, { depositIntoMigration: false });
    if (!result) return;
    // Anything that ran changed balances: refresh regardless of outcome.
    position.refetch();
    void refetch();
    void oldGnars.refetchBalance();
    void wallet.refetch();
    // Keep the failed coins selected so the retry is one click, and keep the
    // step list on screen as the record of what failed.
    if (result.ok) clearAll();
  };

  const hasSelection = selectedCoins.length > 0;
  const ctaDisabled = quotesLoading || isRunning || routableCount === 0;
  const ctaLabel = isRunning
    ? t("preview.executing")
    : live
      ? t("preview.sellAndDepositCta", {
          count: routableCount,
          eth: formatCoinAmount(totalEthOut, 18, 4),
        })
      : t("preview.migrateCta", { count: routableCount });
  const primaryCta = (
    <PrimaryCta label={ctaLabel} disabled={ctaDisabled} onClick={() => void run(live)} />
  );

  const coinsElsewhereHint =
    canSwitchView && viewMode === "sa" && adminAddress
      ? t("coinsElsewhere", {
          address: `${adminAddress.slice(0, 6)}…${adminAddress.slice(-4)}`,
          button: t("deposit.switchButtonEoa"),
        })
      : undefined;

  return (
    <>
      <div className="grid items-start gap-6 lg:grid-cols-12">
        {/* Destination first in the DOM: on mobile the deposit is never below
            the fold. On desktop it is placed back on the right by column start. */}
        <section className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:col-span-5 lg:col-start-8 lg:row-start-1">
          <ColumnHeading title={t("receipt.title")} hint={t("receipt.hint")} />

          <Card className="gap-0 overflow-hidden p-0">
            {isConnected && (
              <Receipt
                walletValue={wallet.data?.value}
                walletLoading={wallet.isLoading}
                walletError={wallet.isError}
                gasReserve={gasReserve}
                zoraCount={selectedZora.length}
                zoraEthOut={zoraEthOut}
                oldGnarsIncluded={includeOldGnars}
                oldGnarsEthOut={oldGnarsEthOut}
                available={usableWallet + totalEthOut}
                quotesLoading={quotesLoading}
                failedCount={failedCount}
                onRetryQuotes={refetchFailed}
              />
            )}

            {isConnected && (
              <div className="space-y-3 border-b p-5">
                {hasSelection && (
                  <div className="space-y-3">
                    {primaryCta}
                    {live && (
                      <div className="text-center">
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs text-muted-foreground"
                          disabled={ctaDisabled}
                          onClick={() => void run(false)}
                        >
                          {t("preview.sellOnlyLink")}
                        </Button>
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      {canBatch
                        ? live
                          ? t("preview.batchNote")
                          : t("preview.batchNoteSellOnly")
                        : live
                          ? t("preview.sequentialNote", { count: signatureCount })
                          : t("preview.sequentialNoteSellOnly", { count: signatureCount })}
                    </p>
                    {kyberCount > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        {t("preview.viaKyber", { count: kyberCount })}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground">{t("preview.slippageNote")}</p>
                    <div className="space-y-2">
                      <Disclosure label={t("preview.whyLabel")}>
                        <p>{t("preview.slippageDetails")}</p>
                        {live && <p className="mt-1.5">{t("preview.leftoverNote")}</p>}
                      </Disclosure>
                      <Disclosure label={t("route.detailsLabel")}>
                        <RouteMap coins={selectedCoins} />
                      </Disclosure>
                    </div>
                    {steps.length > 0 && <StepList steps={steps} />}
                    {lastResult?.depositFailed && (
                      <ErrorNote>
                        <span>
                          {t("preview.depositFailedAfterSells", {
                            amount: formatEther(lastResult.received),
                          })}
                        </span>
                      </ErrorNote>
                    )}
                  </div>
                )}

                <DepositPanel
                  position={position}
                  walletValue={wallet.data?.value}
                  walletError={wallet.isError}
                  refetchWallet={() => void wallet.refetch()}
                  usableWallet={usableWallet}
                  gasReserve={gasReserve}
                  separated={hasSelection}
                />
              </div>
            )}

            <PositionBlock position={position} connected={isConnected} />
          </Card>

          <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            <span>
              {t("deposit.ownerNote")}{" "}
              {UPGRADER_ADDRESS && (
                <a
                  href={`https://basescan.org/address/${UPGRADER_ADDRESS}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  {t("deposit.contractLink")} <ExternalLink className="size-3" />
                </a>
              )}
            </span>
          </p>
        </section>

        <section className="flex min-w-0 flex-col gap-4 lg:col-span-7 lg:col-start-1 lg:row-start-1">
          <ColumnHeading title={t("hold.title")} hint={t("hold.hint")} />

          {!isConnected ? (
            <Card className="flex flex-col items-center gap-4 p-10 text-center">
              <p className="text-sm text-muted-foreground">{t("connectPrompt")}</p>
              <ConnectButton />
            </Card>
          ) : (
            <>
              <EthRow
                value={wallet.data?.value}
                loading={wallet.isLoading}
                error={wallet.isError}
              />

              <OldGnarsRow
                position={oldGnars}
                included={includeOldGnars}
                onIncludedChange={setIncludeOldGnars}
                amount={oldGnarsAmount}
                onAmountChange={setOldGnarsAmount}
              />

              <HoldingsList
                coins={coins}
                isLoading={isLoading}
                isError={isError}
                coinsElsewhereHint={coinsElsewhereHint}
                onRetry={() => void refetch()}
                selected={selected}
                quoteByAddr={quoteByAddr}
                onToggle={toggle}
                quotesLoading={quotesLoading}
                unroutableCount={unroutableSelected.length}
                onSelectAll={selectAll}
                onClearAll={clearAll}
                onDeselectUnroutable={deselectUnroutable}
              />

              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="mt-px size-3.5 shrink-0" />
                {t("safetyHint")}
              </p>
            </>
          )}
        </section>
      </div>

      {isConnected && hasSelection && (
        <div className="sticky bottom-0 z-30 border-t bg-background/90 py-3 backdrop-blur lg:hidden">
          {primaryCta}
        </div>
      )}
    </>
  );
}

/** The one action that moves the money, shared by the card and the mobile bar. */
function PrimaryCta({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button className="w-full" size="lg" disabled={disabled} onClick={onClick}>
      {label}
    </Button>
  );
}

function ColumnHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-base font-semibold">{title}</h2>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

/**
 * The receipt: wallet ETH plus the selected sells equals what can be deposited.
 * A balance that has not been read is a skeleton and a failed read says so —
 * neither is ever rendered as zero.
 */
function Receipt({
  walletValue,
  walletLoading,
  walletError,
  gasReserve,
  zoraCount,
  zoraEthOut,
  oldGnarsIncluded,
  oldGnarsEthOut,
  available,
  quotesLoading,
  failedCount,
  onRetryQuotes,
}: {
  walletValue: bigint | undefined;
  walletLoading: boolean;
  walletError: boolean;
  gasReserve: bigint;
  zoraCount: number;
  zoraEthOut: bigint;
  oldGnarsIncluded: boolean;
  oldGnarsEthOut: bigint;
  available: bigint;
  quotesLoading: boolean;
  failedCount: number;
  onRetryQuotes: () => void;
}) {
  const t = useTranslations("migrate");
  const nothingSelected = zoraCount === 0 && !oldGnarsIncluded;

  return (
    <div className="space-y-2.5 border-b p-5">
      <ReceiptRow label={t("receipt.walletEth")}>
        {walletLoading ? (
          <Skeleton className="h-4 w-16" />
        ) : walletError || walletValue === undefined ? (
          <span className="text-muted-foreground">{t("hold.unreadable")}</span>
        ) : (
          formatCoinAmount(walletValue, 18, 4)
        )}
      </ReceiptRow>

      {gasReserve > 0n && walletValue !== undefined && walletValue > 0n && (
        <ReceiptRow label={t("receipt.gasReserve")}>
          {formatCoinAmount(gasReserve, 18, 4)}
        </ReceiptRow>
      )}

      <ReceiptRow
        label={
          zoraCount > 0 ? t("receipt.coinsSold", { count: zoraCount }) : t("receipt.coinsNone")
        }
      >
        {nothingSelected ? (
          <span className="text-muted-foreground">{t("receipt.nothingSelected")}</span>
        ) : quotesLoading ? (
          <Skeleton className="h-4 w-16" />
        ) : (
          formatCoinAmount(zoraEthOut, 18, 4)
        )}
      </ReceiptRow>

      {oldGnarsIncluded && (
        <ReceiptRow label={t("receipt.oldGnarsSold")}>
          {quotesLoading ? (
            <Skeleton className="h-4 w-16" />
          ) : (
            formatCoinAmount(oldGnarsEthOut, 18, 4)
          )}
        </ReceiptRow>
      )}

      <div className="h-px bg-border" />

      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{t("receipt.available")}</span>
        <span className="text-xl font-bold tabular-nums">
          {formatCoinAmount(available, 18, 4)}{" "}
          <span className="text-sm font-medium text-muted-foreground">ETH</span>
        </span>
      </div>

      {failedCount > 0 && (
        <ErrorNote>
          <span>{t("preview.quoteFailed", { count: failedCount })}</span>
          <Button variant="outline" size="sm" className="ml-auto gap-1" onClick={onRetryQuotes}>
            <RefreshCw className="size-3" /> {t("deposit.retry")}
          </Button>
        </ErrorNote>
      )}
    </div>
  );
}

function ReceiptRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}

/**
 * Deposit ETH from the wallet, withdraw it while the window is open. Gated
 * until both the contract address and the upgrade id are configured; a
 * malformed config renders as an error rather than as "opens at launch".
 */
function DepositPanel({
  position,
  walletValue,
  walletError,
  refetchWallet,
  usableWallet,
  gasReserve,
  separated,
}: {
  position: UpgraderPosition;
  walletValue: bigint | undefined;
  walletError: boolean;
  refetchWallet: () => void;
  usableWallet: bigint;
  gasReserve: bigint;
  separated: boolean;
}) {
  const t = useTranslations("migrate");
  const { viewMode, canSwitchView, adminAddress } = useUserAddress();
  const { deposit, withdraw, running, lastTx } = useUpgradeDeposit();
  const [amount, setAmount] = React.useState("");
  const live = isMigrationDepositLive();

  const parsed = React.useMemo(() => {
    if (amount.trim() === "") return null;
    try {
      const v = parseEther(amount.trim());
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount]);

  const afterWrite = (outcome: "confirmed" | "sent" | "failed" | "cancelled" | "refused") => {
    // "sent" is a landed broadcast whose receipt we could not see: treat it as
    // done on our side (clear the input, refetch) — never as a failure.
    if (outcome === "confirmed" || outcome === "sent") {
      setAmount("");
      position.refetch();
      refetchWallet();
    }
  };

  // Deposits are over once the launch has run; the claim lives in the position
  // block below, so this sub-block simply steps aside.
  if (position.executed === true) return null;

  const wrap = (children: React.ReactNode) => (
    <div className={cn("space-y-2", separated && "border-t pt-4")}>
      <div className="flex items-center gap-2 text-sm font-medium">
        {live ? <Wallet className="size-4" /> : <Lock className="size-4 text-muted-foreground" />}
        {t("deposit.fromWallet")}
      </div>
      {children}
    </div>
  );

  if (MIGRATION_CONFIG_ERROR) {
    return wrap(
      <ErrorNote>{t("deposit.configError", { error: MIGRATION_CONFIG_ERROR })}</ErrorNote>,
    );
  }
  if (!live) {
    return wrap(
      <>
        <p className="text-xs font-medium text-muted-foreground">{t("deposit.opensAtLaunch")}</p>
        <p className="text-[11px] text-muted-foreground">{t("deposit.gatedHint")}</p>
      </>,
    );
  }
  if (position.isError) {
    return wrap(
      <ErrorNote>
        <span>{t("deposit.readError")}</span>
        <Button variant="outline" size="sm" className="ml-auto gap-1" onClick={position.refetch}>
          <RefreshCw className="size-3" /> {t("deposit.retry")}
        </Button>
      </ErrorNote>,
    );
  }

  const busy = running !== null;
  // Fail safe: until both flags have been READ as false, the window is not
  // known to be open and the buttons stay off.
  const closed = position.executed !== false || position.halted !== false;
  // External wallet viewing as its smart account: the ETH is almost always in
  // the admin EOA, not here. Say where it is instead of "more than you hold".
  const ethElsewhere = canSwitchView && viewMode === "sa" && walletValue === 0n;
  // Three states, on purpose: a readable balance caps the deposit; an
  // unreadable one must never block a legitimate deposit.
  const exceedsWallet = Boolean(
    walletValue !== undefined && parsed !== null && parsed > usableWallet,
  );

  return wrap(
    <>
      {ethElsewhere && adminAddress && (
        <p className="rounded-md border border-primary/40 bg-primary/5 p-2 text-xs text-muted-foreground">
          {t("deposit.ethElsewhere", {
            address: `${adminAddress.slice(0, 6)}…${adminAddress.slice(-4)}`,
            mode: t("deposit.modeEoa"),
            button: t("deposit.switchButtonEoa"),
          })}
        </p>
      )}

      <label className="block text-xs text-muted-foreground" htmlFor="migration-eth-amount">
        {t("deposit.amountLabel")}
      </label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            id="migration-eth-amount"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            disabled={busy || closed}
            className="pr-12"
            onChange={(e) => setAmount(normalizeDecimalInput(e.target.value))}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            ETH
          </span>
        </div>
        <Button
          variant="outline"
          disabled={busy || closed || walletValue === undefined}
          onClick={() => setAmount(formatEther(usableWallet))}
        >
          {t("deposit.max")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        {walletValue !== undefined ? (
          <span>
            {t("deposit.walletBalance", { amount: formatCoinAmount(walletValue, 18, 6) })}
          </span>
        ) : walletError ? (
          <span>{t("deposit.walletBalanceUnavailable")}</span>
        ) : (
          <span />
        )}
        {position.deposited !== undefined && position.deposited > 0n && (
          <button
            type="button"
            className="cursor-pointer underline-offset-2 hover:underline"
            onClick={() => setAmount(formatEther(position.deposited!))}
          >
            {t("deposit.fillDeposited")}
          </button>
        )}
      </div>
      {gasReserve > 0n && (
        <p className="text-[11px] text-muted-foreground">
          {t("deposit.gasReserveHint", { amount: formatEther(gasReserve) })}
        </p>
      )}

      {parsed !== null && (
        <p className="text-sm">
          <span className="text-muted-foreground">{t("deposit.amountEcho")} </span>
          <span className="font-semibold tabular-nums">{formatEther(parsed)} ETH</span>
          {exceedsWallet && (
            <span className="ml-2 text-destructive">{t("deposit.exceedsWallet")}</span>
          )}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button
          disabled={busy || closed || !parsed || exceedsWallet}
          onClick={() => parsed && void deposit({ amount: parsed }).then(afterWrite)}
        >
          {running === "deposit" ? <Spinner className="size-4" /> : t("deposit.depositCta")}
        </Button>
        <Button
          variant="outline"
          disabled={
            busy ||
            closed ||
            !parsed ||
            position.deposited === undefined ||
            parsed > position.deposited
          }
          onClick={() => parsed && void withdraw({ amount: parsed }).then(afterWrite)}
        >
          {running === "withdraw" ? <Spinner className="size-4" /> : t("deposit.withdrawCta")}
        </Button>
      </div>

      {lastTx && (
        <p className="text-[11px] text-muted-foreground">
          {lastTx.confirmed ? t("deposit.lastTxConfirmed") : t("deposit.lastTxPending")}{" "}
          <a
            href={`https://basescan.org/tx/${lastTx.hash}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline underline-offset-2"
          >
            {lastTx.hash.slice(0, 10)}…{lastTx.hash.slice(-6)}
          </a>
        </p>
      )}
    </>,
  );
}

/**
 * What the deposit is and what it becomes. After the operator runs the launch
 * this block is the claim: the deposit is gone and the new $gnars is what is
 * left to collect.
 */
function PositionBlock({
  position,
  connected,
}: {
  position: UpgraderPosition;
  connected: boolean;
}) {
  const t = useTranslations("migrate");
  const { claim, running } = useUpgradeDeposit();
  const busy = running !== null;

  if (connected && position.executed === true) {
    return (
      <div className="space-y-3 bg-muted/40 p-5">
        <div className="text-xs text-muted-foreground">{t("deposit.claimTitle")}</div>
        <div className="text-2xl font-bold tabular-nums">
          {position.claimable === undefined ? "…" : formatCoinAmount(position.claimable, 18, 2)}{" "}
          <span className="text-base">$GNARS</span>
        </div>
        {position.claimed ? (
          <p className="text-xs text-muted-foreground">{t("deposit.claimed")}</p>
        ) : (
          <Button
            className="w-full"
            size="lg"
            disabled={busy || !position.claimable || position.claimable === 0n}
            onClick={() =>
              void claim().then((outcome) => {
                if (outcome === "confirmed" || outcome === "sent") position.refetch();
              })
            }
          >
            {running === "claim" ? <Spinner className="size-4" /> : t("deposit.claimCta")}
          </Button>
        )}
        <OtherAddressNotice position={position} />
        <p className="text-[11px] text-muted-foreground">
          {t("deposit.withdrawHint", {
            address: position.activeAddress
              ? `${position.activeAddress.slice(0, 6)}…${position.activeAddress.slice(-4)}`
              : "—",
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 bg-muted/40 p-5">
      {connected && (
        <ReceiptRow label={t("deposit.depositedSoFar")}>
          {position.isLoading ? (
            <Skeleton className="h-4 w-16" />
          ) : position.deposited === undefined ? (
            "—"
          ) : (
            `${formatCoinAmount(position.deposited, 18, 6)} ETH`
          )}
        </ReceiptRow>
      )}
      <ReceiptRow label={t("deposit.totalDeposits")}>
        {position.isLoading ? (
          <Skeleton className="h-4 w-16" />
        ) : position.totalDeposited === undefined ? (
          "—"
        ) : (
          `${formatCoinAmount(position.totalDeposited, 18, 4)} ETH`
        )}
      </ReceiptRow>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="text-muted-foreground">{t("deposit.becomesLabel")}</span>
        <span className="flex items-center gap-2">
          <span className="size-3 shrink-0 rounded-full bg-yellow-400" />
          {t("deposit.becomesValue")}
        </span>
      </div>

      {connected && (
        <>
          <OtherAddressNotice position={position} />
          <p className="text-[11px] text-muted-foreground">
            {t("deposit.withdrawHint", {
              address: position.activeAddress
                ? `${position.activeAddress.slice(0, 6)}…${position.activeAddress.slice(-4)}`
                : "—",
            })}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * One person, two addresses. When the wallet's other view mode holds a deposit
 * (or a claim), say so and name the mode to switch to — withdraw and claim must
 * be signed by the address that deposited, and a silent "0 ETH" here would read
 * as a lost deposit.
 */
function OtherAddressNotice({ position }: { position: UpgraderPosition }) {
  const t = useTranslations("migrate");
  const other = position.other;
  if (!other) return null;
  const hasDeposit = other.deposited !== undefined && other.deposited > 0n;
  const hasClaim = other.claimable !== undefined && other.claimable > 0n && other.claimed === false;
  if (!hasDeposit && !hasClaim) return null;
  const short = `${other.address.slice(0, 6)}…${other.address.slice(-4)}`;
  const modeLabel = t(other.mode === "sa" ? "deposit.modeSa" : "deposit.modeEoa");
  const buttonLabel = t(other.mode === "sa" ? "deposit.switchButtonSa" : "deposit.switchButtonEoa");
  return (
    <div className="space-y-1 rounded-md border border-primary/40 bg-primary/5 p-3 text-xs">
      <div className="font-medium">
        {hasDeposit
          ? t("deposit.otherAddressDeposit", {
              amount: formatCoinAmount(other.deposited!, 18, 6),
              address: short,
            })
          : t("deposit.otherAddressClaim", { address: short })}
      </div>
      <p className="text-muted-foreground">
        {t("deposit.otherAddressHint", { mode: modeLabel, button: buttonLabel })}
      </p>
    </div>
  );
}

/** ETH already in the wallet: the one holding the migration takes as it is. */
function EthRow({
  value,
  loading,
  error,
}: {
  value: bigint | undefined;
  loading: boolean;
  error: boolean;
}) {
  const t = useTranslations("migrate");
  return (
    <Card className="flex-row items-center gap-3 p-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
        <Wallet className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t("hold.ethTitle")}</div>
        <div className="text-xs text-muted-foreground">{t("hold.ethReady")}</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold tabular-nums">
          {loading ? (
            <Skeleton className="ml-auto h-4 w-20" />
          ) : error || value === undefined ? (
            <span className="text-xs font-normal text-muted-foreground">
              {t("hold.unreadable")}
            </span>
          ) : (
            `${formatCoinAmount(value, 18, 4)} ETH`
          )}
        </div>
        <div className="text-xs text-emerald-600 dark:text-emerald-400">{t("hold.accepted")}</div>
      </div>
    </Card>
  );
}

/** Old $gnars shaped like a Zora coin so the quote and run paths treat it uniformly. */
function oldGnarsAsCoin(balance: bigint): MigratableCoin {
  return {
    address: GNARS_CREATOR_COIN,
    symbol: "$GNARS",
    name: "Gnars (old)",
    decimals: 18,
    balance: balance.toString(),
    displayBalance: formatEther(balance),
    logoUrl: null,
    usdValue: null,
    marketCap: null,
    pairedWith: { address: "0x1111111111166b7FE7bd91427724B487980aFc69", name: "ZORA" },
  };
}

/** Quick portions for the old $gnars sell. 100% leads and is styled as the
 *  recommendation: the point of the migration is to leave the old coin behind. */
const OLD_GNARS_PORTIONS = [
  { pct: 100, labelKey: "oldGnars.portionAll" },
  { pct: 75, labelKey: "oldGnars.portion75" },
  { pct: 50, labelKey: "oldGnars.portion50" },
  { pct: 25, labelKey: "oldGnars.portion25" },
] as const;

/**
 * The sell leg for people who already hold old $gnars. ETH-only means the only
 * way in for them is selling into the thin $gnars → ZORA → WETH pool, so this
 * row quotes that sale and shows the price impact as a number. It also says, in
 * so many words, that holding and doing nothing is a legitimate choice.
 */
function OldGnarsRow({
  position,
  included,
  onIncludedChange,
  amount,
  onAmountChange,
}: {
  position: ReturnType<typeof useOldGnarsPosition>;
  included: boolean;
  onIncludedChange: (v: boolean) => void;
  amount: string;
  onAmountChange: (v: string) => void;
}) {
  const t = useTranslations("migrate");

  if (position.isBalanceLoading) {
    return (
      <Card className="p-4">
        <Skeleton className="h-12 w-full" />
      </Card>
    );
  }
  if (position.isBalanceError) {
    return (
      <Card className="p-5">
        <ErrorNote>
          <span>{t("oldGnars.balanceError")}</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-1"
            onClick={() => void position.refetchBalance()}
          >
            <RefreshCw className="size-3" /> {t("deposit.retry")}
          </Button>
        </ErrorNote>
      </Card>
    );
  }
  // Unknown is not zero: keep the skeleton until the balance has been read.
  if (position.balance === undefined) {
    return (
      <Card className="p-4">
        <Skeleton className="h-12 w-full" />
      </Card>
    );
  }
  if (position.balance === 0n) return null;

  const balance = position.balance;
  const impact = position.quote?.impactBps;
  const impactPct = impact === null || impact === undefined ? null : impact / 100;
  // Typing more than you hold is caught here rather than at signing time; the
  // hook already clamps the quote, so this only explains why the number stopped
  // following the field.
  const overBalance = (() => {
    const raw = amount.trim();
    if (!raw) return false;
    try {
      return parseEther(raw) > balance;
    } catch {
      return false;
    }
  })();
  const impactTone =
    impactPct === null
      ? "text-muted-foreground"
      : impactPct >= 10
        ? "text-destructive"
        : impactPct >= 3
          ? "text-amber-700 dark:text-amber-400"
          : "text-foreground";

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex items-center gap-3 p-4">
        <Checkbox
          checked={included}
          disabled={position.isQuoteError || !position.quote}
          aria-label={t("oldGnars.include")}
          onCheckedChange={(v) => onIncludedChange(v === true)}
        />
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-yellow-400 text-xs font-bold text-black">
          G
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("oldGnars.title")}</div>
          <div className="text-xs text-muted-foreground">{t("oldGnars.body")}</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">
            {formatCoinAmount(balance, 18, 0)}
          </div>
          <div className="text-xs tabular-nums text-muted-foreground">
            {position.isQuoting ? (
              <Skeleton className="ml-auto h-3.5 w-16" />
            ) : position.isQuoteError ? (
              t("oldGnars.noRoute")
            ) : position.quote ? (
              `≈ ${formatCoinAmount(position.quote.out, 18, 6)} ETH`
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2 border-t p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {OLD_GNARS_PORTIONS.map(({ pct, labelKey }) => (
              <Button
                key={pct}
                type="button"
                variant={pct === 100 ? "secondary" : "outline"}
                size="sm"
                className="h-8 px-2.5 text-xs"
                onClick={() => onAmountChange(formatEther((balance * BigInt(pct)) / 100n))}
              >
                {t(labelKey)}
              </Button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-xs">
            <span className="whitespace-nowrap text-muted-foreground">{t("oldGnars.impact")}</span>
            <span className={cn("font-semibold tabular-nums", impactTone)}>
              {position.isQuoting ? (
                <Skeleton className="h-4 w-10" />
              ) : impactPct === null ? (
                t("oldGnars.impactUnknown")
              ) : (
                `−${impactPct.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
              )}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            id="old-gnars-amount"
            aria-label={t("oldGnars.amountLabel")}
            className="h-8"
            inputMode="decimal"
            placeholder={formatEther(balance)}
            value={amount}
            onChange={(e) => onAmountChange(normalizeDecimalInput(e.target.value))}
          />
          <span className="text-xs font-medium text-muted-foreground">$GNARS</span>
        </div>
      </div>

      <div className="space-y-1 border-t px-4 py-3">
        {overBalance && (
          <p className="text-[11px] text-destructive">{t("oldGnars.exceedsBalance")}</p>
        )}
        <p className="text-[11px] text-muted-foreground">
          {t("oldGnars.impactHint")} {t("oldGnars.holdBody")}
        </p>
      </div>
    </Card>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
      <AlertTriangle className="size-3.5 shrink-0" />
      {children}
    </p>
  );
}

/**
 * Step-by-step route map: groups the selected coins by their first hop, then
 * shows the shared tail into ETH. Purely explanatory — each coin is one trade.
 */
function RouteMap({ coins }: { coins: MigratableCoin[] }) {
  const t = useTranslations("migrate");

  const groups = React.useMemo(() => {
    const map = new Map<string, { via: RouteHop; tail: RouteHop[]; sources: MigratableCoin[] }>();
    for (const coin of coins) {
      const { hops } = buildRoute(coin);
      const via = hops[1];
      const key = `${via.kind}:${via.label}`;
      const existing = map.get(key);
      if (existing) existing.sources.push(coin);
      else map.set(key, { via, tail: hops.slice(2), sources: [coin] });
    }
    return Array.from(map.values());
  }, [coins]);

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {groups.map((g, i) => (
          <div key={i} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {g.sources.map((c) => (
                <span
                  key={c.address}
                  className="max-w-[9rem] truncate rounded-md border bg-background px-1.5 py-0.5 text-[11px] leading-tight text-muted-foreground"
                >
                  {c.symbol}
                </span>
              ))}
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
              <RouteChips hops={[g.via, ...g.tail]} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("route.hopHint")}</p>
    </div>
  );
}

/** A one-click disclosure for detail that would otherwise crowd the decision. */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-md border px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        {label}
      </summary>
      <div className="mt-2 text-xs text-muted-foreground">{children}</div>
    </details>
  );
}

/** Renders a routing path as connected chips: coin → creator → ZORA → ETH. */
function RouteChips({ hops, className }: { hops: RouteHop[]; className?: string }) {
  const chipClass = (kind: RouteHop["kind"]) => {
    switch (kind) {
      case "eth":
        return "bg-primary/15 text-primary font-semibold";
      case "zora":
        return "bg-accent text-foreground";
      case "creator":
        return "bg-muted text-foreground";
      default:
        return "bg-background text-muted-foreground border";
    }
  };
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className ?? ""}`}>
      {hops.map((hop, i) => (
        <React.Fragment key={`${hop.label}-${i}`}>
          <span
            className={`max-w-[10rem] truncate rounded-md px-1.5 py-0.5 text-[11px] leading-tight ${chipClass(hop.kind)}`}
          >
            {hop.label}
          </span>
          {i < hops.length - 1 && (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/** Small round coin avatar: logo when available, symbol initial otherwise. */
function CoinAvatar({ src, symbol }: { src: string | null; symbol: string }) {
  const [errored, setErrored] = React.useState(false);
  if (src && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={symbol}
        width={32}
        height={32}
        className="size-8 shrink-0 rounded-full object-cover"
        onError={() => setErrored(true)}
      />
    );
  }
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold uppercase text-muted-foreground">
      {symbol.slice(0, 2)}
    </div>
  );
}

function HoldingsList({
  coins,
  isLoading,
  isError,
  onRetry,
  coinsElsewhereHint,
  selected,
  quoteByAddr,
  onToggle,
  quotesLoading,
  unroutableCount,
  onSelectAll,
  onClearAll,
  onDeselectUnroutable,
}: {
  coins: MigratableCoin[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Shown with the empty state when this address's coins live at its other address. */
  coinsElsewhereHint?: string;
  selected: Set<string>;
  quoteByAddr: Map<string, CoinQuote>;
  onToggle: (addr: string) => void;
  /** True while any selected coin is still being quoted. */
  quotesLoading: boolean;
  /** Selected coins with no route or a failed quote. */
  unroutableCount: number;
  onSelectAll: () => void;
  onClearAll: () => void;
  onDeselectUnroutable: () => void;
}) {
  const t = useTranslations("migrate");

  if (isLoading) {
    return (
      <Card className="p-4">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="p-5">
        <ErrorNote>
          <span>{t("holdingsError")}</span>
          <Button variant="outline" size="sm" className="ml-auto gap-1" onClick={onRetry}>
            <RefreshCw className="size-3" /> {t("deposit.retry")}
          </Button>
        </ErrorNote>
      </Card>
    );
  }

  if (coins.length === 0) {
    return (
      <Card className="space-y-2 p-10 text-center text-sm text-muted-foreground">
        <p>{t("noCoins")}</p>
        {coinsElsewhereHint && <p className="text-xs">{coinsElsewhereHint}</p>}
      </Card>
    );
  }

  const selectedCount = coins.filter((c) => selected.has(c.address.toLowerCase())).length;

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{t("hold.zoraTitle")}</span>
          <span className="text-xs text-muted-foreground">
            {unroutableCount > 0
              ? t("hold.selectedCountNoRoute", {
                  selected: selectedCount,
                  total: coins.length,
                  noRoute: unroutableCount,
                })
              : t("hold.selectedCount", { selected: selectedCount, total: coins.length })}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onSelectAll}>
            {t("selectAll")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDeselectUnroutable}
            disabled={unroutableCount === 0}
          >
            {unroutableCount > 0
              ? t("hold.deselectUnroutableCount", { count: unroutableCount })
              : t("hold.deselectUnroutable")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClearAll} disabled={selected.size === 0}>
            {t("clear")}
          </Button>
        </div>
      </div>
      <ul className="max-h-[420px] divide-y overflow-y-auto">
        {coins.map((coin) => {
          const key = coin.address.toLowerCase();
          const isChecked = selected.has(key);
          const quote = quoteByAddr.get(key);
          const noRoute = quote?.status === "no-route";
          const quoteFailed = quote?.status === "quote-failed";
          // A selected coin with no quote yet is still being priced: a skeleton,
          // never a blank that reads as "nothing to get".
          const quotePending = isChecked && quote === undefined && quotesLoading;
          return (
            <li key={key}>
              {/* A div, not a button: the Checkbox is itself a button and buttons
                  cannot nest. Keyboard reachable via tabIndex + Enter/Space. */}
              <div
                role="button"
                tabIndex={0}
                aria-pressed={isChecked}
                onClick={() => onToggle(coin.address)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggle(coin.address);
                  }
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors hover:bg-accent",
                  noRoute && "opacity-60",
                )}
              >
                <Checkbox checked={isChecked} tabIndex={-1} className="pointer-events-none" />
                <CoinAvatar src={coin.logoUrl} symbol={coin.symbol} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{coin.name}</div>
                  <div className="truncate text-xs tabular-nums text-muted-foreground">
                    {formatCoinAmount(BigInt(coin.balance), coin.decimals)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  {quotePending ? (
                    <Skeleton className="ml-auto h-4 w-20" />
                  ) : noRoute ? (
                    <div className="text-xs text-muted-foreground">{t("hold.noLiquidity")}</div>
                  ) : quoteFailed ? (
                    <div className="flex items-center justify-end gap-1 text-xs text-destructive">
                      <AlertTriangle className="size-3 shrink-0" />
                      {t("hold.quoteFailed")}
                    </div>
                  ) : quote?.routable ? (
                    <div className="text-sm font-medium tabular-nums">
                      ≈ {formatCoinAmount(quote.out, 18, 4)} ETH
                    </div>
                  ) : null}
                  {coin.usdValue !== null && (
                    <div className="text-xs tabular-nums text-muted-foreground">
                      ${coin.usdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Per-step progress for the run (one row per swap, plus the deposit). */
function StepList({ steps }: { steps: MigrationStep[] }) {
  return (
    <ol className="space-y-1.5 rounded-lg border p-3">
      {steps.map((step, i) => (
        <li key={i} className="flex items-center gap-2 text-sm">
          {step.status === "done" ? (
            <Check className="size-4 text-primary" />
          ) : step.status === "failed" ? (
            <X className="size-4 text-destructive" />
          ) : step.status === "active" ? (
            <Spinner className="size-4" />
          ) : (
            <span className="size-4 rounded-full border" />
          )}
          <span
            className={
              step.status === "failed"
                ? "text-destructive"
                : step.status === "pending"
                  ? "text-muted-foreground"
                  : ""
            }
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
