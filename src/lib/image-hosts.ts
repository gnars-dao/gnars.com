/** Optimization is reserved for our media gateways; other NFT images load directly. */
export const OPTIMIZED_IMAGE_HOSTS = [
  "www.gnars.com",
  "gnars.com",
  "gnars.wtf",
  "www.gnars.wtf",
  "ipfs.skatehive.app",
  "ipfs.io",
  "cloudflare-ipfs.com",
  "gateway.pinata.cloud",
  "dweb.link",
  "nftstorage.link",
  "magic.decentralized-content.com",
  "imagedelivery.net",
  "res.cloudinary.com",
  "pbs.twimg.com",
  "i.imgur.com",
  "images.unsplash.com",
  "raw.githubusercontent.com",
  "storage.googleapis.com",
  "zora.co",
  "images.zora.co",
  "assets.zora.co",
  "zorb.dev",
  "wsrv.nl",
  "keepkey.com",
  "www.keepkey.com",
  "www.deathdigital.com",
] as const;
export const OPTIMIZED_IMAGE_SUFFIXES = [".mypinata.cloud", ".choicecdn.com"] as const;

export function canOptimizeImage(src: string): boolean {
  if (src.startsWith("/") && !src.startsWith("//")) return true;
  try {
    const url = new URL(src);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      (OPTIMIZED_IMAGE_HOSTS.some((host) => url.hostname === host) ||
        OPTIMIZED_IMAGE_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix)))
    );
  } catch {
    return false;
  }
}
