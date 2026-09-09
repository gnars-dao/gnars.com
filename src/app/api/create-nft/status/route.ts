import { isAddressEqual } from "viem";
import { DAO_ADDRESSES, MARKETPLACE_CONFIG } from "@/lib/config";
import { communityNftAbi, communityNftAddress } from "@/lib/create-nft";
import { matchesCommunityNftRuntime } from "@/lib/server/community-nft-artifact";
import { marketplaceClient } from "@/services/marketplace-common";

export async function GET() {
  const address = communityNftAddress();
  if (!address)
    return Response.json({ ready: false }, { headers: { "Cache-Control": "no-store" } });
  try {
    const [chain, gnars, recipient, royaltyBps, minimum, code] = await Promise.all([
      marketplaceClient.getChainId(),
      marketplaceClient.readContract({ address, abi: communityNftAbi, functionName: "gnars" }),
      marketplaceClient.readContract({
        address,
        abi: communityNftAbi,
        functionName: "royaltyRecipient",
      }),
      marketplaceClient.readContract({ address, abi: communityNftAbi, functionName: "royaltyBps" }),
      marketplaceClient.readContract({ address, abi: communityNftAbi, functionName: "MIN_GNARS" }),
      marketplaceClient.getCode({ address }),
    ]);
    if (
      chain !== 8453 ||
      !matchesCommunityNftRuntime(code) ||
      !isAddressEqual(gnars, DAO_ADDRESSES.token) ||
      !isAddressEqual(recipient, MARKETPLACE_CONFIG.communityFeeRecipient) ||
      minimum !== 6n ||
      royaltyBps <= 0n ||
      royaltyBps > 10000n
    )
      throw new Error("Configuration mismatch");
    return Response.json(
      { ready: true, address, royaltyBps: Number(royaltyBps), recipient },
      { headers: { "Cache-Control": "public, s-maxage=60" } },
    );
  } catch {
    return Response.json(
      { error: "NFT contract verification is unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
