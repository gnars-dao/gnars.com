import { getAddress, keccak256, toHex, type Address } from "viem";

const REFERRED_TOPIC = keccak256(toHex("UserReferred(uint256,address,address,uint256)"));
const PAGE_SIZE = 1000;
const MAX_PAGES = 4;
const padTopic = (address: Address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

export type MorpheusCandidates = { users: Address[]; resolved: boolean };

/** Events discover addresses only. Current principal/referrer must be read on-chain. */
async function fromIndexer(
  endpoint: string,
  pool: Address,
  referrer: Address,
): Promise<MorpheusCandidates> {
  const users = new Set<Address>();
  let fromBlock = 0n;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(endpoint);
      const parameters = {
        module: "logs",
        action: "getLogs",
        address: pool,
        topic0: REFERRED_TOPIC,
        topic0_3_opr: "and",
        topic3: padTopic(referrer),
        fromBlock: fromBlock.toString(),
        toBlock: "latest",
        page: "1",
        offset: String(PAGE_SIZE),
      };
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) break;
      const body = (await response.json()) as {
        status?: string;
        message?: string;
        result?: unknown;
      };
      if (
        body.status === "0" &&
        /^No (?:logs|records) found$/i.test(body.message ?? "") &&
        Array.isArray(body.result) &&
        body.result.length === 0
      ) {
        return { users: [...users], resolved: true };
      }
      if (body.status !== "1" || !Array.isArray(body.result)) break;
      let lastBlock = fromBlock;
      for (const raw of body.result) {
        const log = raw as { address?: string; topics?: string[]; blockNumber?: string };
        if (
          log.address?.toLowerCase() !== pool.toLowerCase() ||
          log.topics?.length !== 4 ||
          log.topics[0]?.toLowerCase() !== REFERRED_TOPIC ||
          log.topics[1] !== `0x${"0".repeat(64)}` ||
          log.topics[3]?.toLowerCase() !== padTopic(referrer) ||
          !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[2]) ||
          !/^0x[0-9a-f]+$/i.test(log.blockNumber ?? "")
        ) {
          throw new Error("Malformed referral log");
        }
        const block = BigInt(log.blockNumber!);
        if (block < lastBlock) throw new Error("Unordered referral history");
        lastBlock = block;
        users.add(getAddress(`0x${log.topics[2].slice(-40)}`));
      }
      if (body.result.length < PAGE_SIZE) return { users: [...users], resolved: true };
      // Overlap the boundary block so multiple events in it cannot be skipped.
      // A saturated single block or the page cap is incomplete, never "none".
      if (lastBlock <= fromBlock) break;
      fromBlock = lastBlock;
    }
  } catch {
    // Preserve discovered candidates while surfacing the source's incompleteness.
  }
  return { users: [...users], resolved: false };
}

export async function discoverMorpheusUsers(
  pool: Address,
  referrer: Address,
): Promise<MorpheusCandidates> {
  const blockscout = await fromIndexer("https://eth.blockscout.com/api", pool, referrer);
  if (blockscout.resolved) return blockscout;
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return blockscout;
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", "1");
  url.searchParams.set("apikey", key);
  const etherscan = await fromIndexer(url.toString(), pool, referrer);
  return {
    users: [...new Set([...blockscout.users, ...etherscan.users])],
    resolved: etherscan.resolved,
  };
}
