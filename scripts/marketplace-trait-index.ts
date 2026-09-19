/** Read-only, resumable Gnars metadata backfill. Does not publish an incomplete index. */
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createPublicClient, erc721Abi, http, parseAbi, zeroAddress } from "viem";
import { base } from "viem/chains";
import { z } from "zod";
import { DAO_ADDRESSES } from "../src/lib/config";
import { decodeInlineNftMetadata, parseNftTraits } from "../src/lib/marketplace/nft-metadata";
import {
  advanceTraitIndex,
  traitIndexComplete,
  validateTraitIndex,
  type TraitIndex,
} from "../src/lib/marketplace/trait-index";
import { subgraphQuery } from "../src/lib/subgraph";

async function main() {
  const path = process.argv[2];
  const steps = Number(process.argv[3] ?? "1");
  if (!path || !Number.isInteger(steps) || steps < 1 || steps > 1000)
    throw new Error("Usage: marketplace-trait-index.ts <checkpoint.json> [steps:1..1000]");
  const rpc =
    process.env.BASE_RPC ||
    process.env.NEXT_PUBLIC_BASE_RPC_URL ||
    (process.env.ALCHEMY_API_KEY
      ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      : undefined);
  if (!rpc) throw new Error("Base RPC configuration required");
  const client = createPublicClient({
    chain: base,
    transport: http(rpc, { timeout: 15000, retryCount: 0 }),
  });
  if ((await client.getChainId()) !== 8453) throw new Error("Expected Base chain");
  const lock = await open(`${path}.lock`, "wx", 0o600);
  try {
    let index: TraitIndex;
    try {
      index = validateTraitIndex(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const meta = z
        .object({
          _meta: z.object({
            hasIndexingErrors: z.literal(false),
            block: z.object({ number: z.number().int().nonnegative() }),
          }),
        })
        .parse(
          await subgraphQuery(
            "{ _meta { block { number } hasIndexingErrors } }",
            {},
            { revalidate: 0 },
          ),
        );
      const finalized = await client.getBlock({ blockTag: "finalized" });
      const number =
        BigInt(meta._meta.block.number) < finalized.number
          ? BigInt(meta._meta.block.number)
          : finalized.number;
      const block = await client.getBlock({ blockNumber: number });
      const supply = await client.readContract({
        address: DAO_ADDRESSES.token,
        abi: parseAbi(["function totalSupply() view returns (uint256)"]),
        functionName: "totalSupply",
        blockNumber: number,
      });
      index = validateTraitIndex({
        version: 1,
        chainId: 8453,
        collection: DAO_ADDRESSES.token.toLowerCase(),
        blockNumber: String(number),
        blockHash: block.hash,
        expectedCount: Number(supply),
        cursor: null,
        enumerated: false,
        entries: [],
      });
    }
    if (index.collection !== DAO_ADDRESSES.token.toLowerCase())
      throw new Error("Wrong checkpoint collection");
    const snapshot = await client.getBlock({ blockNumber: BigInt(index.blockNumber) });
    const finality = await client.getBlock({ blockTag: "finalized" });
    if (snapshot.hash !== index.blockHash || snapshot.number > finality.number)
      throw new Error("Checkpoint block is not canonical and finalized");
    const expectedSupply = await client.readContract({
      address: DAO_ADDRESSES.token,
      abi: parseAbi(["function totalSupply() view returns (uint256)"]),
      functionName: "totalSupply",
      blockNumber: snapshot.number,
    });
    if (expectedSupply !== BigInt(index.expectedCount))
      throw new Error("Checkpoint supply does not match the contract");
    for (let step = 0; step < steps && !traitIndexComplete(index); step++) {
      const next = await advanceTraitIndex(index, {
        blockHash: async () =>
          (await client.getBlock({ blockNumber: BigInt(index.blockNumber) })).hash,
        page: async (before) => {
          const raw = await subgraphQuery(
            `query TraitIndex($dao: ID!, $zero: Bytes!, $hash: Bytes!${before ? ", $before: BigInt!" : ""}) {
            _meta(block: {hash: $hash}) { block { hash } hasIndexingErrors }
            tokens(first: 24, block: {hash: $hash}, where: {dao: $dao, owner_not: $zero${before ? ", tokenId_lt: $before" : ""}}, orderBy: tokenId, orderDirection: desc) { tokenId }
          }`,
            {
              dao: index.collection,
              zero: zeroAddress,
              hash: index.blockHash,
              ...(before ? { before } : {}),
            },
            { revalidate: 0 },
          );
          const page = z
            .object({
              _meta: z.object({
                block: z.object({ hash: z.literal(index.blockHash) }),
                hasIndexingErrors: z.literal(false),
              }),
              tokens: z.array(z.object({ tokenId: z.string() })).max(24),
            })
            .parse(raw);
          return page.tokens.map((token) => token.tokenId);
        },
        read: async (ids) => {
          const values = await client.multicall({
            allowFailure: true,
            blockNumber: BigInt(index.blockNumber),
            contracts: ids.map((id) => ({
              address: DAO_ADDRESSES.token,
              abi: erc721Abi,
              functionName: "tokenURI" as const,
              args: [BigInt(id)],
            })),
          });
          return values.map((value) => {
            if (value.status !== "success") return null;
            try {
              return parseNftTraits(decodeInlineNftMetadata(value.result));
            } catch {
              return null;
            }
          });
        },
      });
      await writeFile(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      const stalled = JSON.stringify(next) === JSON.stringify(index);
      index = next;
      console.log(
        JSON.stringify({
          block: index.blockNumber,
          indexed: index.entries.filter((entry) => entry.traits !== null).length,
          expected: index.expectedCount,
          complete: traitIndexComplete(index),
        }),
      );
      if (stalled) throw new Error("Metadata unavailable; checkpoint retained for retry");
    }
  } finally {
    await lock.close();
    await unlink(`${path}.lock`);
  }
}
main().catch(() => {
  console.error(
    "Trait backfill failed. Check configuration, provider availability and checkpoint; no secrets logged.",
  );
  process.exitCode = 1;
});
