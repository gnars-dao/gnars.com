/** Read-only approval diagnostics. Never signs or broadcasts a transaction. */
import { createPublicClient, erc721Abi, http, isHex, type Hex } from "viem";
import { base } from "viem/chains";
import { DAO_ADDRESSES } from "../src/lib/config";

async function main() {
  process.loadEnvFile(".env.local");
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw new Error("ALCHEMY_API_KEY required");
  const client = createPublicClient({
    chain: base,
    transport: http(`https://base-mainnet.g.alchemy.com/v2/${key}`, {
      timeout: 10000,
      retryCount: 0,
    }),
  });
  const tokenId = BigInt(process.argv[2] ?? "5423");
  const tip = await client.getBlockNumber();
  const owner = await client.readContract({
    address: DAO_ADDRESSES.token,
    abi: erc721Abi,
    functionName: "ownerOf",
    args: [tokenId],
  });
  const approved = await client.readContract({
    address: DAO_ADDRESSES.token,
    abi: erc721Abi,
    functionName: "getApproved",
    args: [tokenId],
  });
  console.log(JSON.stringify({ tokenId: String(tokenId), tip: String(tip), owner, approved }));
  let hashes: Hex[];
  if (process.argv[3]) {
    if (!isHex(process.argv[3]) || process.argv[3].length !== 66) throw new Error("Invalid hash");
    hashes = [process.argv[3]];
  } else {
    const response = await fetch(
      `https://base.blockscout.com/api/v2/addresses/${owner}/transactions?filter=from`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw new Error(`Explorer status ${response.status}`);
    const body = (await response.json()) as {
      items: Array<{ hash: Hex; to?: { hash: string }; raw_input?: string }>;
    };
    hashes = body.items
      .filter(
        (tx) =>
          tx.to?.hash.toLowerCase() === DAO_ADDRESSES.token.toLowerCase() &&
          tx.raw_input?.startsWith("0x095ea7b3") &&
          BigInt(`0x${tx.raw_input.slice(74, 138)}`) === tokenId,
      )
      .map((tx) => tx.hash);
  }
  for (const hash of hashes) {
    const tx = await client.getTransaction({ hash });
    const receipt = await client.getTransactionReceipt({ hash });
    console.log(
      JSON.stringify(
        {
          hash,
          chainId: tx.chainId,
          type: tx.type,
          from: tx.from,
          to: tx.to,
          input: tx.input,
          value: tx.value,
          blockNumber: tx.blockNumber,
          status: receipt.status,
        },
        (_, value) => (typeof value === "bigint" ? String(value) : value),
      ),
    );
  }
}
main().catch((error) => {
  const detail = error as {
    name?: string;
    shortMessage?: string;
    details?: string;
    status?: number;
  };
  const safe = JSON.stringify({
    name: detail.name,
    message: detail.shortMessage,
    details: detail.details,
    status: detail.status,
  })
    .replaceAll(process.env.ALCHEMY_API_KEY ?? "__no_key__", "[redacted]")
    .replace(/https?:[^\s"\\]+/g, "[endpoint]");
  console.error(safe);
  process.exitCode = 1;
});
