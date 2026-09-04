"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronRight,
  ExternalLink,
  Info,
  Lock,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { formatEther, parseEther } from "viem";
import { useBalance } from "wagmi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConnectButton } from "@/components/ui/ConnectButton";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  EOA_GAS_RESERVE,
  SEQUENTIAL_PROMPTS_PER_COIN,
  useExecuteMigration,
  type CoinToMigrate,
  type ExecuteResult,
  type MigrationStep,
} from "@/hooks/use-execute-migration";
import {
  buildRoute,
  formatCoinAmount,
  useCoinQuotes,
  useMigratableCoins,
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

export function MigrationWidget() {
  const t = useTranslations("migrate");
  const { address, isConnected, canSwitchView, viewMode, adminAddress } = useUserAddress();
  const { coins, isLoading, isError, refetch } = useMigratableCoins(address);
  const position = useUpgraderPosition();

  // Selection is keyed by lowercase address.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  // Old $gnars is not in the Zora list (it is the coin being migrated away
  // from); the holder opts it into the sale explicitly from its own card, and
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

  const selectedCoins = React.useMemo(() => {
    const picked = coins.filter((c) => selected.has(c.address.toLowerCase()));
    // `sellAmount` is the clamped portion the quote was actually made for —
    // using the raw typed value here could send a sell larger than the balance.
    if (includeOldGnars && oldGnars.sellAmount !== undefined && oldGnars.sellAmount > 0n) {
      picked.push(oldGnarsAsCoin(oldGnars.sellAmount));
    }
    return picked;
  }, [coins, selected, includeOldGnars, oldGnars.sellAmount]);

  const toggle = (addr: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = addr.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(coins.map((c) => c.address.toLowerCase())));
  const clearAll = () => {
    setSelected(new Set());
    setIncludeOldGnars(false);
    setOldGnarsAmount("");
  };

  if (!isConnected) {
    // The migration's state and its risk disclosure are public facts; they
    // must not sit behind the connect wall.
    return (
      <div className="space-y-10">
        <StageRail position={position} />
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <p className="text-sm text-muted-foreground">{t("connectPrompt")}</p>
          <ConnectButton />
        </Card>
        <section className="space-y-4">
          <SectionHeading title={t("stages.deposit")} body={t("sections.depositBody")} />
          <DepositSection position={position} connected={false} />
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <StageRail position={position} />

      <section className="space-y-4">
        <SectionHeading title={t("stages.sell")} body={t("sections.sellBody")} />

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" />
          {t("safetyHint")}
        </p>

        <OldGnarsCard
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
          coinsElsewhereHint={
            canSwitchView && viewMode === "sa" && adminAddress
              ? t("coinsElsewhere", {
                  address: `${adminAddress.slice(0, 6)}…${adminAddress.slice(-4)}`,
                  button: t("deposit.switchButtonEoa"),
                })
              : undefined
          }
          onRetry={() => void refetch()}
          selected={selected}
          onToggle={toggle}
          onSelectAll={selectAll}
          onClearAll={clearAll}
        />
        {selectedCoins.length > 0 && (
          <MigrationPreview
            coins={selectedCoins}
            sender={address}
            onRun={(result) => {
              // Anything that ran changed balances: refresh regardless of outcome.
              position.refetch();
              void refetch();
              void oldGnars.refetchBalance();
              // Keep the failed coins selected so the retry is one click, and
              // keep the step list on screen as the record of what failed.
              if (result.ok) clearAll();
            }}
          />
        )}
      </section>

      <section className="space-y-4">
        <SectionHeading
          title={position.executed ? t("stages.claim") : t("stages.deposit")}
          body={position.executed ? undefined : t("sections.depositBody")}
        />
        <DepositSection position={position} connected />
      </section>
    </div>
  );
}

/** Section heading: the stage this group of cards belongs to. */
function SectionHeading({ title, body }: { title: string; body?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-base font-semibold">{title}</h2>
      {body && <p className="text-sm text-muted-foreground">{body}</p>}
    </div>
  );
}

/**
 * Orientation for the whole page: the three stages of the migration and where
 * the person stands in each. Every status is derived from state already read,
 * never guessed — the deposit stage reuses the terminal's own status wording.
 */
function StageRail({ position }: { position: UpgraderPosition }) {
  const t = useTranslations("migrate");
  const live = isMigrationDepositLive();
  const claimStatus = position.executed
    ? position.claimed
      ? t("stages.claimedShort")
      : t("stages.open")
    : t("stages.afterLaunch");
  const stages = [
    { label: t("stages.sell"), status: t("stages.now") },
    { label: t("stages.deposit"), status: t(`deposit.${depositStatusKey(live, position)}`) },
    { label: t("stages.claim"), status: claimStatus },
  ];

  return (
    <ol className="grid grid-cols-3 gap-2 rounded-lg border p-3">
      {stages.map((stage, i) => (
        <li key={i} className="flex flex-col items-center gap-1 text-center">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
            {i + 1}
          </span>
          <span className="text-[11px] font-medium leading-tight sm:text-sm">{stage.label}</span>
          <span className="text-[10px] leading-tight text-muted-foreground sm:text-xs">
            {stage.status}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Old $gnars shaped like a Zora coin so the quote and run paths treat it uniformly. */
/** Quick portions for the old $gnars sell. 100% leads and is styled as the
 *  recommendation: the point of the migration is to leave the old coin behind. */
const OLD_GNARS_PORTIONS = [
  { pct: 100, labelKey: "oldGnars.portionAll" },
  { pct: 75, labelKey: "oldGnars.portion75" },
  { pct: 50, labelKey: "oldGnars.portion50" },
  { pct: 25, labelKey: "oldGnars.portion25" },
] as const;

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

/**
 * The sell leg for people who already hold old $gnars. ETH-only means the only
 * way in for them is selling into the thin $gnars → ZORA → WETH pool, so this
 * card quotes that sale first and shows the price impact as a number. It also
 * says, in so many words, that holding and doing nothing is a legitimate choice.
 */
function OldGnarsCard({
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

  const impact = position.quote?.impactBps;
  const impactPct = impact === null || impact === undefined ? null : impact / 100;
  // Typing more than you hold is caught here rather than at signing time; the
  // hook already clamps the quote, so this only explains why the number stopped
  // following the field.
  const overBalance = (() => {
    const raw = amount.trim();
    if (!raw || position.balance === undefined) return false;
    try {
      return parseEther(raw) > position.balance;
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
    <Card className="space-y-4 p-5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{t("oldGnars.title")}</div>
        <p className="mt-1 text-xs text-muted-foreground">{t("oldGnars.body")}</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <StatTile
          label={t("oldGnars.balance")}
          value={`${formatCoinAmount(position.balance, 18, 0)} $GNARS`}
          loading={false}
        />
        <StatTile
          label={t("oldGnars.estimate")}
          value={
            position.isQuoteError
              ? t("oldGnars.noRoute")
              : position.quote
                ? `${formatCoinAmount(position.quote.out, 18, 6)} ETH`
                : undefined
          }
          loading={position.isQuoting}
        />
        <div className="rounded-lg border p-2 text-center">
          <div className="text-xs text-muted-foreground">{t("oldGnars.impact")}</div>
          <div className={`mt-0.5 text-sm font-semibold tabular-nums ${impactTone}`}>
            {position.isQuoting ? (
              <Skeleton className="mx-auto h-4 w-12" />
            ) : impactPct === null ? (
              t("oldGnars.impactUnknown")
            ) : (
              `−${impactPct.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
            )}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("oldGnars.impactHint")}</p>

      <div className="space-y-2 rounded-lg border p-3">
        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox
            checked={included}
            disabled={position.isQuoteError || !position.quote}
            onCheckedChange={(v) => onIncludedChange(v === true)}
            className="mt-0.5"
          />
          <span className="text-sm">
            <span className="font-medium">{t("oldGnars.include")}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t("oldGnars.includeHint")}
            </span>
          </span>
        </label>

        {included && position.balance !== undefined && position.balance > 0n && (
          <div className="space-y-2 pl-8">
            <label className="text-xs text-muted-foreground" htmlFor="old-gnars-amount">
              {t("oldGnars.amountLabel")}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="old-gnars-amount"
                inputMode="decimal"
                placeholder={formatEther(position.balance)}
                value={amount}
                onChange={(e) => onAmountChange(normalizeDecimalInput(e.target.value))}
              />
              <span className="text-sm font-medium text-muted-foreground">$GNARS</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {OLD_GNARS_PORTIONS.map(({ pct, labelKey }) => (
                <Button
                  key={pct}
                  type="button"
                  variant={pct === 100 ? "secondary" : "outline"}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    onAmountChange(formatEther((position.balance! * BigInt(pct)) / 100n))
                  }
                >
                  {t(labelKey)}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{t("oldGnars.allHint")}</p>
            {overBalance && (
              <p className="text-[11px] text-destructive">{t("oldGnars.exceedsBalance")}</p>
            )}
          </div>
        )}
        <Separator />
        <div className="text-sm">
          <span className="font-medium">{t("oldGnars.holdTitle")}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t("oldGnars.holdBody")}
          </span>
        </div>
      </div>
    </Card>
  );
}

/**
 * The migration deposit terminal — deposit ETH, withdraw it while the window is
 * open, claim the new $gnars after the operator runs execute(). Gated until both
 * the contract address and the upgrade id are configured; a malformed config
 * renders as an error rather than as "opens at launch".
 */
function DepositSection({
  position,
  connected,
}: {
  position: UpgraderPosition;
  connected: boolean;
}) {
  const t = useTranslations("migrate");
  const live = isMigrationDepositLive();
  const how = t.raw("deposit.how") as string[];

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          {live ? <Wallet className="size-4" /> : <Lock className="size-4 text-muted-foreground" />}
          {t("deposit.title")}
        </span>
        <DepositStatusBadge live={live} position={position} />
      </div>

      {MIGRATION_CONFIG_ERROR ? (
        <ErrorNote>{t("deposit.configError", { error: MIGRATION_CONFIG_ERROR })}</ErrorNote>
      ) : !live ? (
        <p className="text-xs text-muted-foreground">{t("deposit.gatedHint")}</p>
      ) : connected ? (
        <DepositTerminal position={position} />
      ) : (
        <StatTile
          label={t("deposit.totalDeposits")}
          value={
            position.totalDeposited === undefined
              ? undefined
              : `${formatCoinAmount(position.totalDeposited, 18, 4)} ETH`
          }
          loading={position.isLoading}
        />
      )}

      <div className="space-y-2">
        <div className="text-xs font-medium">{t("deposit.howTitle")}</div>
        <ol className="space-y-1.5">
          {how.map((line, i) => (
            <li key={i} className="flex gap-2 text-xs text-muted-foreground">
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                {i + 1}
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ol>
      </div>

      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0" />
        <span>{t("deposit.ownerNote")}</span>
      </p>

      {UPGRADER_ADDRESS && (
        <a
          href={`https://basescan.org/address/${UPGRADER_ADDRESS}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {t("deposit.contractLink")} <ExternalLink className="size-3" />
        </a>
      )}
    </Card>
  );
}

/**
 * The single source of truth for the deposit window's status, shared by the
 * badge and the stage rail so the two can never disagree.
 */
type DepositStatusKey =
  | "misconfigured"
  | "opensAtLaunch"
  | "readFailed"
  | "checking"
  | "halted"
  | "executed"
  | "live";

function depositStatusKey(live: boolean, position: UpgraderPosition): DepositStatusKey {
  if (MIGRATION_CONFIG_ERROR) return "misconfigured";
  if (!live) return "opensAtLaunch";
  if (position.isError) return "readFailed";
  // Not read yet is not "live". Say so until the contract has answered.
  if (position.isLoading || position.halted === undefined || position.executed === undefined)
    return "checking";
  if (position.halted) return "halted";
  if (position.executed) return "executed";
  return "live";
}

function DepositStatusBadge({ live, position }: { live: boolean; position: UpgraderPosition }) {
  const t = useTranslations("migrate");
  const key = depositStatusKey(live, position);
  const label = t(`deposit.${key}`);
  switch (key) {
    case "misconfigured":
    case "readFailed":
    case "halted":
      return <Badge variant="destructive">{label}</Badge>;
    case "opensAtLaunch":
    case "checking":
      return <Badge variant="secondary">{label}</Badge>;
    case "executed":
      return <Badge>{label}</Badge>;
    default:
      return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">{label}</Badge>;
  }
}

/** The live terminal: position, deposit, withdraw, claim. */
function DepositTerminal({ position }: { position: UpgraderPosition }) {
  const t = useTranslations("migrate");
  const { address, viewMode, canSwitchView, adminAddress } = useUserAddress();
  const writer = useWriteAccount();
  const { deposit, withdraw, claim, running, lastTx } = useUpgradeDeposit();
  const [amount, setAmount] = React.useState("");
  const wallet = useBalance({ address: address as `0x${string}` | undefined, chainId: CHAIN.id });

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
      void wallet.refetch();
    }
  };

  if (position.isError) {
    return (
      <ErrorNote>
        <span>{t("deposit.readError")}</span>
        <Button variant="outline" size="sm" className="ml-auto gap-1" onClick={position.refetch}>
          <RefreshCw className="size-3" /> {t("deposit.retry")}
        </Button>
      </ErrorNote>
    );
  }

  const busy = running !== null;
  // Fail safe: until both flags have been READ as false, the window is not
  // known to be open and the buttons stay off.
  const closed = position.executed !== false || position.halted !== false;
  // An EOA pays its own gas: "use all" must leave a reserve or the deposit
  // itself cannot be mined. A sponsored smart account keeps the whole balance.
  const gasReserve = writer?.isEoaSigner ? EOA_GAS_RESERVE : 0n;
  const usableWallet =
    wallet.data && wallet.data.value > gasReserve ? wallet.data.value - gasReserve : 0n;
  // External wallet viewing as its smart account: the ETH is almost always in
  // the admin EOA, not here. Say where it is instead of "more than you hold".
  const ethElsewhere =
    canSwitchView && viewMode === "sa" && wallet.data !== undefined && wallet.data.value === 0n;
  // Three states, on purpose: a readable balance caps the deposit; an
  // unreadable one must never block a legitimate deposit.
  const exceedsWallet = Boolean(wallet.data && parsed !== null && parsed > usableWallet);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <StatTile
          label={t("deposit.yourDeposit")}
          value={
            position.deposited === undefined
              ? undefined
              : `${formatCoinAmount(position.deposited, 18, 6)} ETH`
          }
          loading={position.isLoading}
        />
        <StatTile
          label={t("deposit.totalDeposits")}
          value={
            position.totalDeposited === undefined
              ? undefined
              : `${formatCoinAmount(position.totalDeposited, 18, 4)} ETH`
          }
          loading={position.isLoading}
        />
      </div>

      <OtherAddressNotice position={position} />

      <div className="flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
        <span className="text-muted-foreground">{t("deposit.closeLabel")}</span>
        <span className="font-medium text-amber-700 dark:text-amber-400">
          {position.executed ? t("deposit.closeValueClosed") : t("deposit.closeValue")}
        </span>
      </div>

      {position.executed ? (
        <div className="space-y-2 rounded-lg bg-accent/50 p-4">
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
              onClick={() => void claim().then(afterWrite)}
            >
              {running === "claim" ? <Spinner className="size-4" /> : t("deposit.claimCta")}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {ethElsewhere && adminAddress && (
            <p className="rounded-md border border-primary/40 bg-primary/5 p-2 text-xs text-muted-foreground">
              {t("deposit.ethElsewhere", {
                address: `${adminAddress.slice(0, 6)}…${adminAddress.slice(-4)}`,
                mode: t("deposit.modeEoa"),
                button: t("deposit.switchButtonEoa"),
              })}
            </p>
          )}
          <label className="text-xs text-muted-foreground" htmlFor="migration-eth-amount">
            {t("deposit.amountLabel")}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="migration-eth-amount"
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              disabled={busy || closed}
              onChange={(e) => setAmount(normalizeDecimalInput(e.target.value))}
            />
            <span className="text-sm font-medium text-muted-foreground">ETH</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            {wallet.data ? (
              <button
                type="button"
                className="cursor-pointer underline-offset-2 hover:underline"
                onClick={() => setAmount(formatEther(usableWallet))}
              >
                {t("deposit.walletBalance", {
                  amount: formatCoinAmount(wallet.data.value, 18, 6),
                })}
              </button>
            ) : wallet.isError ? (
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
              size="lg"
              disabled={busy || closed || !parsed || exceedsWallet}
              onClick={() => parsed && void deposit({ amount: parsed }).then(afterWrite)}
            >
              {running === "deposit" ? <Spinner className="size-4" /> : t("deposit.depositCta")}
            </Button>
            <Button
              size="lg"
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
          <p className="text-[11px] text-muted-foreground">
            {t("deposit.withdrawHint", {
              address: position.activeAddress
                ? `${position.activeAddress.slice(0, 6)}…${position.activeAddress.slice(-4)}`
                : "—",
            })}
          </p>
        </div>
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

function StatTile({ label, value, loading }: { label: string; value?: string; loading: boolean }) {
  return (
    <div className="rounded-lg border p-2 text-center">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">
        {value ?? (loading ? <Skeleton className="mx-auto h-4 w-16" /> : "—")}
      </div>
    </div>
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
  onToggle,
  onSelectAll,
  onClearAll,
}: {
  coins: MigratableCoin[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Shown with the empty state when this address's coins live at its other address. */
  coinsElsewhereHint?: string;
  selected: Set<string>;
  onToggle: (addr: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
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

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b p-4">
        <div className="text-sm font-medium">{t("holdingsTitle", { count: coins.length })}</div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onSelectAll}>
            {t("selectAll")}
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
                className="flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors hover:bg-accent"
              >
                <Checkbox checked={isChecked} tabIndex={-1} className="pointer-events-none" />
                <CoinAvatar src={coin.logoUrl} symbol={coin.symbol} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{coin.name}</div>
                  <RouteChips hops={buildRoute(coin).hops} className="mt-1" />
                </div>
                <div className="text-right">
                  <div className="text-sm">
                    {formatCoinAmount(BigInt(coin.balance), coin.decimals)}
                  </div>
                  {coin.usdValue !== null && (
                    <div className="text-xs text-muted-foreground">
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

function MigrationPreview({
  coins,
  sender,
  onRun,
}: {
  coins: MigratableCoin[];
  sender: string | undefined;
  onRun: (result: ExecuteResult) => void;
}) {
  const t = useTranslations("migrate");
  const {
    quotes,
    totalEthOut,
    isLoading: loading,
    failedCount,
    refetchFailed,
  } = useCoinQuotes(coins, sender);
  const { execute, swapAndDeposit, isRunning, steps, canBatch, lastResult } = useExecuteMigration();
  const live = isMigrationDepositLive();

  const routableCount = quotes.filter((q) => q.routable).length;
  // "No liquidity" means the pool is dead; a failed quote means the service
  // is — they are counted apart and only the first one is called illiquid.
  const unroutableCount = quotes.filter((q) => q.status === "no-route").length;

  // Only migrate coins that actually have a route (skip the dead-pool ones).
  const routableAddrs = new Set(
    quotes.filter((q) => q.routable).map((q) => q.address.toLowerCase()),
  );
  const providerByAddr = new Map(quotes.map((q) => [q.address.toLowerCase(), q.provider]));
  const routableCoins: CoinToMigrate[] = coins
    .filter((c) => routableAddrs.has(c.address.toLowerCase()))
    .map((c) => ({
      address: c.address,
      symbol: c.symbol,
      balance: c.balance,
      provider: providerByAddr.get(c.address.toLowerCase()),
    }));
  const kyberCount = quotes.filter((q) => q.provider === "kyber").length;

  // Sequential: the Zora SDK may prompt up to three times per coin (approve,
  // permit signature, swap), then once for the deposit.
  const signatureCount = routableCount * SEQUENTIAL_PROMPTS_PER_COIN + (live ? 1 : 0);

  const run = async (deposit: boolean) => {
    const result = deposit
      ? await swapAndDeposit(routableCoins)
      : await execute(routableCoins, { depositIntoMigration: false });
    if (result) onRun(result);
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{t("preview.title")}</span>
        {loading && <Spinner className="size-4" />}
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{t("preview.selected")}</span>
        <span>{coins.length}</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{t("preview.routable")}</span>
        <span>
          {routableCount}
          {unroutableCount > 0 && (
            <Badge variant="secondary" className="ml-2">
              {t("preview.unroutable", { count: unroutableCount })}
            </Badge>
          )}
        </span>
      </div>

      <Separator />

      <div className="flex items-center justify-center py-1">
        <ArrowDown className="size-5 text-muted-foreground" />
      </div>

      <div className="rounded-lg bg-accent/50 p-4">
        <div className="text-xs text-muted-foreground">{t("preview.youReceive")}</div>
        <div className="mt-1 text-2xl font-bold tabular-nums">
          {loading ? "…" : formatCoinAmount(totalEthOut, 18, 6)}{" "}
          <span className="text-base">ETH</span>
        </div>
      </div>

      {kyberCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("preview.viaKyber", { count: kyberCount })}
        </p>
      )}
      {failedCount > 0 && (
        <ErrorNote>
          <span>{t("preview.quoteFailed", { count: failedCount })}</span>
          <Button variant="outline" size="sm" className="ml-auto gap-1" onClick={refetchFailed}>
            <RefreshCw className="size-3" /> {t("deposit.retry")}
          </Button>
        </ErrorNote>
      )}

      <p className="text-xs text-muted-foreground">{t("preview.slippageNote")}</p>
      {live && <p className="text-xs text-muted-foreground">{t("preview.leftoverNote")}</p>}
      <div className="space-y-2">
        <Disclosure label={t("preview.whyLabel")}>{t("preview.slippageDetails")}</Disclosure>
        <Disclosure label={t("route.detailsLabel")}>
          <RouteMap coins={coins} />
        </Disclosure>
      </div>

      {steps.length > 0 && <StepList steps={steps} />}
      {lastResult?.depositFailed && (
        <ErrorNote>
          <span>
            {t("preview.depositFailedAfterSells", { amount: formatEther(lastResult.received) })}
          </span>
        </ErrorNote>
      )}

      {live ? (
        <>
          <Button
            className="w-full"
            size="lg"
            disabled={loading || isRunning || routableCount === 0}
            onClick={() => void run(true)}
          >
            {isRunning
              ? t("preview.executing")
              : t("preview.migrateAndDepositCta", { count: routableCount })}
          </Button>
          <Button
            className="w-full"
            variant="outline"
            size="lg"
            disabled={loading || isRunning || routableCount === 0}
            onClick={() => void run(false)}
          >
            {t("preview.consolidateOnly")}
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            {t("preview.sellOnlyNote")}
          </p>
        </>
      ) : (
        <Button
          className="w-full"
          size="lg"
          disabled={loading || isRunning || routableCount === 0}
          onClick={() => void run(false)}
        >
          {isRunning ? t("preview.executing") : t("preview.migrateCta", { count: routableCount })}
        </Button>
      )}
      <p className="text-center text-[11px] text-muted-foreground">
        {canBatch
          ? live
            ? t("preview.batchNote")
            : t("preview.batchNoteSellOnly")
          : live
            ? t("preview.sequentialNote", { count: signatureCount })
            : t("preview.sequentialNoteSellOnly", { count: signatureCount })}
      </p>
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
