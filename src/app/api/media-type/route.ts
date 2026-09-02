import { NextRequest, NextResponse } from "next/server";
import { isAllowedMediaHost } from "@/lib/poidh/media-hosts";

/** Cap on the metadata JSON we're willing to parse — real poidh tokenURIs are <1 KB. */
const MAX_METADATA_BYTES = 64 * 1024;

interface Headers {
  contentType: string;
  contentDisposition: string;
}

async function headOf(url: string): Promise<Headers | null> {
  const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  return {
    contentType: res.headers.get("content-type") || "",
    contentDisposition: res.headers.get("content-disposition") || "",
  };
}

/** poidh stores the claim's tokenURI (ERC-721 metadata JSON) in claim.url, not the media
 *  itself. Read the JSON and hand back the `image` / `animation_url` it points at. */
async function resolveMetadataMedia(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const length = Number(res.headers.get("content-length") || 0);
    if (length > MAX_METADATA_BYTES) return null;
    const body = await res.text();
    if (body.length > MAX_METADATA_BYTES) return null;
    const meta = JSON.parse(body) as { image?: unknown; animation_url?: unknown };
    const media = [meta.animation_url, meta.image].find((v) => typeof v === "string" && v);
    if (typeof media !== "string") return null;
    return isAllowedMediaHost(media) ? media : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  if (!isAllowedMediaHost(url)) {
    return NextResponse.json({ error: "URL hostname not allowed" }, { status: 400 });
  }

  try {
    let target = url;
    let headers = await headOf(target);
    if (!headers) {
      return NextResponse.json({ error: "Failed to fetch headers" }, { status: 502 });
    }

    // One level of metadata resolution — never follow a JSON that points at another JSON.
    if (headers.contentType.startsWith("application/json")) {
      const media = await resolveMetadataMedia(target);
      if (media) {
        const mediaHeaders = await headOf(media);
        if (mediaHeaders) {
          target = media;
          headers = mediaHeaders;
        }
      }
    }

    const { contentType, contentDisposition } = headers;
    return NextResponse.json({
      contentType,
      isVideo: contentType.startsWith("video/"),
      isImage: contentType.startsWith("image/"),
      isAttachment: contentDisposition.toLowerCase().includes("attachment"),
      ...(target !== url ? { resolvedUrl: target } : {}),
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch headers" }, { status: 500 });
  }
}
