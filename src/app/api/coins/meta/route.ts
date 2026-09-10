import { NextResponse, type NextRequest } from "next/server";
import { isAddress, type Address } from "viem";
import { z } from "zod";
import { onchainToCoin, type ZoraCoinLike } from "@/app/[locale]/swap/coinCardModel";
import { IPFS_GATEWAYS, ipfsToHttp } from "@/lib/ipfs";
import { readLimitedResponse } from "@/lib/read-limited-response";
import { serverPublicClient } from "@/lib/rpc";

/**
 * GET /api/coins/meta?address=0x… — a Zora coin's metadata for the swap card.
 *
 * Why a route and not the SDK in the browser: Zora's SDK endpoint answers a
 * keyless browser call with a Cloudflare block, so coins showed a letter
 * where their image should be. Server-side the call goes through, with the
 * site's key when one is configured. When Zora still will not answer, the
 * coin's own `contractURI()` on Base points at the same media, so the card
 * can draw from the chain — without market figures, which only Zora has.
 *
 * Onchain metadata supplies artwork, not evidence that a token is from Zora.
 * Missing enrichment leaves the caller's ordinary token card intact.
 */
export const runtime = "nodejs";

const ZORA_SDK = "https://api-sdk.zora.engineering/coin";
const TTL = "public, s-maxage=600, stale-while-revalidate=3600";
const MAX_METADATA_BYTES = 64 * 1024;
const optionalText = z.string().nullish();
const coinSchema = z.object({
  address: optionalText,
  name: optionalText,
  symbol: optionalText,
  description: optionalText,
  marketCap: optionalText,
  marketCapDelta24h: optionalText,
  volume24h: optionalText,
  uniqueHolders: z.number().finite().nonnegative().nullish(),
  createdAt: optionalText,
  mediaContent: z
    .object({
      mimeType: optionalText,
      originalUri: optionalText,
      previewImage: z
        .object({ small: optionalText, medium: optionalText, blurhash: optionalText })
        .nullish(),
    })
    .nullish(),
  creatorProfile: z
    .object({
      handle: optionalText,
      avatar: z.object({ previewImage: z.object({ small: optionalText }).nullish() }).nullish(),
    })
    .nullish(),
});
const zoraCoinSchema = coinSchema.extend({ address: z.string(), chainId: z.literal(8453) });

const contractUriAbi = [
  {
    name: "contractURI",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

async function fromZora(address: string): Promise<ZoraCoinLike | null> {
  const key = process.env.ZORA_API_KEY ?? process.env.NEXT_PUBLIC_ZORA_API_KEY;
  const res = await fetch(`${ZORA_SDK}?address=${address}&chain=8453`, {
    headers: {
      accept: "application/json",
      // Zora's edge refuses the default server fetch agent; a browser-shaped
      // agent and the site as origin are what it accepts for keyless calls.
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      origin: "https://www.gnars.com",
      ...(key ? { "api-key": key } : {}),
    },
    signal: AbortSignal.timeout(8_000),
    redirect: "error",
    next: { revalidate: 600 },
  });
  if (!res.ok) return null;
  const body: unknown = JSON.parse(await readLimitedResponse(res, MAX_METADATA_BYTES));
  const result = z.object({ zora20Token: zoraCoinSchema.nullish() }).safeParse(body);
  const coin = result.success ? result.data.zora20Token : null;
  if (!coin || coin.address.toLowerCase() !== address.toLowerCase()) return null;
  return coinSchema.parse(coin);
}

function safeContractMetadataUrl(uri: string): string | null {
  try {
    const url = new URL(ipfsToHttp(uri));
    const gateway = new URL(IPFS_GATEWAYS[0]);
    if (
      url.origin !== gateway.origin ||
      !url.pathname.startsWith(gateway.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const path = decodeURIComponent(url.pathname.slice(gateway.pathname.length));
    if (!path || path.split("/").some((part) => part === "." || part === "..")) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function fromChain(address: Address): Promise<ZoraCoinLike | null> {
  const uri = await serverPublicClient.readContract({
    address,
    abi: contractUriAbi,
    functionName: "contractURI",
  });
  if (!uri) return null;
  const url = safeContractMetadataUrl(uri);
  if (!url) return null;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    redirect: "error",
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;
  const metadata: unknown = JSON.parse(await readLimitedResponse(res, MAX_METADATA_BYTES));
  const result = coinSchema.safeParse(onchainToCoin(metadata, address));
  return result.success ? result.data : null;
}

export async function GET(request: NextRequest) {
  const address = (request.nextUrl.searchParams.get("address") ?? "").trim();
  if (!isAddress(address)) {
    return NextResponse.json(
      { error: "address must be an EVM address", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }
  let coin: ZoraCoinLike | null = null;
  let source: "zora" | "onchain" | null = null;
  try {
    coin = await fromZora(address);
    if (coin) source = "zora";
  } catch {
    // Fall through to the chain.
  }
  if (!coin) {
    try {
      coin = await fromChain(address as Address);
      if (coin) source = "onchain";
    } catch {
      // Missing or untrusted enrichment leaves the ordinary token card intact.
    }
  }
  return NextResponse.json(
    { coin, source },
    { headers: { "cache-control": coin ? TTL : "no-store" } },
  );
}
