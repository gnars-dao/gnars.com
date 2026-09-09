import type { Account } from "thirdweb/wallets";
import { keccak256, toBytes } from "viem";

export interface WalletAuthorization {
  walletAddress: string;
  issuedAt: number;
  nonce: string;
  signature: `0x${string}`;
}

export const WALLET_AUTH_MAX_AGE_MS = 5 * 60 * 1000;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function walletPayloadDigest(payload: unknown) {
  return keccak256(toBytes(canonicalJson(payload)));
}

export function walletAuthorizationMessage(
  authorization: Omit<WalletAuthorization, "signature">,
  { method, path, payload }: { method: string; path: string; payload: unknown },
) {
  return [
    "Gnars Website Authorization",
    "Audience: gnars.com",
    "Chain: 8453",
    `Method: ${method.toUpperCase()}`,
    `Path: ${path}`,
    `Wallet: ${authorization.walletAddress.toLowerCase()}`,
    `Payload: ${walletPayloadDigest(payload)}`,
    `Issued At: ${authorization.issuedAt}`,
    `Nonce: ${authorization.nonce}`,
  ].join("\n");
}

export async function signWalletRequest(
  account: Account,
  request: { method: string; path: string; payload: unknown },
): Promise<WalletAuthorization> {
  const authorization = {
    walletAddress: account.address,
    issuedAt: Date.now(),
    nonce: crypto.randomUUID(),
  };
  const signature = await account.signMessage({
    message: walletAuthorizationMessage(authorization, request),
  });
  return { ...authorization, signature };
}
