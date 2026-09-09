import "server-only";
import { createHash } from "node:crypto";
import { encodeDeployData, type Abi, type Hex } from "viem";
import { DAO_ADDRESSES, MARKETPLACE_CONFIG } from "@/lib/config";
import artifact from "../../../contracts/gnars-community-nft/artifacts/GnarsCommunityNFT.json";

export function communityNftDeployment(royaltyBps: number) {
  if (!Number.isInteger(royaltyBps) || royaltyBps < 1 || royaltyBps > 10000)
    throw new Error("Invalid royalty");
  const bytecode = artifact.creationBytecode as Hex;
  if (
    createHash("sha256")
      .update(Buffer.from(bytecode.slice(2), "hex"))
      .digest("hex") !== artifact.creationBytecodeSha256
  )
    throw new Error("Artifact mismatch");
  return {
    data: encodeDeployData({
      abi: artifact.abi as Abi,
      bytecode,
      args: [DAO_ADDRESSES.token, MARKETPLACE_CONFIG.communityFeeRecipient, royaltyBps],
    }),
    checksum: artifact.creationBytecodeSha256,
    recipient: MARKETPLACE_CONFIG.communityFeeRecipient,
    royaltyBps,
  };
}

export function matchesCommunityNftRuntime(code: Hex | undefined) {
  if (!code || code.length !== artifact.deployedBytecode.length) return false;
  const mask = (value: string) => {
    const bytes = Buffer.from(value.slice(2), "hex");
    for (const slots of Object.values(artifact.immutableReferences)) {
      for (const { start, length } of slots) bytes.fill(0, start, start + length);
    }
    return bytes.toString("hex");
  };
  return mask(code) === mask(artifact.deployedBytecode);
}
