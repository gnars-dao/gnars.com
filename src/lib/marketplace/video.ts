import { IPFS_GATEWAYS } from "@/lib/ipfs";

export function nftVideoUrl(value: unknown, mimeType?: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192 || /[\\\x00-\x20]/.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.split("/").some((part) => part === ".." || part === ".")) return null;
    const url = new URL(value.startsWith("ipfs://") ? IPFS_GATEWAYS[0] + value.slice(7) : value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      !hostname.includes(".") ||
      /^[\d.]+$/.test(hostname) ||
      hostname.includes(":")
    )
      return null;
    const path = decodeURIComponent(url.pathname);
    if (/[\\\x00-\x1f]/.test(path) || path.split("/").some((part) => part === ".." || part === "."))
      return null;
    if (mimeType != null && mimeType !== "video/mp4") return null;
    if (mimeType !== "video/mp4" && !/\.mp4$/i.test(path)) return null;
    const ipfs = path.indexOf("/ipfs/");
    if (ipfs !== -1) {
      const content = path.slice(ipfs + 6);
      if (
        !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,100})(\/|$)/.test(content) ||
        url.search ||
        url.hash
      )
        return null;
      return IPFS_GATEWAYS[0] + url.pathname.slice(url.pathname.indexOf("/ipfs/") + 6);
    }
    return url.href;
  } catch {
    return null;
  }
}
