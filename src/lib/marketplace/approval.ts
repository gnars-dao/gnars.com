import {
  encodeFunctionData,
  erc721Abi,
  isAddressEqual,
  type Address,
  type PublicClient,
} from "viem";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  getGnarsMarketplaceAddress,
  isSupportedListingOperator,
  OPENSEA_CONDUIT_ADDRESS,
} from "./routing";
import { SEAPORT_ADDRESS, type MarketplaceTransactionIntent } from "./seaport";

type ApprovalClient = Pick<PublicClient, "getChainId" | "getBlockNumber" | "readContract">;

export function isListingApprovalIntent(
  intent: MarketplaceTransactionIntent | undefined,
  account: Address,
  tokenId: string,
  operator: Address = SEAPORT_ADDRESS,
): boolean {
  return Boolean(
    intent &&
      isSupportedListingOperator(operator) &&
      isAddressEqual(intent.account, account) &&
      isAddressEqual(intent.to, DAO_ADDRESSES.token) &&
      intent.value === "0" &&
      intent.data.toLowerCase() ===
        encodeFunctionData({
          abi: erc721Abi,
          functionName: "approve",
          args: [operator, BigInt(tokenId)],
        }).toLowerCase(),
  );
}

export function getListingApprovalOperator(
  intent: MarketplaceTransactionIntent | undefined,
  account: Address,
  tokenId: string,
): Address | undefined {
  const custom = getGnarsMarketplaceAddress();
  return [SEAPORT_ADDRESS, OPENSEA_CONDUIT_ADDRESS, ...(custom ? [custom] : [])].find((operator) =>
    isListingApprovalIntent(intent, account, tokenId, operator),
  );
}

/** Permission state can recover an approval even when receipt lookup is unavailable. */
export async function hasConfirmedMarketplaceApproval(
  client: ApprovalClient,
  account: Address,
  tokenId: string,
  operator: Address = SEAPORT_ADDRESS,
): Promise<boolean> {
  if (!isSupportedListingOperator(operator)) throw new Error("Unsupported NFT approval operator");
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
  if (isAddressEqual(approved, operator)) return true;
  return (
    (await client.readContract({
      address: DAO_ADDRESSES.token,
      abi: erc721Abi,
      functionName: "isApprovedForAll",
      args: [account, operator],
      blockNumber,
    })) === true
  );
}
