import { unstable_cache } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getCoin, setApiKey } from "@zoralabs/coins-sdk";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { ipfsToHttp } from "@/lib/ipfs";
import {
  enforceRateLimit,
  RequestSecurityError,
  requestSecurityResponse,
} from "@/lib/server/request-security";

const ALCHEMY_RPC_BASES: Record<string, string> = {
  "8453": "https://base-mainnet.g.alchemy.com/v2",
  "1": "https://eth-mainnet.g.alchemy.com/v2",
  "10": "https://opt-mainnet.g.alchemy.com/v2",
  "42161": "https://arb-mainnet.g.alchemy.com/v2",
};

const TRUSTWALLET_CHAIN_NAMES: Record<string, string> = {
  "8453": "base",
  "1": "ethereum",
  "10": "optimism",
  "42161": "arbitrum",
};

export interface LookedUpToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
}

const getMetadata = unstable_cache(
  async (chainId: string, address: string) => {
    const key = process.env.ALCHEMY_API_KEY;
    if (!key) throw new RequestSecurityError(503, "Token service is not configured.");
    const response = await fetch(`${ALCHEMY_RPC_BASES[chainId]}/${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "alchemy_getTokenMetadata",
        params: [address],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new RequestSecurityError(502, "Metadata request failed.");
    const parsed = z
      .object({
        error: z.undefined().optional(),
        result: z.object({
          name: z.string().nullable(),
          symbol: z.string().nullable(),
          decimals: z.number().int().min(0).max(255).nullable(),
          logo: z.string().nullable().optional(),
        }),
      })
      .safeParse(await response.json());
    if (!parsed.success) throw new RequestSecurityError(502, "Invalid metadata response.");
    return parsed.data.result;
  },
  ["token-lookup-metadata-v1"],
  { revalidate: 3600 },
);

const getZoraToken = unstable_cache(
  async (address: string) => {
    const key = process.env.NEXT_PUBLIC_ZORA_API_KEY;
    if (key) setApiKey(key);
    const response = await getCoin({ address: address as `0x${string}`, chain: 8453 }, {
      signal: AbortSignal.timeout(8000),
    } as NonNullable<Parameters<typeof getCoin>[1]>);
    if (response.response?.status === 404) return null;
    if (
      ("error" in response && response.error) ||
      (response.response && !response.response.ok) ||
      !response.data ||
      !("zora20Token" in response.data)
    )
      throw new Error("Zora metadata unavailable");
    return response.data.zora20Token ?? null;
  },
  ["token-lookup-zora-v1"],
  { revalidate: 3600 },
);

async function lookup(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");
  const chainId = searchParams.get("chainId") ?? "8453";

  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (!alchemyKey) {
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  const rpcBase = ALCHEMY_RPC_BASES[chainId];
  if (!rpcBase) {
    return NextResponse.json({ error: "Unsupported chain" }, { status: 400 });
  }

  await enforceRateLimit(req, { scope: "token-lookup", limit: 60, windowSeconds: 60 });
  const checksumAddr = getAddress(address);
  const canonical = address.toLowerCase();

  // Fetch Alchemy metadata and Zora coin data in parallel.
  // Zora is only attempted on Base where creator coins live.
  let enrichmentAvailable = true;
  const [meta, zoraToken] = await Promise.all([
    getMetadata(chainId, canonical),
    chainId === "8453"
      ? getZoraToken(canonical).catch(() => {
          enrichmentAvailable = false;
          return null;
        })
      : Promise.resolve(null),
  ]);

  if (!meta.symbol || !meta.name || meta.decimals == null) {
    return NextResponse.json({ error: "Not a valid ERC-20 token" }, { status: 404 });
  }

  // Logo priority: Zora media → Alchemy logo → TrustWallet CDN.
  let logoUrl: string | null = null;

  if (zoraToken?.mediaContent?.previewImage) {
    const preview = zoraToken.mediaContent.previewImage;
    const raw =
      typeof preview === "object"
        ? ((preview as Record<string, string>)?.medium ??
          (preview as Record<string, string>)?.small)
        : (preview as string | undefined);
    if (raw) {
      logoUrl = ipfsToHttp(raw);
    }
  }

  if (!logoUrl) logoUrl = meta.logo ?? null;

  if (!logoUrl) {
    const twChain = TRUSTWALLET_CHAIN_NAMES[chainId];
    if (twChain) {
      logoUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${twChain}/assets/${checksumAddr}/logo.png`;
    }
  }

  return NextResponse.json(
    {
      address: checksumAddr,
      symbol: meta.symbol,
      name: meta.name,
      decimals: meta.decimals,
      logoUrl,
    } satisfies LookedUpToken,
    {
      headers: {
        "Cache-Control": enrichmentAvailable
          ? "public, s-maxage=3600, stale-while-revalidate=3600"
          : "no-store",
      },
    },
  );
}

export async function GET(req: NextRequest) {
  try {
    return await lookup(req);
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
