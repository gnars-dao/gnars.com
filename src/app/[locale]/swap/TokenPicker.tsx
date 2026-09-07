"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Coins,
  ExternalLink,
  Landmark,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Wallet,
  X,
} from "lucide-react";
import { isAddress, type Address } from "viem";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { swapTokenDirectorySchema } from "@/lib/swap-token-directory";
import { cn } from "@/lib/utils";
import { NATIVE_TOKEN, type SwapChain, type SwapToken, type WalletToken } from "./chains";
import {
  compactTokenBalance,
  filterPickerTokens,
  mergePickerTokens,
  tokenAddressLabel,
  tokenKey,
  walletPickerTokens,
} from "./tokenPickerModel";
import { useTokenBalance } from "./useTokenBalance";
import { useTokenLookup } from "./useWalletTokens";

type Group = "wallet" | "creator" | "stock";
const GROUPS: Group[] = ["wallet", "creator", "stock"];
const ICONS = { wallet: Wallet, creator: Sparkles, stock: Landmark };
const SOURCE_NAMES = {
  zora: "Zora",
  clanker: "Clanker",
  ondo: "Ondo",
  xstocks: "xStocks",
  coinbase: "Coinbase",
};

function TokenLogo({ token, size = 32 }: { token: SwapToken; size?: number }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [token.logo]);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-semibold text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {token.logo && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={token.logo}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        token.symbol.slice(0, 1)
      )}
    </span>
  );
}

interface TokenPickerProps {
  value: SwapToken;
  tokens: readonly SwapToken[];
  exclude?: `0x${string}`;
  onSelect: (token: SwapToken) => void;
  label: string;
  chain: SwapChain;
  userAddress?: Address;
  isConnected: boolean;
  usdValues?: Map<string, number>;
  walletTokens: readonly WalletToken[];
  walletLoading: boolean;
  walletError: boolean;
  onRetryWallet: () => void;
}

export default function TokenPicker({
  value,
  tokens,
  exclude,
  onSelect,
  label,
  chain,
  userAddress,
  isConnected,
  usdValues,
  walletTokens,
  walletLoading,
  walletError,
  onRetryWallet,
}: TokenPickerProps) {
  const t = useTranslations("swap.tokenPicker");
  const locale = useLocale();
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [lookupAddress, setLookupAddress] = React.useState("");
  const [activeGroup, setActiveGroup] = React.useState<Group>("wallet");
  const [walletView, setWalletView] = React.useState<"balances" | "crypto">("crypto");
  const [creatorSource, setCreatorSource] = React.useState<"all" | "zora" | "clanker">("all");
  React.useEffect(() => {
    const timer = setTimeout(() => setLookupAddress(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  React.useEffect(() => {
    setQuery("");
    setActiveGroup("wallet");
  }, [chain.id]);

  const directory = useQuery({
    queryKey: ["swap-token-directory", chain.id],
    enabled: open && chain.id === 8453,
    staleTime: 300_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/swap/tokens?chainId=${chain.id}`, { signal });
      if (!response.ok) throw new Error("Token catalogue unavailable");
      return swapTokenDirectorySchema.parse(await response.json());
    },
  });
  const knownTokens = React.useMemo(
    () => mergePickerTokens(tokens, directory.data?.tokens ?? []),
    [tokens, directory.data],
  );
  const lookup = useTokenLookup({
    address: lookupAddress,
    chainId: chain.id,
    enabled:
      open && !knownTokens.some((token) => tokenKey(token.address) === tokenKey(lookupAddress)),
  });
  const allTokens = React.useMemo(
    () =>
      mergePickerTokens(
        knownTokens,
        lookup.data && lookupAddress === query.trim() ? [lookup.data] : [],
      ),
    [knownTokens, lookup.data, lookupAddress, query],
  );
  const nativeToken =
    chain.tokens.find((token) => token.address === NATIVE_TOKEN) ?? chain.tokens[0];
  const native = useTokenBalance({
    chain,
    token: nativeToken,
    userAddress: open && isConnected ? userAddress : undefined,
  });
  const holdings = React.useMemo(() => {
    if (!native.data || nativeToken.address !== NATIVE_TOKEN) return walletTokens;
    return [
      ...walletTokens,
      {
        ...nativeToken,
        balance: native.data.displayValue,
        displayBalance: native.data.displayValue,
        logoUrl: nativeToken.logo ?? null,
        usdValue: null,
      },
    ];
  }, [walletTokens, native.data, nativeToken]);
  const balanceMap = React.useMemo(
    () => new Map(holdings.map((token) => [tokenKey(token.address), token.displayBalance])),
    [holdings],
  );
  const owned = React.useMemo(
    () => walletPickerTokens(allTokens, holdings, usdValues),
    [allTokens, holdings, usdValues],
  );
  const curatedAddresses = new Set(chain.tokens.map((token) => tokenKey(token.address)));
  const cryptoTokens = allTokens.filter(
    (token) =>
      !token.category &&
      (curatedAddresses.has(tokenKey(token.address)) ||
        (lookup.data && tokenKey(token.address) === tokenKey(lookup.data.address))),
  );
  const rows: Record<Group, SwapToken[]> = {
    wallet: filterPickerTokens(
      query.trim()
        ? mergePickerTokens(owned, cryptoTokens)
        : walletView === "balances"
          ? isConnected
            ? owned
            : []
          : cryptoTokens,
      query,
    ),
    creator: filterPickerTokens(
      allTokens.filter(
        (token) =>
          token.category === "creator" &&
          (creatorSource === "all" || token.source === creatorSource),
      ),
      query,
    ),
    stock: filterPickerTokens(
      allTokens.filter((token) => token.category === "stock"),
      query,
    ),
  };
  const [limits, setLimits] = React.useState<Record<Group, number>>({
    wallet: 60,
    creator: 60,
    stock: 60,
  });
  React.useEffect(
    () => setLimits({ wallet: 60, creator: 60, stock: 60 }),
    [query, walletView, creatorSource],
  );

  function choose(token: SwapToken) {
    if (exclude && tokenKey(token.address) === tokenKey(exclude)) return;
    onSelect(token);
    setOpen(false);
    setQuery("");
  }

  function tokenRow(token: SwapToken) {
    const selected = tokenKey(token.address) === tokenKey(value.address);
    const excluded = !!exclude && tokenKey(token.address) === tokenKey(exclude);
    const balance = balanceMap.get(tokenKey(token.address));
    return (
      <button
        key={token.address}
        type="button"
        data-testid="token-picker-row"
        data-token-address={token.address.toLowerCase()}
        disabled={excluded}
        aria-label={`${token.symbol} · ${token.name} · ${tokenAddressLabel(token)}`}
        aria-pressed={selected}
        onClick={() => choose(token)}
        className={cn(
          "grid min-h-[84px] w-full min-w-0 grid-cols-[32px_minmax(0,1fr)_72px_16px] items-center gap-2 border-b border-border/50 px-4 py-3 text-left transition-colors focus-visible:bg-accent focus-visible:outline-none",
          excluded ? "cursor-not-allowed opacity-40" : "hover:bg-accent",
          selected && "bg-accent/50",
        )}
      >
        <TokenLogo token={token} />
        <span className="block min-w-0 overflow-hidden">
          <span className="block truncate text-sm font-semibold" title={token.symbol}>
            {token.symbol}
          </span>
          <span className="block truncate text-xs text-muted-foreground" title={token.name}>
            {token.name}
          </span>
          <span
            className="block truncate font-mono text-[10px] text-muted-foreground"
            title={token.address}
          >
            {tokenAddressLabel(token) || t("nativeAsset")}
            {token.source ? ` · ${SOURCE_NAMES[token.source]}` : ""}
          </span>
        </span>
        <span
          className="min-w-0 truncate text-right font-mono text-xs tabular-nums text-muted-foreground"
          title={balance}
        >
          {balance !== undefined ? compactTokenBalance(balance, locale) : ""}
        </span>
        <span className="size-4">{selected && <Check className="size-4 text-primary" />}</span>
      </button>
    );
  }

  const isSearchingAddress =
    isAddress(query.trim()) &&
    !knownTokens.some((token) => tokenKey(token.address) === tokenKey(query.trim()));
  function sourceError(group: Group) {
    if (group === "wallet")
      return walletView === "balances" && isConnected && (walletError || native.isError);
    if (chain.id !== 8453) return false;
    if (directory.isError) return true;
    const sources = directory.data?.sources;
    return (
      sources &&
      (group === "creator"
        ? !sources.zora.available || !sources.clanker.available
        : !sources.stocks.available)
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setWalletView(isConnected ? "balances" : "crypto");
          setActiveGroup("wallet");
        } else setQuery("");
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="group inline-flex min-w-0 items-center gap-2 bg-transparent text-left transition-colors"
        >
          <TokenLogo token={value} size={16} />
          <span
            className="max-w-[14ch] truncate text-xs font-semibold uppercase text-muted-foreground transition-colors group-hover:text-foreground"
            title={value.name}
          >
            {value.name}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        data-testid="token-picker"
        className="flex h-[min(820px,92dvh)] min-h-0 w-[calc(100%-1rem)] min-w-0 max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[1280px] sm:w-[calc(100%-3rem)]"
      >
        <DialogHeader className="shrink-0 border-b px-5 py-5 text-left sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="text-xl">{t("dialogTitle")}</DialogTitle>
              <p className="mt-1 text-xs text-muted-foreground">{chain.name}</p>
            </div>
            <DialogClose asChild>
              <Button size="icon" variant="ghost" aria-label={t("close")}>
                <X className="size-4" />
              </Button>
            </DialogClose>
          </div>
          <DialogDescription className="sr-only">{t("dialogDescription")}</DialogDescription>
          <div className="relative mt-4 min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("searchPlaceholder")}
              placeholder={t("searchPlaceholder")}
              className="h-11 min-w-0 w-full pl-10 pr-10"
            />
            {query && (
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-1 top-1 size-9"
                aria-label={t("clearSearch")}
                onClick={() => setQuery("")}
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
          {isSearchingAddress && (lookup.isFetching || lookupAddress !== query.trim()) ? (
            <p role="status" className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t("resolvingToken")}
            </p>
          ) : isSearchingAddress && lookup.isError ? (
            <p role="alert" className="pt-2 text-xs text-destructive">
              {t("lookupUnavailable")}
            </p>
          ) : isSearchingAddress && lookup.isSuccess && !lookup.data ? (
            <p role="status" className="pt-2 text-xs text-muted-foreground">
              {t("noErc20Found")}
            </p>
          ) : null}
        </DialogHeader>
        <div
          role="tablist"
          aria-label={t("categories")}
          className="grid shrink-0 grid-cols-3 border-b lg:hidden"
        >
          {GROUPS.map((group, index) => {
            const Icon = ICONS[group];
            return (
              <button
                key={group}
                role="tab"
                type="button"
                id={`${id}-tab-${group}`}
                aria-controls={`${id}-panel-${group}`}
                aria-selected={activeGroup === group}
                tabIndex={activeGroup === group ? 0 : -1}
                onClick={() => setActiveGroup(group)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 2
                        : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
                  setActiveGroup(GROUPS[next]);
                  document.getElementById(`${id}-tab-${GROUPS[next]}`)?.focus();
                }}
                className={cn(
                  "flex min-w-0 items-center justify-center gap-1.5 border-b-2 px-1 py-3 text-xs font-medium",
                  activeGroup === group
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground",
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{t(`tabs.${group}`)}</span>
                {query && <span className="text-[10px] tabular-nums">{rows[group].length}</span>}
              </button>
            );
          })}
        </div>
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 lg:grid-cols-3 lg:divide-x">
          {GROUPS.map((group) => {
            const Icon = ICONS[group];
            const loading =
              group === "wallet"
                ? walletView === "balances" && (walletLoading || native.isLoading)
                : chain.id === 8453 && directory.isPending;
            return (
              <section
                key={group}
                id={`${id}-panel-${group}`}
                aria-labelledby={`${id}-heading-${group}`}
                data-testid={`token-column-${group}`}
                className={cn(
                  "min-h-0 min-w-0 flex-col overflow-hidden",
                  activeGroup === group ? "flex" : "hidden lg:flex",
                )}
              >
                <div className="min-h-[100px] shrink-0 border-b px-4 py-4">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <h3
                      id={`${id}-heading-${group}`}
                      className="flex min-w-0 items-center gap-2 text-sm font-semibold"
                    >
                      <Icon
                        className={cn(
                          "size-4 shrink-0",
                          group === "creator"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : group === "stock"
                              ? "text-sky-600 dark:text-sky-400"
                              : "text-muted-foreground",
                        )}
                      />
                      {t(`columns.${group}`)}
                    </h3>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {rows[group].length}
                    </span>
                  </div>
                  {group === "wallet" ? (
                    <div className="mt-3 flex gap-1" role="group" aria-label={t("walletFilter")}>
                      <Button
                        size="sm"
                        variant={walletView === "balances" ? "secondary" : "ghost"}
                        className="h-7 px-2 text-xs"
                        aria-pressed={walletView === "balances"}
                        onClick={() => setWalletView("balances")}
                      >
                        <Wallet className="size-3" />
                        {t("balances")}
                      </Button>
                      <Button
                        size="sm"
                        variant={walletView === "crypto" ? "secondary" : "ghost"}
                        className="h-7 px-2 text-xs"
                        aria-pressed={walletView === "crypto"}
                        onClick={() => setWalletView("crypto")}
                      >
                        <Coins className="size-3" />
                        {t("crypto")}
                      </Button>
                    </div>
                  ) : group === "creator" ? (
                    <div className="mt-3 flex gap-1" role="group" aria-label={t("creatorFilter")}>
                      {(["all", "zora", "clanker"] as const).map((source) => (
                        <Button
                          key={source}
                          size="sm"
                          variant={creatorSource === source ? "secondary" : "ghost"}
                          className="h-7 px-2 text-xs"
                          aria-pressed={creatorSource === source}
                          onClick={() => setCreatorSource(source)}
                        >
                          {source === "all" ? t("all") : source === "zora" ? "Zora" : "Clanker"}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <a
                      href="https://brand.base.org/stocks"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Base · Coinbase <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
                {sourceError(group) && (
                  <div
                    role="status"
                    className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground"
                  >
                    <CircleAlert className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      {t(group === "wallet" ? "balancesUnavailable" : "catalogueUnavailable")}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 shrink-0"
                      aria-label={t("retry")}
                      onClick={() => {
                        if (group === "wallet") {
                          onRetryWallet();
                          void native.refetch();
                        } else void directory.refetch();
                      }}
                    >
                      <RefreshCw className="size-3.5" />
                    </Button>
                  </div>
                )}
                <div
                  className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
                  data-testid={`token-scroll-${group}`}
                >
                  {chain.id !== 8453 && group !== "wallet" ? (
                    <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                      {t("baseOnly")}
                    </p>
                  ) : rows[group].length ? (
                    <>
                      {rows[group].slice(0, limits[group]).map(tokenRow)}
                      {rows[group].length > limits[group] && (
                        <div className="p-4">
                          <Button
                            variant="outline"
                            className="w-full"
                            onClick={() =>
                              setLimits((current) => ({ ...current, [group]: current[group] + 60 }))
                            }
                          >
                            {t("showMore")}
                          </Button>
                        </div>
                      )}
                    </>
                  ) : loading ? (
                    <div
                      role="status"
                      className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
                    >
                      <Loader2 className="size-4 animate-spin" />
                      {t("loading")}
                    </div>
                  ) : (
                    !sourceError(group) && (
                      <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                        {t(
                          group === "wallet" && walletView === "balances" && !query
                            ? isConnected
                              ? "noBalances"
                              : "connectForBalances"
                            : "noTokensFound",
                        )}
                      </p>
                    )
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
