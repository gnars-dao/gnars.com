import { NextResponse, type NextRequest } from "next/server";
import { isAddress, type Address } from "viem";
import { onchainToCoin, type ZoraCoinLike } from "@/app/[locale]/swap/coinCardModel";
import { ipfsToHttp } from "@/lib/ipfs";
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
 * Answers `{ coin: null }` with 200 for an address that is not a coin, so
 * the widget can ask about any token and simply draw nothing.
 */
export const runtime = "nodejs";

const ZORA_SDK = "https://api-sdk.zora.engineering/coin";
const TTL = "public, s-maxage=600, stale-while-revalidate=3600";

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
    next: { revalidate: 600 },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { zora20Token?: ZoraCoinLike | null };
  return body.zora20Token ?? null;
}

async function fromChain(address: Address): Promise<ZoraCoinLike | null> {
  const uri = await serverPublicClient.readContract({
    address,
    abi: contractUriAbi,
    functionName: "contractURI",
  });
  if (!uri) return null;
  const res = await fetch(ipfsToHttp(uri), {
    signal: AbortSignal.timeout(8_000),
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;
  return onchainToCoin(await res.json(), address);
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
      // Not a coin, or the chain would not answer: the card draws nothing.
    }
  }
  return NextResponse.json({ coin, source }, { headers: { "cache-control": TTL } });
}
