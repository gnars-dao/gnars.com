import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const url = "https://ipfs.io/ipfs/test";
const request = () =>
  new NextRequest(`http://localhost/api/media-type?url=${encodeURIComponent(url)}`);
afterEach(() => vi.unstubAllGlobals());

describe("media resolution caching", () => {
  it("caches successful resolution without buffering upstream bodies", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetcher);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=3600");
    expect(fetcher).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ cache: "no-store", redirect: "manual" }),
    );
  });

  it("does not cache failed metadata reads as a non-image", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { headers: { "Content-Type": "application/json" } }),
        )
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 })),
    );
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects redirects outside the media allowlist before fetching them", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    expect((await GET(request())).status).toBe(502);
    expect(fetcher.mock.calls.every(([target]) => target === url)).toBe(true);
  });
});
