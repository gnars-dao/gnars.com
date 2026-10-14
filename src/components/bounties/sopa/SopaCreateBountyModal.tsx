"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeftRight, Loader2, PlusCircle } from "lucide-react";
import { erc20Abi, zeroAddress } from "viem";
import { useBalance, useReadContracts } from "wagmi";
import { Markdown } from "@/components/common/Markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { sopaBountiesKey } from "@/hooks/use-poidh-sopa-bounties";
import { sopaCalls, usePoidhSopaWrite } from "@/hooks/use-poidh-sopa-write";
import { useRouter } from "@/i18n/navigation";
import { POIDH_SOPA } from "@/lib/config";
import { POIDH_SOPA_ABI } from "@/lib/poidh-sopa/abi";
import { SOPA_CATEGORIES, type SopaCategory } from "@/lib/poidh-sopa/categories";
import { extractCreatedBountyId } from "@/lib/poidh-sopa/receipt";
import { formatTokenAmount, isEthToken, parseTokenAmountInput } from "@/lib/poidh-sopa/tokens";
import { CHAIN_NAMES } from "@/lib/poidh/config";
import { cn } from "@/lib/utils";
import { useSopaWallet } from "./use-sopa-wallet";

const TITLE_MIN = 3;
const TITLE_MAX = 80;
const DESC_MIN = 10;
const DESC_MAX = 5000;

/** Networks Sopa is deployed on. Base only for now; the select stays for future chains. */
const NETWORKS = [{ chainId: POIDH_SOPA.chainId, name: CHAIN_NAMES[8453] }];

interface SopaCreateBountyModalProps {
  children?: React.ReactNode;
}

export function SopaCreateBountyModal({ children }: SopaCreateBountyModalProps) {
  const t = useTranslations("bounties");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { address, isConnected, wrongNetwork, isSwitching, connect, switchToBase } =
    useSopaWallet();
  const write = usePoidhSopaWrite();

  const [open, setOpen] = useState(false);
  const [chainId, setChainId] = useState<number>(POIDH_SOPA.chainId);
  const [kind, setKind] = useState<"open" | "solo">("open");
  const [category, setCategory] = useState<SopaCategory | "">("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(() => t("sopa.create.descriptionTemplate"));
  const [descTab, setDescTab] = useState<"write" | "preview">("write");
  const [amount, setAmount] = useState("0.01");
  const [tokenAddress, setTokenAddress] = useState<`0x${string}`>(POIDH_SOPA.tokens[0].address);
  const [createdWithoutId, setCreatedWithoutId] = useState(false);

  const network = NETWORKS.find((n) => n.chainId === chainId) ?? NETWORKS[0];
  // Tokens come from config per network; Sopa is Base-only so the list is the config list.
  const tokens = POIDH_SOPA.tokens;
  const token = tokens.find((tk) => tk.address === tokenAddress) ?? tokens[0];
  const isEth = isEthToken(token.address);
  const amountRaw = parseTokenAmountInput(amount, token.decimals);

  const sopa = POIDH_SOPA.address ?? zeroAddress;
  const owner = (address ?? zeroAddress) as `0x${string}`;

  const { data: ethBalance } = useBalance({
    address: address as `0x${string}` | undefined,
    chainId: POIDH_SOPA.chainId,
    query: { enabled: open && !!address && isEth },
  });

  const { data: reads } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: sopa, abi: POIDH_SOPA_ABI, functionName: "MIN_BOUNTY_AMOUNT", chainId },
      { address: sopa, abi: POIDH_SOPA_ABI, functionName: "poidhFeeBps", chainId },
      { address: sopa, abi: POIDH_SOPA_ABI, functionName: "sopaFeeBps", chainId },
      {
        address: token.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
        chainId,
      },
      {
        address: token.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, sopa],
        chainId,
      },
    ],
    query: { enabled: open && !!POIDH_SOPA.address },
  });

  const minEth = reads?.[0]?.status === "success" ? (reads[0].result as bigint) : null;
  const feeBps =
    reads?.[1]?.status === "success" && reads?.[2]?.status === "success"
      ? Number(reads[1].result) + Number(reads[2].result)
      : null;
  const tokenBalance =
    !isEth && reads?.[3]?.status === "success" ? (reads[3].result as bigint) : null;
  const allowance = !isEth && reads?.[4]?.status === "success" ? (reads[4].result as bigint) : null;
  const balance = isEth ? (ethBalance?.value ?? null) : tokenBalance;

  const titleOk = title.trim().length >= TITLE_MIN && title.trim().length <= TITLE_MAX;
  const descOk = description.trim().length >= DESC_MIN && description.length <= DESC_MAX;
  const belowMin = isEth && amountRaw !== null && minEth !== null && amountRaw < minEth;
  const complete = Boolean(category) && titleOk && descOk && amountRaw !== null && !belowMin;
  const insufficient = amountRaw !== null && balance !== null && balance < amountRaw;
  const needsApproval =
    !isEth && amountRaw !== null && (allowance === null || allowance < amountRaw);

  const amountLabel = amountRaw !== null ? formatTokenAmount(amountRaw, token.decimals, 6) : "0";

  const categoryLabel = category ? t(`sopa.categories.${category}`) : "—";
  const summary = useMemo(
    () => [
      { label: t("sopa.create.networkLabel"), value: network.name },
      { label: t("sopa.create.typeLabel"), value: t(`sopa.type.${kind}`) },
      { label: t("sopa.create.categoryLabel"), value: categoryLabel },
      {
        label: t("sopa.create.rewardLabel"),
        value: amountRaw !== null ? `${amountLabel} ${token.symbol}` : "—",
      },
    ],
    [t, network.name, kind, categoryLabel, amountRaw, amountLabel, token.symbol],
  );

  const resetForm = () => {
    setKind("open");
    setCategory("");
    setTitle("");
    setDescription(t("sopa.create.descriptionTemplate"));
    setDescTab("write");
    setAmount("0.01");
    setTokenAddress(POIDH_SOPA.tokens[0].address);
    setCreatedWithoutId(false);
  };

  const handleOpenChange = (value: boolean) => {
    if (!value && write.isPending) return; // keep the modal while a tx is in flight
    if (!value) {
      if (write.isSuccess) resetForm();
      write.reset();
    }
    setOpen(value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!complete || amountRaw === null || !category || insufficient || wrongNetwork) return;
    try {
      const receipt = await write.run({
        approve: isEth ? undefined : { token: token.address, amount: amountRaw },
        build: sopaCalls.createBounty({
          kind,
          token: token.address,
          amount: amountRaw,
          title: title.trim(),
          description: description.trim(),
          category,
        }),
      });
      void queryClient.invalidateQueries({ queryKey: sopaBountiesKey });
      const id = POIDH_SOPA.address
        ? extractCreatedBountyId(receipt.logs ?? [], POIDH_SOPA.address)
        : null;
      if (id === null) {
        setCreatedWithoutId(true);
        return;
      }
      resetForm();
      write.reset();
      setOpen(false);
      router.push(`/community/bounties/sopa/${id}`);
    } catch {
      // error is shown inline from the hook
    }
  };

  const pendingLabel =
    write.phase === "confirming"
      ? t("sopa.create.waitingConfirmation")
      : write.phase === "approving"
        ? t("sopa.create.approveInWallet")
        : t("sopa.create.confirmInWallet");

  const mainLabel = needsApproval
    ? t("sopa.create.approveAndFund", { amount: amountLabel, token: token.symbol })
    : t("sopa.create.createAndFund", { amount: amountLabel, token: token.symbol });

  const renderPrimary = () => {
    if (!isConnected) {
      return (
        <Button type="button" className="flex-1 cursor-pointer" onClick={connect}>
          {t("sopa.create.connectWallet")}
        </Button>
      );
    }
    if (wrongNetwork) {
      return (
        <Button
          type="button"
          className="flex-1 cursor-pointer"
          onClick={switchToBase}
          disabled={isSwitching}
        >
          {isSwitching ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <ArrowLeftRight className="w-4 h-4 mr-2" />
              {t("sopa.create.switchTo", { network: network.name })}
            </>
          )}
        </Button>
      );
    }
    return (
      <Button
        type="submit"
        className="flex-1 cursor-pointer"
        disabled={write.isPending || !complete || insufficient}
      >
        {write.isPending ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            {pendingLabel}
            {write.step && ` (${write.step.current}/${write.step.total})`}
          </>
        ) : write.phase === "error" ? (
          t("sopa.create.retry")
        ) : (
          mainLabel
        )}
      </Button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {children ?? (
          <Button>
            <PlusCircle className="w-4 h-4 mr-2" />
            {t("cta.createBounty")}
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-[720px] max-h-[92vh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-4 pr-8">
            <div className="space-y-1.5 text-left">
              <DialogTitle>{t("sopa.create.title")}</DialogTitle>
              <DialogDescription>{t("sopa.create.subtitle")}</DialogDescription>
            </div>
            <Image
              src="/gnars.webp"
              alt="Gnars"
              width={44}
              height={44}
              className="h-[22px] w-[22px] shrink-0 rounded-sm"
            />
          </div>
        </DialogHeader>

        {createdWithoutId ? (
          <div className="py-6 space-y-4 text-center">
            <p className="font-semibold">{t("sopa.create.createdTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("sopa.create.createdNoId")}</p>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t("cta.close")}
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5 pt-1">
            {/* Network | Type */}
            <div className="grid grid-cols-1 min-[560px]:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sopa-network">{t("sopa.create.networkLabel")}</Label>
                <Select
                  value={String(chainId)}
                  onValueChange={(v) => setChainId(Number(v))}
                  disabled={write.isPending}
                >
                  <SelectTrigger id="sopa-network" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {NETWORKS.map((n) => (
                      <SelectItem key={n.chainId} value={String(n.chainId)}>
                        {n.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sopa-type">{t("sopa.create.typeLabel")}</Label>
                <Select
                  value={kind}
                  onValueChange={(v) => setKind(v as "open" | "solo")}
                  disabled={write.isPending}
                >
                  <SelectTrigger id="sopa-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">{t("sopa.create.typeOpen")}</SelectItem>
                    <SelectItem value="solo">{t("sopa.create.typeSolo")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Category chips (radiogroup) */}
            <div className="space-y-2">
              <Label id="sopa-category-label">{t("sopa.create.categoryLabel")}</Label>
              <RadioGroupPrimitive.Root
                aria-labelledby="sopa-category-label"
                value={category}
                onValueChange={(v) => setCategory(v as SopaCategory)}
                disabled={write.isPending}
                className="flex flex-wrap gap-2"
              >
                {SOPA_CATEGORIES.map((c) => (
                  <RadioGroupPrimitive.Item
                    key={c}
                    value={c}
                    className={cn(
                      "cursor-pointer rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors outline-none",
                      "border-border bg-muted/40 text-foreground hover:bg-muted",
                      "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring",
                      "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    {t(`sopa.categories.${c}`)}
                  </RadioGroupPrimitive.Item>
                ))}
              </RadioGroupPrimitive.Root>
            </div>

            {/* Title */}
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="sopa-title">{t("sopa.create.titleLabel")}</Label>
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    title.length > TITLE_MAX ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {title.length}/{TITLE_MAX}
                </span>
              </div>
              <Input
                id="sopa-title"
                placeholder={t("sopa.create.titlePlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={TITLE_MAX}
                disabled={write.isPending}
                aria-describedby="sopa-title-hint"
              />
              <p id="sopa-title-hint" className="text-xs text-muted-foreground">
                {t("sopa.create.titleHint")}
              </p>
            </div>

            {/* Description (Markdown) */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="sopa-description">{t("sopa.create.descriptionLabel")}</Label>
                <Tabs value={descTab} onValueChange={(v) => setDescTab(v as "write" | "preview")}>
                  <TabsList className="h-8">
                    <TabsTrigger value="write" className="text-xs">
                      {t("sopa.create.write")}
                    </TabsTrigger>
                    <TabsTrigger value="preview" className="text-xs">
                      {t("sopa.create.preview")}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
              {descTab === "write" ? (
                <Textarea
                  id="sopa-description"
                  className="min-h-[160px] resize-y font-mono text-sm"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={DESC_MAX}
                  disabled={write.isPending}
                />
              ) : (
                <div className="min-h-[160px] rounded-md border border-input px-3 py-2">
                  {description.trim() ? (
                    <Markdown className="prose-sm">{description}</Markdown>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("sopa.create.nothingToPreview")}
                    </p>
                  )}
                </div>
              )}
              <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span>{t("sopa.create.descriptionHint")}</span>
                <span className="tabular-nums">
                  {description.length}/{DESC_MAX}
                </span>
              </div>
            </div>

            {/* Reward: amount + token */}
            <div className="space-y-1.5">
              <Label htmlFor="sopa-amount">{t("sopa.create.rewardLabel")}</Label>
              <div className="flex gap-2">
                <Input
                  id="sopa-amount"
                  inputMode="decimal"
                  placeholder="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={write.isPending}
                  className="flex-1"
                  aria-invalid={amount !== "" && amountRaw === null}
                />
                <Select
                  value={token.address}
                  onValueChange={(v) => setTokenAddress(v as `0x${string}`)}
                  disabled={write.isPending}
                >
                  <SelectTrigger className="w-[150px]" aria-label={t("sopa.create.tokenLabel")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tokens.map((tk) => (
                      <SelectItem key={tk.address} value={tk.address}>
                        {tk.symbol}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!isEth && (
                <p className="text-xs text-muted-foreground">
                  {write.canBatch ? t("sopa.create.erc20HintBatch") : t("sopa.create.erc20Hint")}
                </p>
              )}
              {belowMin && minEth !== null && (
                <p className="text-xs text-destructive">
                  {t("sopa.create.minimum", { amount: formatTokenAmount(minEth, 18, 6) })}
                </p>
              )}
              {isConnected && insufficient && (
                <p className="text-xs text-destructive" role="alert">
                  {t("sopa.create.insufficientBalance", { token: token.symbol })}
                </p>
              )}
            </div>

            {/* Live summary */}
            <dl className="grid grid-cols-2 min-[560px]:grid-cols-4 gap-px overflow-hidden rounded-lg border border-border bg-border">
              {summary.map((s) => (
                <div key={s.label} className="bg-muted/40 px-3 py-2.5">
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {s.label}
                  </dt>
                  <dd className="mt-0.5 text-sm font-semibold truncate">{s.value}</dd>
                </div>
              ))}
            </dl>

            <p className="text-xs text-muted-foreground">
              {kind === "open" ? t("createModal.openNote") : t("createModal.soloNote")}
              {feeBps !== null && (
                <> {t("sopa.create.feeNote", { fee: (feeBps / 100).toString() })}</>
              )}
            </p>

            {write.error && (
              <div
                className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  {write.error.key ? t(`sopa.errors.${write.error.key}`) : write.error.message}
                </span>
              </div>
            )}

            <div className="flex flex-col-reverse min-[560px]:flex-row gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                className="flex-1 cursor-pointer"
                onClick={() => handleOpenChange(false)}
                disabled={write.isPending}
              >
                {t("cta.cancel")}
              </Button>
              {renderPrimary()}
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
