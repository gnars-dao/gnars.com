import {
  encodeFunctionData,
  erc721Abi,
  isAddressEqual,
  type Address,
  type PublicClient,
} from "viem";
import { DAO_ADDRESSES } from "@/lib/config";
import { SEAPORT_ADDRESS, type MarketplaceTransactionIntent } from "./seaport";

type ApprovalClient = Pick<PublicClient, "getChainId" | "getBlockNumber" | "readContract">;

export function isListingApprovalIntent(
  intent: MarketplaceTransactionIntent | undefined,
  account: Address,
  tokenId: string,
): boolean {
  return Boolean(
    intent &&
      isAddressEqual(intent.account, account) &&
      isAddressEqual(intent.to, DAO_ADDRESSES.token) &&
      intent.value === "0" &&
      intent.data.toLowerCase() ===
        encodeFunctionData({
          abi: erc721Abi,
          functionName: "approve",
          args: [SEAPORT_ADDRESS, BigInt(tokenId)],
        }).toLowerCase(),
  );
}

/** Permission state can recover an approval even when receipt lookup is unavailable. */
export async function hasConfirmedMarketplaceApproval(
  client: ApprovalClient,
  account: Address,
  tokenId: string,
): Promise<boolean> {
  if ((await client.getChainId()) !== 8453) throw new Error("Base chain required");
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const owner = await client.readContract({
    address: DAO_ADDRESSES.token,
    abi: erc721Abi,
    functionName: "ownerOf",
    args: [BigInt(tokenId)],
    blockNumber,
  });
  const approved = await client.readContract({
    address: DAO_ADDRESSES.token,
    abi: erc721Abi,
    functionName: "getApproved",
    args: [BigInt(tokenId)],
    blockNumber,
  });
  if (!isAddressEqual(owner, account)) return false;
  if (isAddressEqual(approved, SEAPORT_ADDRESS)) return true;
  return (
    (await client.readContract({
      address: DAO_ADDRESSES.token,
      abi: erc721Abi,
      functionName: "isApprovedForAll",
      args: [account, SEAPORT_ADDRESS],
      blockNumber,
    })) === true
  );
}
