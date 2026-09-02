/** Hosts we trust to serve claim media inline.
 *  Shared by /api/media-type (server) and MediaEmbed (client) so both agree on
 *  what is worth inspecting — anything else renders as a plain external link. */
const ALLOWED_MEDIA_HOSTNAMES = new Set([
  "ipfs.skatehive.app",
  "ipfs.io",
  "cloudflare-ipfs.com",
  "gateway.pinata.cloud",
  "dweb.link",
  "nftstorage.link",
  // poidh's bounty-agent host: serves both the claim metadata JSON and its images.
  "agentatwork.xyz",
  "www.agentatwork.xyz",
]);

const ALLOWED_MEDIA_HOST_SUFFIXES = [".mypinata.cloud"];

export function isAllowedMediaHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  if (ALLOWED_MEDIA_HOSTNAMES.has(hostname)) return true;
  return ALLOWED_MEDIA_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}
