"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import { arbitrum as thirdwebArbitrum, base as thirdwebBase } from "thirdweb/chains";
import { useActiveWallet, useActiveWalletChain } from "thirdweb/react";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/ui/ConnectButton";
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
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { usePinataUpload } from "@/hooks/use-pinata-upload";
import { sopaCalls, usePoidhSopaWrite } from "@/hooks/use-poidh-sopa-write";
import { useUserAddress } from "@/hooks/use-user-address";
import { usePoidhCreateClaim } from "@/hooks/usePoidhContract";
import type { PinataUploadResponse } from "@/lib/pinata";
import { uploadMimeType } from "@/lib/pinata-policy";
import { CHAIN_NAMES, getTxUrl, SUPPORTED_CHAINS } from "@/lib/poidh/config";
import type { PoidhBounty } from "@/types/poidh";

interface ClaimBountyModalProps {
  bounty: Pick<PoidhBounty, "chainId" | "onChainId">;
  children: React.ReactNode;
  onSuccess?: (claim: { name: string; description: string; url: string }) => void;
  /** Which contract receives the claim. Sopa ids are Sopa bounty ids. Default V3. */
  source?: "v3" | "sopa";
}

/** Keeps a phone screen on during long uploads; mobile browsers drop transfers when it sleeps. */
async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    return (await navigator.wakeLock?.request("screen")) ?? null;
  } catch {
    return null; // unsupported, denied, or tab hidden
  }
}

export function ClaimBountyModal({
  bounty,
  children,
  onSuccess,
  source = "v3",
}: ClaimBountyModalProps) {
  const uploadToPinata = usePinataUpload();
  const t = useTranslations("bounties");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFileSize, setUploadFileSize] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const { isConnected } = useUserAddress();
  const activeChain = useActiveWalletChain();
  const activeWallet = useActiveWallet();
  const walletChainId = activeChain?.id ?? SUPPORTED_CHAINS.BASE;
  const [isSwitching, setIsSwitching] = useState(false);
  const switchWalletChain = async (targetChainId: number) => {
    if (!activeWallet || isSwitching) return;
    const targetChain =
      targetChainId === SUPPORTED_CHAINS.ARBITRUM ? thirdwebArbitrum : thirdwebBase;
    setIsSwitching(true);
    try {
      await activeWallet.switchChain(targetChain);
    } catch {
      // user cancelled or failed silently
    } finally {
      setIsSwitching(false);
    }
  };
  const v3Claim = usePoidhCreateClaim(bounty.chainId);
  const sopaWrite = usePoidhSopaWrite();
  const isSopa = source === "sopa";
  const submit = isSopa
    ? async (id: number, name: string, description: string, uri: string) => {
        await sopaWrite.run({ build: sopaCalls.createClaim(id, name, description, uri) });
      }
    : v3Claim.submit;
  const hash = isSopa ? sopaWrite.hash : v3Claim.hash;
  const isPending = isSopa ? sopaWrite.isPending : v3Claim.isPending;
  const isSuccess = isSopa ? sopaWrite.isSuccess : v3Claim.isSuccess;
  const error = isSopa
    ? sopaWrite.error
      ? new Error(
          sopaWrite.error.key ? t(`sopa.errors.${sopaWrite.error.key}`) : sopaWrite.error.message,
        )
      : null
    : v3Claim.error;
  const reset = isSopa ? sopaWrite.reset : v3Claim.reset;
  const chainName = CHAIN_NAMES[bounty.chainId as keyof typeof CHAIN_NAMES] ?? "Unknown";
  const wrongNetwork = isConnected && walletChainId !== bounty.chainId;
  const currentWalletChainName =
    CHAIN_NAMES[walletChainId as keyof typeof CHAIN_NAMES] ?? `Chain ${walletChainId}`;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);

    const isVideo = uploadMimeType(file).startsWith("video/");
    const maxSize = isVideo ? 500 * 1024 * 1024 : 100 * 1024 * 1024;
    if (file.size > maxSize) {
      setUploadError(t("claimModal.fileTooLarge"));
      e.target.value = "";
      return;
    }

    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setIsUploading(true);
    setUploadProgress(0);
    setUploadFileSize(file.size);
    const wakeLock = await requestWakeLock();
    const result = await uploadToPinata(file, file.name, setUploadProgress, controller.signal);
    wakeLock?.release().catch(() => {});
    if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
    if (result.success && result.data) {
      setMediaUrl(result.data.gatewayUrl);
      setUploadedFileName(file.name);
    } else if (!result.cancelled) {
      console.error("Claim media upload failed:", {
        stage: result.stage,
        status: result.status,
        error: result.error,
        file: { name: file.name, type: file.type, size: file.size },
      });
      setUploadError(uploadErrorMessage(result));
    }
    setIsUploading(false);
    e.target.value = "";
  };

  const cancelUpload = () => uploadAbortRef.current?.abort();

  const uploadErrorMessage = ({ stage, status }: PinataUploadResponse) => {
    if (stage === "connect") return t("claimModal.uploadErrorConnect");
    if (stage === "wallet") return t("claimModal.uploadErrorWallet");
    if (stage === "file") return t("claimModal.uploadErrorFile");
    if (status === 429) return t("claimModal.uploadErrorRateLimit");
    if (stage === "authorize" && status) return t("claimModal.uploadErrorAuthorize", { status });
    if (stage === "upload" && status === 0) return t("claimModal.uploadErrorNetwork");
    if (stage === "upload" && status) return t("claimModal.uploadErrorUpload", { status });
    return t("claimModal.uploadError");
  };

  const clearUpload = () => {
    setMediaUrl("");
    setUploadedFileName(null);
    setUploadError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !description.trim()) return;
    try {
      await submit(bounty.onChainId, name.trim(), description.trim(), mediaUrl.trim());
      onSuccess?.({ name: name.trim(), description: description.trim(), url: mediaUrl.trim() });
    } catch {
      // error captured in hook
    }
  };

  // Leaving mid-upload loses the file; ask the browser to confirm first.
  useEffect(() => {
    if (!isUploading) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // Safari ignores preventDefault alone
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isUploading]);

  // Client-side navigation unmounts the modal; stop the transfer with it.
  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  const MB = 1024 * 1024;
  // One decimal below 10 MB so small files don't read "0 of 3 MB".
  const toMb = (bytes: number) =>
    bytes < 10 * MB ? Math.round((bytes / MB) * 10) / 10 : Math.round(bytes / MB);
  const uploadPhase =
    uploadProgress >= 100 ? "finalizing" : uploadProgress > 0 ? "uploading" : "preparing";
  const uploadLabel =
    uploadPhase === "preparing"
      ? t("claimModal.preparingUpload")
      : uploadPhase === "finalizing"
        ? t("claimModal.finalizingUpload")
        : uploadFileSize >= MB
          ? t("claimModal.uploading", {
              progress: uploadProgress,
              sent: toMb((uploadFileSize * uploadProgress) / 100),
              total: toMb(uploadFileSize),
            })
          : t("claimModal.uploadingPercent", { progress: uploadProgress });

  const handleClose = (val: boolean) => {
    // A stray tap outside the dialog on mobile would drop an in-flight upload.
    if (!val && isUploading) return;
    if (!val) {
      setName("");
      setDescription("");
      setMediaUrl("");
      setUploadedFileName(null);
      setUploadError(null);
      setIsUploading(false);
      setUploadProgress(0);
      reset();
    }
    setOpen(val);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto"
        showCloseButton={!isUploading}
      >
        <DialogHeader>
          <DialogTitle>{t("claimModal.title")}</DialogTitle>
          <DialogDescription>{t("claimModal.description", { chain: chainName })}</DialogDescription>
        </DialogHeader>

        {!isConnected ? (
          <div className="py-6 flex flex-col items-center gap-4 text-center">
            <AlertCircle className="w-10 h-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("claimModal.connectPrompt")}</p>
            <ConnectButton />
          </div>
        ) : isSuccess ? (
          <div className="py-6 flex flex-col items-center gap-4 text-center">
            <CheckCircle2 className="w-12 h-12 text-emerald-500" />
            <div>
              <p className="font-semibold">{t("claimModal.successTitle")}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {t("claimModal.successDescription")}
              </p>
            </div>
            {hash && (
              <a
                href={getTxUrl(bounty.chainId, hash)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-primary hover:underline"
              >
                {t("claimModal.viewTransaction")} <ExternalLink className="w-3 h-3" />
              </a>
            )}
            <Button variant="outline" onClick={() => handleClose(false)}>
              {t("cta.close")}
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            {wrongNetwork && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3">
                <div className="flex items-start gap-2 text-sm text-yellow-600 dark:text-yellow-400">
                  <ArrowLeftRight className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {t("claimModal.wrongNetwork", {
                      currentChain: currentWalletChainName,
                      targetChain: chainName,
                    })}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0 border-yellow-500/40 text-yellow-600 dark:text-yellow-400 hover:bg-yellow-500/10"
                  disabled={isSwitching}
                  onClick={() => switchWalletChain(bounty.chainId)}
                >
                  {isSwitching ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    t("claimModal.switchTo", { chain: chainName })
                  )}
                </Button>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>{t("claimModal.claimTitleLabel")}</Label>
              <Input
                placeholder={t("claimModal.claimTitlePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                disabled={isPending}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t("claimModal.proofLabel")}</Label>
              <Textarea
                className="min-h-[100px] resize-y"
                placeholder={t("claimModal.proofPlaceholder")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                disabled={isPending}
                required
              />
              <p className="text-xs text-muted-foreground text-right">{description.length}/500</p>
            </div>

            <div className="space-y-2">
              <Label>{t("claimModal.mediaLabel")}</Label>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={handleFileChange}
                disabled={isPending || isUploading}
              />

              {uploadedFileName ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="truncate">{uploadedFileName}</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 shrink-0"
                    onClick={clearUpload}
                    disabled={isPending}
                  >
                    <X className="w-4 h-4" />
                    <span className="sr-only">{t("claimModal.removeFile")}</span>
                  </Button>
                </div>
              ) : isUploading ? (
                <div className="space-y-3 rounded-md border border-border px-3 py-3">
                  <div className="flex items-start gap-2 text-sm">
                    <Loader2 className="w-4 h-4 mt-0.5 shrink-0 animate-spin" aria-hidden />
                    <span aria-hidden>{uploadLabel}</span>
                    {/* Announce phase changes only, not every percent. */}
                    <span className="sr-only" aria-live="polite">
                      {uploadPhase === "uploading" ? t("claimModal.uploadingPhase") : uploadLabel}
                    </span>
                  </div>
                  <Progress
                    value={uploadProgress}
                    aria-label={t("claimModal.uploadProgressLabel")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={uploadProgress}
                    aria-valuetext={`${uploadProgress}%`}
                  />
                  <p className="text-xs text-muted-foreground">{t("claimModal.uploadKeepOpen")}</p>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full h-11 sm:h-9 cursor-pointer"
                    onClick={cancelUpload}
                  >
                    <X className="w-4 h-4 mr-2" />
                    {t("claimModal.cancelUpload")}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isPending}
                >
                  <Upload className="w-4 h-4 mr-2" />
                  {t("claimModal.uploadButton")}
                </Button>
              )}

              {!uploadedFileName && !isUploading && (
                <>
                  <p className="text-xs text-muted-foreground text-center">
                    {t("claimModal.mediaUrlOr")}
                  </p>
                  <Input
                    placeholder={t("claimModal.mediaUrlPlaceholder")}
                    value={mediaUrl}
                    onChange={(e) => setMediaUrl(e.target.value)}
                    disabled={isPending || isUploading}
                    type="url"
                  />
                </>
              )}

              {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error.message.split("\n")[0]}</span>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => handleClose(false)}
                disabled={isPending || isUploading}
              >
                {t("cta.cancel")}
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={
                  isPending || isUploading || wrongNetwork || !name.trim() || !description.trim()
                }
              >
                {isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {hash ? t("claimModal.confirming") : t("claimModal.confirmingWallet")}
                  </>
                ) : (
                  t("detail.submitYourProof")
                )}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
