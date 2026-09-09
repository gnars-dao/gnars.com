import { getContractAddress, isAddressEqual, type Address, type Hex } from "viem";

export function isLocalNftDeploymentHost(host: string | null, environment: string): boolean {
  if (environment !== "development" || !host) return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host);
  return Boolean(match && (!match[2] || (Number(match[2]) > 0 && Number(match[2]) <= 65535)));
}

export function isLocalNftDeploymentRequest(request: Request, environment: string): boolean {
  const url = new URL(request.url);
  return (
    isLocalNftDeploymentHost(request.headers.get("host"), environment) &&
    isLocalNftDeploymentHost(url.host, environment) &&
    (request.headers.get("origin") === null || request.headers.get("origin") === url.origin)
  );
}

/** EIP-7702 EOAs can still originate CREATE; smart contract wallets cannot. */
export function canOriginateNftDeployment(code: string | undefined): boolean {
  return code === undefined || code === "0x" || /^0xef0100[0-9a-f]{40}$/i.test(code);
}

/** Only explicit refusal, never an RPC message substring, unlocks an unknown request. */
export function isNftWalletRejection(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6; depth++) {
    if (!current || typeof current !== "object") return false;
    if ("code" in current && (current.code === 4001 || current.code === "ACTION_REJECTED"))
      return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export function assertNftDeploymentTransaction(
  transaction: {
    hash: Hex;
    chainId?: number;
    from: Address;
    to: Address | null;
    value: bigint;
    input: Hex;
    nonce: number;
  },
  receipt: {
    transactionHash: Hex;
    status: "success" | "reverted";
    contractAddress?: Address | null;
  },
  expected: { hash: Hex; account: Address; input: Hex },
): Address {
  const address = getContractAddress({ from: expected.account, nonce: BigInt(transaction.nonce) });
  if (
    transaction.chainId !== 8453 ||
    receipt.status !== "success" ||
    transaction.hash.toLowerCase() !== expected.hash.toLowerCase() ||
    receipt.transactionHash.toLowerCase() !== expected.hash.toLowerCase() ||
    !isAddressEqual(transaction.from, expected.account) ||
    transaction.to !== null ||
    transaction.value !== 0n ||
    transaction.input.toLowerCase() !== expected.input.toLowerCase() ||
    !receipt.contractAddress ||
    !isAddressEqual(receipt.contractAddress, address)
  ) {
    throw new Error("NFT deployment transaction mismatch.");
  }
  return address;
}
