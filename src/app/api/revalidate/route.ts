import { revalidateTag, unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { createPublicClient, http, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { z } from "zod";
import { allowedReceiptTags, filterReceiptTags } from "@/lib/revalidation-policy";
import { serverPublicClient } from "@/lib/rpc";
import {
  enforceRateLimit,
  readJsonBody,
  RequestSecurityError,
  requestSecurityResponse,
} from "@/lib/server/request-security";

export const dynamic = "force-dynamic";

const schema = z.object({
  tags: z.array(z.string().max(64)).min(1).max(5),
  transactionHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((hash) => hash.toLowerCase() as Hex),
  chainId: z.union([z.literal(8453), z.literal(1)]).default(8453),
});
const ethereum = createPublicClient({
  chain: mainnet,
  transport: http("https://ethereum-rpc.publicnode.com", { timeout: 8000, retryCount: 0 }),
});

const receiptEvidence = unstable_cache(
  async (chainId: number, hash: Hex) => {
    const client = chainId === 8453 ? serverPublicClient : ethereum;
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new RequestSecurityError(400, "Transaction reverted");
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return {
      timestamp: Number(block.timestamp),
      addresses: receipt.logs.map((log) => log.address),
    };
  },
  ["revalidation-receipt-v1"],
  { revalidate: 600 },
);

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "revalidate", limit: 20, windowSeconds: 60 });
    const parsed = schema.safeParse(await readJsonBody(request, 2048));
    if (!parsed.success) throw new RequestSecurityError(400, "A confirmed transaction is required");
    const { tags, chainId, transactionHash } = parsed.data;
    const evidence = await receiptEvidence(chainId, transactionHash);
    const age = Date.now() / 1000 - evidence.timestamp;
    if (age < -30 || age > 600)
      throw new RequestSecurityError(400, "Transaction is outside the refresh window");
    const accepted = filterReceiptTags(tags, allowedReceiptTags(chainId, evidence.addresses));
    if (!accepted.length)
      throw new RequestSecurityError(403, "Transaction does not affect these datasets");
    await enforceRateLimit(request, {
      scope: "revalidate-tx",
      subject: chainId + ":" + transactionHash,
      limit: 2,
      windowSeconds: 600,
    });
    for (const tag of accepted) revalidateTag(tag, "max");
    return NextResponse.json(
      { revalidated: accepted },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RequestSecurityError) return requestSecurityResponse(error);
    return NextResponse.json(
      { error: "Unable to verify transaction" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
