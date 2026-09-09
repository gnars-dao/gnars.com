import { NextRequest, NextResponse } from "next/server";
import { isAllowedMediaHost } from "@/lib/poidh/media-hosts";
import { readLimitedResponse } from "@/lib/read-limited-response";

/** Cap on the metadata JSON we're willing to parse — real poidh tokenURIs are <1 KB. */
const MAX_METADATA_BYTES = 64 * 1024;

interface Headers {
  contentType: string;
  contentDisposition: string;
}

async function fetchMedia(url: string, method: "GET" | "HEAD"): Promise<Response> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isAllowedMediaHost(url)) throw new Error("Media redirect is not allowed");
    const response = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      // Only the final successful route response is cached. Fetch caching also
      // buffers GET bodies before our byte limit and can retain failed HEADs.
      cache: "no-store",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Missing redirect location");
    url = new URL(location, url).href;
  }
  throw new Error("Too many media redirects");
}

/** IPFS gateways drop requests often enough that a single timeout would demote a real
 *  image to a link for the rest of the visitor's session — so give it one more try. */
async function headOf(url: string, attempts = 2): Promise<Headers | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchMedia(url, "HEAD");
      if (!res.ok) return null;
      return {
        contentType: res.headers.get("content-type") || "",
        contentDisposition: res.headers.get("content-disposition") || "",
      };
    } catch {
      if (i === attempts - 1) throw new Error("HEAD failed");
    }
  }
  return null;
}

/** poidh stores the claim's tokenURI (ERC-721 metadata JSON) in claim.url, not the media
 *  itself. Read the JSON and hand back the `image` / `animation_url` it points at. */
async function resolveMetadataMedia(url: string): Promise<string | null> {
  const res = await fetchMedia(url, "GET");
  if (!res.ok) throw new Error("Metadata fetch failed");
  const body = await readLimitedResponse(res, MAX_METADATA_BYTES);
  const meta = JSON.parse(body) as { image?: unknown; animation_url?: unknown };
  const media = [meta.animation_url, meta.image].find((v) => typeof v === "string" && v);
  if (typeof media !== "string") return null;
  return isAllowedMediaHost(media) ? media : null;
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
      throw new Error("Failed to fetch headers");
    }

    // One level of metadata resolution — never follow a JSON that points at another JSON.
    if (headers.contentType.startsWith("application/json")) {
      const media = await resolveMetadataMedia(target);
      if (media) {
        const mediaHeaders = await headOf(media);
        if (!mediaHeaders) throw new Error("Failed to fetch media headers");
        target = media;
        headers = mediaHeaders;
      }
    }

    const { contentType, contentDisposition } = headers;
    return NextResponse.json(
      {
        contentType,
        isVideo: contentType.startsWith("video/"),
        isImage: contentType.startsWith("image/"),
        isAttachment: contentDisposition.toLowerCase().includes("attachment"),
        ...(target !== url ? { resolvedUrl: target } : {}),
      },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to resolve media" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
