"use client";

import { useEffect, useRef, useState } from "react";
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
import { Link, useRouter } from "@/i18n/navigation";
import { isNftImageFile, isNftMediaFile } from "@/lib/create-nft";

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
  const router = useRouter();
  const handedOff = useRef<string | null>(null);
  useEffect(() => {
    const mint = actions.confirmedMint;
    if (
      !mint?.tokenId ||
      actions.busy ||
      handedOff.current === mint.requestId ||
      actions.journal?.requestId !== mint.requestId ||
      actions.journal.tokenId !== mint.tokenId ||
      actions.writer?.account.address.toLowerCase() !== mint.account.toLowerCase()
    )
      return;
    handedOff.current = mint.requestId;
    router.push(`/marketplace?createCollection=${mint.contract}&createTokenId=${mint.tokenId}`);
  }, [actions.confirmedMint, actions.busy, actions.journal, actions.writer, router]);
  const [file, setFile] = useState<File>();
  const [mediaPreview, setMediaPreview] = useState<{ file: File; url: string }>();
  const [cover, setCover] = useState<File>();
  const [coverObjectUrl, setCoverObjectUrl] = useState<{ file: File; url: string }>();
  const [decodedMedia, setDecodedMedia] = useState<File>();
  const [decodedCover, setDecodedCover] = useState<File>();
  const [coverError, setCoverError] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rights, setRights] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  useEffect(() => {
    if (!file) {
      setMediaPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setMediaPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!cover) {
      setCoverObjectUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(cover);
    setCoverObjectUrl({ file: cover, url });
    return () => URL.revokeObjectURL(url);
  }, [cover]);
  const preview = file && mediaPreview?.file === file ? mediaPreview.url : "";
  const coverPreview = cover && coverObjectUrl?.file === cover ? coverObjectUrl.url : "";
  const mediaReady = !!file && decodedMedia === file;
  const coverReady = !!cover && decodedCover === cover;
  const isVideo = file?.type === "video/mp4";
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
              <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/20">
                {preview && isVideo ? (
                  <video
                    key={preview}
                    src={preview}
                    controls
                    playsInline
                    preload="auto"
                    aria-label={name || t("videoPreview")}
                    className="size-full object-contain"
                    onLoadedData={(event) => {
                      const video = event.currentTarget;
                      if (video.videoWidth > 0 && video.videoHeight > 0) {
                        setDecodedMedia(file);
                      } else {
                        setDecodedMedia(undefined);
                        setMediaError(true);
                      }
                    }}
                    onError={() => {
                      setDecodedMedia(undefined);
                      setMediaError(true);
                    }}
                  />
                ) : preview ? (
                  <Image
                    key={preview}
                    unoptimized
                    width={1024}
                    height={1024}
                    src={preview}
                    alt={name || t("media")}
                    className="size-full object-contain"
                    onLoad={() => setDecodedMedia(file)}
                    onError={() => {
                      setDecodedMedia(undefined);
                      setMediaError(true);
                    }}
                  />
                ) : (
                  <span className="flex flex-col items-center gap-3">
                    <ImagePlus className="size-10 text-muted-foreground" />
                    {t("chooseMedia")}
                  </span>
                )}
              </div>
              <label htmlFor="nft-artwork" className="mt-3 block text-sm">
                {t("chooseMedia")}
              </label>
              <input
                id="nft-artwork"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,video/mp4"
                disabled={blocked}
                className="mt-3 w-full text-sm"
                onChange={(event) => {
                  const value = event.target.files?.[0];
                  if (!value) return;
                  setDecodedMedia(undefined);
                  setCover(undefined);
                  setDecodedCover(undefined);
                  setCoverError(false);
                  if (!isNftMediaFile(value)) {
                    setFile(undefined);
                    setMediaError(true);
                    event.target.value = "";
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
              {isVideo && (
                <div className="mt-6 space-y-3 border-t pt-5">
                  <label htmlFor="nft-cover" className="block text-sm font-medium">
                    {t("cover")}
                  </label>
                  {coverPreview && (
                    <div className="relative aspect-square w-32 overflow-hidden rounded-md border bg-muted/20">
                      <Image
                        key={coverPreview}
                        unoptimized
                        fill
                        src={coverPreview}
                        alt={t("coverPreview")}
                        className="object-contain"
                        onLoad={() => setDecodedCover(cover)}
                        onError={() => {
                          setDecodedCover(undefined);
                          setCoverError(true);
                        }}
                      />
                    </div>
                  )}
                  <input
                    id="nft-cover"
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    disabled={blocked}
                    className="w-full text-sm"
                    onChange={(event) => {
                      const value = event.target.files?.[0];
                      if (!value) return;
                      setDecodedCover(undefined);
                      if (!isNftImageFile(value)) {
                        setCover(undefined);
                        setCoverError(true);
                        event.target.value = "";
                        return;
                      }
                      setCoverError(false);
                      setCover(value);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">{t("coverTypes")}</p>
                  {coverError && (
                    <p role="alert" className="text-sm text-destructive">
                      {t("invalidCover")}
                    </p>
                  )}
                </div>
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
                    !mediaReady ||
                    mediaError ||
                    (isVideo && (!cover || !coverReady || coverError)) ||
                    !name.trim() ||
                    !rights ||
                    !actions.writer ||
                    !actions.storageReady
                  }
                  onClick={() =>
                    file &&
                    void actions.create(file, name, description, isVideo ? cover : undefined)
                  }
                >
                  {actions.busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  {t(actions.busy ? actions.step : "mint")}
                </Button>
              )}
              {actions.busy && actions.step === "upload" && actions.uploadProgress !== null && (
                <div className="space-y-2" role="status">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span>{t("upload")}</span>
                    <span className="font-mono">{actions.uploadProgress}%</span>
                  </div>
                  <progress
                    className="h-2 w-full accent-foreground"
                    aria-label={t("upload")}
                    value={actions.uploadProgress}
                    max={100}
                  />
                </div>
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
