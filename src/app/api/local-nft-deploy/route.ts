import { concatHex, isAddressEqual, type Address, type Hex } from "viem";
import { z } from "zod";
import { BUILDER_CODE_SUFFIX } from "@/lib/config";
import { communityNftAbi } from "@/lib/create-nft";
import {
  assertNftDeploymentTransaction,
  isLocalNftDeploymentRequest,
} from "@/lib/create-nft-deployment";
import {
  communityNftDeployment,
  matchesCommunityNftRuntime,
} from "@/lib/server/community-nft-artifact";
import { readJsonBody } from "@/lib/server/request-security";
import {
  marketplaceAddressSchema,
  marketplaceClient,
  marketplaceHashSchema,
} from "@/services/marketplace-common";

const royalty = z.coerce.number().int().min(1).max(10000);
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  if (!isLocalNftDeploymentRequest(request, process.env.NODE_ENV))
    return json({ error: "Not found" }, 404);
  const parsed = royalty.safeParse(new URL(request.url).searchParams.get("royaltyBps"));
  if (!parsed.success)
    return json({ error: "Enter an explicit royalty between 1 and 10000 basis points." }, 400);
  return json(communityNftDeployment(parsed.data));
}

export async function POST(request: Request) {
  if (!isLocalNftDeploymentRequest(request, process.env.NODE_ENV))
    return json({ error: "Not found" }, 404);
  try {
    const input = z
      .object({
        hash: marketplaceHashSchema,
        account: marketplaceAddressSchema,
        royaltyBps: royalty,
      })
      .strict()
      .parse(await readJsonBody(request, 1024));
    const artifact = communityNftDeployment(input.royaltyBps);
    const hash = input.hash as Hex;
    const [transaction, receipt] = await Promise.all([
      marketplaceClient.getTransaction({ hash }),
      marketplaceClient.getTransactionReceipt({ hash }),
    ]);
    const address = assertNftDeploymentTransaction(transaction, receipt, {
      hash,
      account: input.account as Address,
      input: concatHex([artifact.data, BUILDER_CODE_SUFFIX]),
    });
    const [code, recipient, bps] = await Promise.all([
      marketplaceClient.getCode({ address }),
      marketplaceClient.readContract({
        address,
        abi: communityNftAbi,
        functionName: "royaltyRecipient",
      }),
      marketplaceClient.readContract({ address, abi: communityNftAbi, functionName: "royaltyBps" }),
    ]);
    if (
      !matchesCommunityNftRuntime(code) ||
      !isAddressEqual(recipient, artifact.recipient) ||
      bps !== BigInt(input.royaltyBps)
    )
      throw new Error("Runtime mismatch");
    return json({ address, hash, royaltyBps: input.royaltyBps });
  } catch {
    return json(
      {
        error:
          "Deployment could not be verified. Keep the transaction hash and retry verification.",
      },
      400,
    );
  }
}
