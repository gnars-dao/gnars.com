"use client";

import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { isAllowedMediaHost } from "@/lib/poidh/media-hosts";

interface MediaInfo {
  contentType: string;
  isVideo: boolean;
  isImage: boolean;
  isAttachment: boolean;
  /** Set when `url` was a metadata JSON — the media it points at. */
  resolvedUrl?: string;
  error?: string;
}

interface MediaEmbedProps {
  url: string;
  alt?: string;
  className?: string;
}

export function MediaEmbed({ url, alt = "", className = "" }: MediaEmbedProps) {
  const t = useTranslations("bounties");
  // Untrusted host — the API would reject it anyway, so skip the round trip.
  const canInspect = isAllowedMediaHost(url);
  const { data, isLoading } = useQuery<MediaInfo>({
    queryKey: ["media-type", url],
    enabled: canInspect,
    queryFn: async () => {
      const res = await fetch(`/api/media-type?url=${encodeURIComponent(url)}`);
      const info: MediaInfo = await res.json();
      // A flaky gateway must not cache "not media" for an hour — throw so it retries.
      if (info.error) throw new Error(info.error);
      return info;
    },
    staleTime: 60 * 60 * 1000, // 1 hour — content type doesn't change
  });

  if (canInspect && isLoading) {
    return <Skeleton className={`h-20 w-full ${className}`} />;
  }

  // Attachment or unknown — safe link, never auto-download
  if (!data || data.isAttachment || data.error || (!data.isVideo && !data.isImage)) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border text-sm text-primary hover:bg-muted transition-colors"
      >
        <ExternalLink className="w-4 h-4" />
        {t("detail.viewMedia")}
      </a>
    );
  }

  const src = data.resolvedUrl ?? url;

  if (data.isVideo) {
    return (
      <video
        src={src}
        className={`rounded-md max-w-full h-auto max-h-64 ${className}`}
        controls
        playsInline
      >
        <track kind="captions" />
      </video>
    );
  }

  // Image
  return (
    <Dialog>
      <DialogTrigger asChild>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className={`rounded-md max-w-full h-auto max-h-64 object-cover cursor-pointer hover:opacity-90 transition-opacity ${className}`}
          loading="lazy"
        />
      </DialogTrigger>
      <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 border-0 bg-transparent">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="w-full h-auto max-h-[95vh] object-contain" />
      </DialogContent>
    </Dialog>
  );
}
