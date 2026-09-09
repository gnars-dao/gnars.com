"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  ImagePlus,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/ui/ConnectButton";
import { Input } from "@/components/ui/input";
import { useCreateNft } from "@/hooks/use-create-nft";
import { Link } from "@/i18n/navigation";

export function CreateNft() {
  const t = useTranslations("createNft");
  const status = useQuery({
    queryKey: ["community-nft-contract"],
    queryFn: async () => {
      const response = await fetch("/api/create-nft/status");
      if (!response.ok) throw new Error();
      return response.json() as Promise<{
        ready: boolean;
        address?: Address;
        royaltyBps?: number;
        recipient?: Address;
      }>;
    },
    staleTime: 60000,
    retry: 1,
  });
  const actions = useCreateNft(status.data?.ready ? status.data.address : undefined);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rights, setRights] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const saved = actions.journal;
  const blocked = actions.busy || !!saved;
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href="/marketplace"
        className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground"
      >
        <ArrowLeft className="size-4" />
        {t("back")}
      </Link>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold">{t("title")}</h1>
        <ConnectButton />
      </div>
      {status.isPending ? (
        <p>{t("loading")}</p>
      ) : status.isError ? (
        <p role="alert">{t("failed")}</p>
      ) : !status.data.ready ? (
        <p role="status" className="border-y py-6 text-muted-foreground">
          {t("notDeployed")}
        </p>
      ) : (
        <>
          <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="min-w-0">
              <label
                htmlFor="nft-artwork"
                className="relative flex aspect-square w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/20 transition-colors hover:border-foreground/50"
              >
                {preview ? (
                  <Image
                    unoptimized
                    width={1024}
                    height={1024}
                    src={preview}
                    alt={name || t("media")}
                    className="size-full object-contain"
                  />
                ) : (
                  <span className="flex flex-col items-center gap-3">
                    <ImagePlus className="size-10 text-muted-foreground" />
                    {t("chooseMedia")}
                  </span>
                )}
              </label>
              <input
                id="nft-artwork"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                disabled={blocked}
                className="mt-3 w-full text-sm"
                onChange={(event) => {
                  const value = event.target.files?.[0];
                  if (!value) return;
                  if (
                    !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.type) ||
                    value.size > 20 * 1024 * 1024 ||
                    !value.size
                  ) {
                    setMediaError(true);
                    return;
                  }
                  setMediaError(false);
                  setFile(value);
                }}
              />
              <p className="mt-2 text-xs text-muted-foreground">{t("mediaTypes")}</p>
              {mediaError && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {t("invalidMedia")}
                </p>
              )}
            </section>
            <section className="min-w-0 space-y-5">
              <p className="text-sm text-muted-foreground">{t("collection")} / Base / ERC-721</p>
              <div className="space-y-2">
                <label htmlFor="nft-name">{t("name")}</label>
                <Input
                  id="nft-name"
                  maxLength={100}
                  value={name}
                  disabled={blocked}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="nft-description">{t("description")}</label>
                <textarea
                  id="nft-description"
                  maxLength={2000}
                  value={description}
                  disabled={blocked}
                  onChange={(e) => setDescription(e.target.value)}
                  className="min-h-28 w-full rounded-md border bg-transparent p-3 text-sm"
                />
              </div>
              <dl className="space-y-3 border-y py-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt>{t("royalty")}</dt>
                  <dd>{(status.data.royaltyBps ?? 0) / 100}%</dd>
                </div>
                <div className="break-all text-muted-foreground">
                  {t("recipient")}: {status.data.recipient}
                </div>
              </dl>
              <p className="text-sm text-muted-foreground">{t("membership")}</p>
              <p className="text-sm text-muted-foreground">{t("permanent")}</p>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={rights}
                  disabled={blocked}
                  onChange={(e) => setRights(e.target.checked)}
                  className="mt-1 size-4 shrink-0"
                />
                {t("rights")}
              </label>
              {!saved && (
                <Button
                  className="w-full"
                  disabled={
                    blocked ||
                    !file ||
                    !name.trim() ||
                    !rights ||
                    !actions.writer ||
                    !actions.storageReady
                  }
                  onClick={() => file && void actions.create(file, name, description)}
                >
                  {actions.busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  {t(actions.busy ? actions.step : "mint")}
                </Button>
              )}
            </section>
          </div>
          {saved && (
            <section className="mt-8 space-y-4 border-y py-6" aria-live="polite">
              <h2 className="flex items-center gap-2 text-xl font-medium">
                {saved.tokenId ? (
                  <Check className="size-5 text-emerald-500" />
                ) : (
                  <Loader2 className="size-5 animate-spin" />
                )}
                {t(saved.tokenId ? "created" : "confirm")}
                {saved.tokenId && ` #${saved.tokenId}`}
              </h2>
              <p className="break-words">{saved.name}</p>
              {!saved.tokenId && <p className="text-sm text-muted-foreground">{t("pending")}</p>}
              <div className="flex flex-wrap gap-3">
                {!saved.tokenId && !saved.failed && (
                  <Button
                    variant="outline"
                    onClick={() => void actions.check()}
                    disabled={actions.busy}
                  >
                    <RefreshCw className="size-4" />
                    {t("verify")}
                  </Button>
                )}
                {saved.hash && (
                  <a
                    className="inline-flex items-center gap-2 text-sm underline"
                    href={`https://basescan.org/tx/${saved.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("transaction")}
                    <ExternalLink className="size-4" />
                  </a>
                )}
                {saved.tokenId && (
                  <Link
                    href={`/marketplace?createCollection=${saved.contract}&createTokenId=${saved.tokenId}`}
                    className="inline-flex items-center rounded-md border px-4 py-2 text-sm"
                  >
                    {t("list")}
                  </Link>
                )}
                {(saved.tokenId || saved.failed) && (
                  <Button
                    variant="outline"
                    disabled={actions.busy}
                    onClick={() => void actions.reset()}
                  >
                    {t("another")}
                  </Button>
                )}
              </div>
            </section>
          )}
          {actions.error && (
            <p role="alert" className="mt-5 text-sm text-destructive">
              {t(actions.error)}
            </p>
          )}
        </>
      )}
    </main>
  );
}
