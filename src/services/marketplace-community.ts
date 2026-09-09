import "server-only";
import { unstable_cache } from "next/cache";
import { Pool } from "pg";
import {
  erc721Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { BUILDER_CODE, DAO_ADDRESSES } from "@/lib/config";
import { ipfsToHttp } from "@/lib/ipfs";
import {
  COMMUNITY_FEE_RECIPIENT,
  getCommunityFeePolicy,
  MIN_COMMUNITY_GNARS,
  validateCommunityFeePolicy,
  type CommunityFeePolicy,
} from "@/lib/marketplace/community-policy";
import { buildCommunityListingQuote } from "@/lib/marketplace/listing-intent";
import { getMarketplaceProtocolAddress } from "@/lib/marketplace/routing";
import {
  getListingFulfillment,
  getListingOrderHash,
  getListingPriceWei,
  getListingRoyalty,
  getListingStatus,
  listingSchema,
  seaportAbi,
  validateListingOnchain,
  validateListingStructure,
  type SignedListing,
} from "@/lib/marketplace/seaport";
import { marketplaceDatabaseConnection } from "@/lib/server/marketplace-database";
import { RequestSecurityError, verifyWalletAuthorization } from "@/lib/server/request-security";
import {
  MARKETPLACE_PAGE_SIZE,
  marketplaceAddressSchema,
  marketplaceClient,
  marketplaceHashSchema,
  MarketplaceServiceError,
  marketplaceSimulationError,
  marketplaceUintSchema,
  marketplaceUnavailable,
  parseMarketplaceInput,
} from "@/services/marketplace-common";
import { marketplaceContractStorageReady } from "@/services/marketplace-orders";
import type {
  CommunityMarketplacePage,
  MarketplaceEligibility,
  MarketplaceFulfillment,
  MarketplaceItem,
  MarketplaceOffer,
  MarketplacePage,
} from "@/types/marketplace";

export const COMMUNITY_CACHE_TAG = "marketplace-community";
let pool: Pool | undefined;
function database() {
  const connectionString =
    process.env.MARKETPLACE_DATABASE_URL ||
    process.env.ROUNDS_DATABASE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.DATABASE_URL;
  if (!connectionString)
    throw marketplaceUnavailable("Community marketplace storage is not configured.");
  pool ??= new Pool({
    ...marketplaceDatabaseConnection(connectionString, process.env.MARKETPLACE_DATABASE_SSL_CA),
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  return pool;
}

const communityDatabaseReady = unstable_cache(
  async () => {
    try {
      await database().query(
        "SELECT id, protocol_address, order_hash, collection_address, token_id, seller, signed_order, fee_policy, metadata, hidden, moderation_revision, status FROM public.marketplace_community_orders LIMIT 0",
      );
      await database().query(
        "SELECT nonce, actor, order_hash, wallet_authorization FROM public.marketplace_community_moderation LIMIT 0",
      );
      const result = await database().query<{ ready: boolean }>(`SELECT
      has_table_privilege(current_user, 'public.marketplace_community_orders', 'SELECT') AND
      has_table_privilege(current_user, 'public.marketplace_community_orders', 'INSERT') AND
      has_column_privilege(current_user, 'public.marketplace_community_orders', 'status', 'UPDATE') AND
      has_column_privilege(current_user, 'public.marketplace_community_orders', 'checked_at', 'UPDATE') AND
      has_column_privilege(current_user, 'public.marketplace_community_orders', 'hidden', 'UPDATE') AND
      has_column_privilege(current_user, 'public.marketplace_community_orders', 'moderation_revision', 'UPDATE') AND
      has_column_privilege(current_user, 'public.marketplace_community_orders', 'moderated_by', 'UPDATE') AND
      has_column_privilege(current_user, 'public.marketplace_community_orders', 'moderation_reason', 'UPDATE') AND
      has_column_privilege(current_user, 'public.marketplace_community_orders', 'moderated_at', 'UPDATE') AND
      has_table_privilege(current_user, 'public.marketplace_community_moderation', 'SELECT') AND
      has_table_privilege(current_user, 'public.marketplace_community_moderation', 'INSERT') AND
      has_sequence_privilege(current_user, pg_get_serial_sequence('public.marketplace_community_orders', 'id'), 'USAGE') AS ready`);
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    }
  },
  ["marketplace-community-storage-v1"],
  { revalidate: 60 },
);

export async function communityMarketplaceReady() {
  if (!(await marketplaceContractStorageReady())) return false;
  return communityDatabaseReady();
}

async function requireReady() {
  if (!(await communityMarketplaceReady()))
    throw marketplaceUnavailable("Community marketplace storage is unavailable.");
}

export function isCommunityModerator(address: Address): boolean {
  const configured =
    process.env.MARKETPLACE_COMMUNITY_ADMIN_ADDRESSES?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  if (!configured.length || configured.some((value) => !isAddress(value, { strict: false })))
    return false;
  return configured.some((value) => isAddressEqual(value as Address, address));
}

function collectionAddress(raw: string): Address {
  const parsed = marketplaceAddressSchema.safeParse(raw);
  if (
    !parsed.success ||
    isAddressEqual(parsed.data as Address, zeroAddress) ||
    isAddressEqual(parsed.data as Address, DAO_ADDRESSES.token)
  )
    throw new RequestSecurityError(
      400,
      "Choose a community ERC721 collection on Base. Gnars use the native listings.",
    );
  return getAddress(parsed.data);
}

async function checkCollection(collection: Address) {
  const [chain, code, supported] = await Promise.all([
    marketplaceClient.getChainId(),
    marketplaceClient.getCode({ address: collection }),
    marketplaceClient.readContract({
      address: collection,
      abi: parseAbi(["function supportsInterface(bytes4 interfaceId) view returns (bool)"]),
      functionName: "supportsInterface",
      args: ["0x80ac58cd"],
    }),
  ]);
  if (chain !== 8453) throw marketplaceUnavailable("Marketplace RPC is not on Base.");
  if (!code || code === "0x" || !supported)
    throw new RequestSecurityError(400, "Only deployed Base ERC721 collections are supported.");
}

export async function getCommunityEligibility(owner: Address): Promise<MarketplaceEligibility> {
  if ((await marketplaceClient.getChainId()) !== 8453)
    throw marketplaceUnavailable("Marketplace RPC is not on Base.");
  const balance = await marketplaceClient.readContract({
    address: DAO_ADDRESSES.token,
    abi: erc721Abi,
    functionName: "balanceOf",
    args: [owner],
  });
  const fee = getCommunityFeePolicy();
  return {
    owner,
    balance: balance.toString(),
    minimum: MIN_COMMUNITY_GNARS,
    eligible: balance >= BigInt(MIN_COMMUNITY_GNARS),
    feeBps: fee?.basisPoints ?? null,
    feeRecipient: COMMUNITY_FEE_RECIPIENT,
    canModerate: isCommunityModerator(owner),
  };
}

function safeImage(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  const candidate = value.startsWith("ipfs://") ? ipfsToHttp(value) : value;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (
      /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(
        url.hostname,
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

async function boundedMetadata(response: Response): Promise<unknown> {
  if (!response.ok || !response.body)
    throw marketplaceUnavailable("NFT metadata provider is unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256_000) {
        await reader.cancel();
        throw marketplaceUnavailable("NFT metadata is too large.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

const metadataSchema = z.object({
  tokenId: z.string().max(80),
  name: z.string().nullish(),
  contract: z.object({ address: marketplaceAddressSchema, name: z.string().nullish() }),
  image: z
    .object({
      cachedUrl: z.string().nullish(),
      thumbnailUrl: z.string().nullish(),
      originalUrl: z.string().nullish(),
    })
    .nullish(),
});

const nftMetadata = unstable_cache(
  async (collection: Address, tokenId: string) => {
    const key = process.env.ALCHEMY_API_KEY;
    if (!key) throw marketplaceUnavailable("NFT metadata provider is not configured.");
    const params = new URLSearchParams({
      contractAddress: collection,
      tokenId,
      refreshCache: "false",
    });
    const response = await fetch(
      `https://base-mainnet.g.alchemy.com/nft/v3/${encodeURIComponent(key)}/getNFTMetadata?${params}`,
      { cache: "no-store", signal: AbortSignal.timeout(8000) },
    );
    const metadata = metadataSchema.parse(await boundedMetadata(response));
    if (
      !isAddressEqual(metadata.contract.address as Address, collection) ||
      BigInt(metadata.tokenId) !== BigInt(tokenId)
    )
      throw marketplaceUnavailable("NFT metadata identity could not be verified.");
    return {
      name: metadata.name?.trim().slice(0, 200) || `NFT #${tokenId}`,
      collectionName:
        metadata.contract.name?.trim().slice(0, 120) ||
        `${collection.slice(0, 6)}...${collection.slice(-4)}`,
      image:
        safeImage(metadata.image?.cachedUrl) ??
        safeImage(metadata.image?.thumbnailUrl) ??
        safeImage(metadata.image?.originalUrl),
    };
  },
  ["marketplace-community-metadata-v1"],
  { revalidate: 300, tags: [COMMUNITY_CACHE_TAG] },
);

export const communityQuoteSchema = z
  .object({
    collectionAddress: marketplaceAddressSchema,
    tokenId: marketplaceUintSchema,
    priceWei: marketplaceUintSchema,
  })
  .strict();
export async function quoteCommunityListing(input: z.infer<typeof communityQuoteSchema>) {
  await requireReady();
  const collection = collectionAddress(input.collectionAddress);
  const fee = getCommunityFeePolicy();
  if (!fee) throw marketplaceUnavailable("Community marketplace fee is not configured.");
  await checkCollection(collection);
  const royalty = await getListingRoyalty(
    marketplaceClient,
    BigInt(input.tokenId),
    BigInt(input.priceWei),
    collection,
  );
  return buildCommunityListingQuote(input.priceWei, royalty, fee);
}

type Row = {
  id: string;
  protocol_address: string;
  order_hash: Hex;
  collection_address: Address;
  token_id: string;
  seller: Address;
  signed_order: unknown;
  fee_policy: unknown;
  metadata: unknown;
  status: string;
  hidden: boolean;
  moderation_revision: number;
  checked_at?: Date | string;
};
const storedMetadata = z.object({
  name: z.string().max(200),
  collectionName: z.string().max(120),
  image: z.string().max(8192).nullable(),
});
function decodeRow(row: Row) {
  const protocol = getMarketplaceProtocolAddress("gnars-contract");
  if (row.protocol_address !== protocol.toLowerCase())
    throw marketplaceUnavailable("Stored community protocol mismatch.");
  const collection = collectionAddress(row.collection_address);
  const feePolicy = validateCommunityFeePolicy(row.fee_policy);
  const options = { source: "gnars-contract" as const, collectionAddress: collection, feePolicy };
  const listing = validateListingStructure(row.signed_order, { ...options, allowExpired: true });
  if (
    getListingOrderHash(listing.parameters).toLowerCase() !== row.order_hash.toLowerCase() ||
    listing.parameters.offer[0].identifierOrCriteria !== row.token_id ||
    !isAddressEqual(listing.parameters.offerer, row.seller)
  )
    throw marketplaceUnavailable("Stored community order identity mismatch.");
  return { listing, feePolicy, options, collection };
}

function offerFor(
  row: Row,
  listing: SignedListing,
  feePolicy: CommunityFeePolicy,
): MarketplaceOffer {
  return {
    id: `community:${row.protocol_address}:${row.order_hash}`,
    source: "gnars-contract",
    orderHash: row.order_hash,
    protocolAddress: getMarketplaceProtocolAddress("gnars-contract"),
    collectionAddress: row.collection_address,
    seller: listing.parameters.offerer,
    priceWei: getListingPriceWei(listing).toString(),
    currency: "ETH",
    expiresAt: Number(listing.parameters.endTime),
    feePolicy,
    moderation: { hidden: row.hidden, revision: row.moderation_revision },
  };
}

export async function publishCommunityOrder(raw: unknown) {
  await requireReady();
  // Recover acknowledged orders under their immutable fee snapshot before new-submission checks.
  const envelope = parseMarketplaceInput(
    listingSchema.extend({
      parameters: listingSchema.shape.parameters.extend({
        consideration: listingSchema.shape.parameters.shape.consideration.max(3),
      }),
    }),
    raw,
  );
  const candidateHash = getListingOrderHash(envelope.parameters).toLowerCase();
  const protocol = getMarketplaceProtocolAddress("gnars-contract").toLowerCase();
  const saved = await database().query<Row>(
    "SELECT * FROM public.marketplace_community_orders WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2",
    [protocol, candidateHash],
  );
  if (saved.rows[0]) {
    if (saved.rows[0].hidden)
      throw new RequestSecurityError(
        403,
        "This listing was removed from the community marketplace.",
      );
    const decoded = decodeRow(saved.rows[0]);
    return offerFor(saved.rows[0], decoded.listing, decoded.feePolicy);
  }
  const currentFee = getCommunityFeePolicy();
  if (!currentFee) throw marketplaceUnavailable("Community marketplace fee is not configured.");
  const collection = collectionAddress(envelope.parameters.offer[0].token);
  const options = {
    source: "gnars-contract" as const,
    collectionAddress: collection,
    feePolicy: currentFee,
  };
  const listing = validateListingStructure(raw, options);
  await checkCollection(collection);
  const { orderHash } = await validateListingOnchain(marketplaceClient, listing, {
    ...options,
    requireApproval: true,
  });
  const eligibility = await getCommunityEligibility(listing.parameters.offerer);
  if (!eligibility.eligible)
    throw new RequestSecurityError(
      403,
      "At least six Gnars are required to submit community listings.",
    );
  const metadata = await nftMetadata(collection, listing.parameters.offer[0].identifierOrCriteria);
  const seller = listing.parameters.offerer.toLowerCase();
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`community:${seller}`]);
    const existing = await client.query<Row>(
      "SELECT * FROM public.marketplace_community_orders WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2",
      [protocol, orderHash.toLowerCase()],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].hidden)
        throw new RequestSecurityError(
          403,
          "This listing was removed from the community marketplace.",
        );
      const decoded = decodeRow(existing.rows[0]);
      await client.query("COMMIT");
      return offerFor(existing.rows[0], decoded.listing, decoded.feePolicy);
    }
    const count = await client.query<{ count: string }>(
      "SELECT count(*) FROM public.marketplace_community_orders WHERE seller = $1 AND status IN ('active', 'invalid-owner', 'unapproved') AND expires_at > $2",
      [seller, Math.floor(Date.now() / 1000)],
    );
    if (Number(count.rows[0]?.count ?? 0) >= 25)
      throw new RequestSecurityError(429, "Active community listing limit reached.");
    const inserted = await client.query<Row>(
      `INSERT INTO public.marketplace_community_orders
      (chain_id, protocol_address, order_hash, collection_address, token_id, seller, price_wei, expires_at, signed_order, fee_policy, metadata, eligibility_balance)
      VALUES (8453, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11) RETURNING *`,
      [
        protocol,
        orderHash.toLowerCase(),
        collection.toLowerCase(),
        listing.parameters.offer[0].identifierOrCriteria,
        seller,
        getListingPriceWei(listing).toString(),
        listing.parameters.endTime,
        JSON.stringify(listing),
        JSON.stringify(currentFee),
        JSON.stringify(metadata),
        eligibility.balance,
      ],
    );
    await client.query("COMMIT");
    return offerFor(inserted.rows[0], listing, currentFee);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getCommunityOrder(orderHash: string) {
  await requireReady();
  const result = await database().query<Row>(
    "SELECT * FROM public.marketplace_community_orders WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2",
    [getMarketplaceProtocolAddress("gnars-contract").toLowerCase(), orderHash.toLowerCase()],
  );
  const row = result.rows[0];
  if (!row) throw new RequestSecurityError(404, "Community listing was not found.");
  return { ...decodeRow(row), row };
}

export async function reconcileCommunityOrder(orderHash: string) {
  const { listing, options } = await getCommunityOrder(orderHash);
  const status = await getListingStatus(marketplaceClient, listing, options);
  await database().query(
    "UPDATE public.marketplace_community_orders SET status = $3, checked_at = NOW() WHERE protocol_address = $1 AND order_hash = $2 AND chain_id = 8453",
    [
      getMarketplaceProtocolAddress("gnars-contract").toLowerCase(),
      orderHash.toLowerCase(),
      status,
    ],
  );
  return { status };
}

export const communityFulfillmentSchema = z
  .object({
    source: z.literal("gnars-contract"),
    orderHash: marketplaceHashSchema,
    collectionAddress: marketplaceAddressSchema,
    tokenId: marketplaceUintSchema,
    buyer: marketplaceAddressSchema,
    expectedPriceWei: marketplaceUintSchema,
  })
  .strict();
export async function prepareCommunityFulfillment(
  input: z.infer<typeof communityFulfillmentSchema>,
): Promise<MarketplaceFulfillment & { feePolicy: CommunityFeePolicy }> {
  const { row, listing, options, feePolicy } = await getCommunityOrder(input.orderHash);
  if (row.hidden)
    throw new RequestSecurityError(403, "This listing was removed from the community marketplace.");
  const offer = offerFor(row, listing, feePolicy);
  if (
    !isAddressEqual(input.collectionAddress as Address, row.collection_address) ||
    input.tokenId !== row.token_id ||
    input.expectedPriceWei !== offer.priceWei
  )
    throw new MarketplaceServiceError(
      409,
      "The community listing changed. Refresh before purchasing.",
      "ORDER_CHANGED",
      false,
    );
  if (isAddressEqual(input.buyer as Address, offer.seller))
    throw new RequestSecurityError(409, "You already own this NFT.");
  await validateListingOnchain(marketplaceClient, listing, options);
  const transaction = getListingFulfillment(listing, options);
  await marketplaceClient
    .call({ account: input.buyer as Address, ...transaction })
    .catch((error: unknown) => {
      throw marketplaceSimulationError(error);
    });
  // Moderation can change while RPC validation runs. Recheck before returning executable data.
  const current = await getCommunityOrder(input.orderHash);
  if (current.row.hidden)
    throw new RequestSecurityError(403, "This listing was removed from the community marketplace.");
  return {
    offer,
    feePolicy,
    transaction: { ...transaction, chainId: 8453, value: transaction.value.toString() },
  };
}

async function itemsFromRows(
  rows: Row[],
  includeHidden = false,
): Promise<{ items: MarketplaceItem[]; available: boolean }> {
  const items = new Map<string, MarketplaceItem>();
  let available = true;
  const stale: Array<{ row: Row; decoded: ReturnType<typeof decodeRow> }> = [];
  const add = (row: Row, decoded: ReturnType<typeof decodeRow>) => {
    const metadata = storedMetadata.parse(row.metadata);
    const identity = `${decoded.collection.toLowerCase()}:${row.token_id}`;
    const item = items.get(identity) ?? {
      ...metadata,
      image: safeImage(metadata.image),
      collectionAddress: decoded.collection,
      tokenId: row.token_id,
      owner: decoded.listing.parameters.offerer,
      offers: [],
    };
    item.offers.push(offerFor(row, decoded.listing, decoded.feePolicy));
    items.set(identity, item);
  };
  for (const row of rows) {
    try {
      if (row.hidden && !includeHidden) continue;
      const decoded = decodeRow(row);
      if (includeHidden) {
        add(row, decoded);
        continue;
      }
      if (BigInt(decoded.listing.parameters.endTime) <= BigInt(Math.floor(Date.now() / 1000)))
        continue;
      const checked = row.checked_at ? new Date(row.checked_at).getTime() : 0;
      if (checked > Date.now() || Date.now() - checked >= 15_000) {
        stale.push({ row, decoded });
      } else if (row.status === "active") add(row, decoded);
    } catch {
      available = false;
    }
  }
  if (stale.length) {
    const [chainId, block] = await Promise.all([
      marketplaceClient.getChainId(),
      marketplaceClient.getBlock(),
    ]);
    if (chainId !== 8453) throw marketplaceUnavailable("Marketplace RPC is not on Base.");
    const protocol = getMarketplaceProtocolAddress("gnars-contract");
    const updates: Array<{ hash: Hex; status: string }> = [];
    for (let offset = 0; offset < stale.length; offset += 24) {
      const batch = stale.slice(offset, offset + 24);
      const reads = await marketplaceClient
        .multicall({
          allowFailure: true,
          blockNumber: block.number,
          contracts: batch.flatMap(({ row, decoded }) => [
            {
              address: protocol,
              abi: seaportAbi,
              functionName: "getOrderStatus",
              args: [row.order_hash],
            },
            {
              address: protocol,
              abi: seaportAbi,
              functionName: "getCounter",
              args: [decoded.listing.parameters.offerer],
            },
            {
              address: decoded.collection,
              abi: erc721Abi,
              functionName: "ownerOf",
              args: [BigInt(row.token_id)],
            },
            {
              address: decoded.collection,
              abi: erc721Abi,
              functionName: "getApproved",
              args: [BigInt(row.token_id)],
            },
            {
              address: decoded.collection,
              abi: erc721Abi,
              functionName: "isApprovedForAll",
              args: [decoded.listing.parameters.offerer, protocol],
            },
          ]),
        })
        .catch(() => null);
      if (!reads) {
        available = false;
        continue;
      }
      for (const [index, { row, decoded }] of batch.entries()) {
        const result = reads.slice(index * 5, index * 5 + 5);
        if (result.length !== 5 || result.some((value) => value.status !== "success")) {
          available = false;
          continue;
        }
        try {
          const [order, counter, owner, approved, all] = result.map((value) => value.result) as [
            readonly [boolean, boolean, bigint, bigint],
            bigint,
            Address,
            Address,
            boolean,
          ];
          const p = decoded.listing.parameters;
          const status = order[1]
            ? "cancelled"
            : order[2] > 0n
              ? "filled"
              : BigInt(p.endTime) <= block.timestamp
                ? "expired"
                : counter !== BigInt(p.counter)
                  ? "invalid-counter"
                  : !isAddressEqual(owner, p.offerer)
                    ? "invalid-owner"
                    : !isAddressEqual(approved, protocol) && !all
                      ? "unapproved"
                      : "active";
          if (BigInt(p.startTime) > block.timestamp) {
            available = false;
            continue;
          }
          updates.push({ hash: row.order_hash, status });
          if (status === "active") add(row, decoded);
        } catch {
          available = false;
        }
      }
    }
    if (updates.length)
      await database()
        .query(
          `UPDATE public.marketplace_community_orders AS orders SET status = checked.status, checked_at = NOW()
      FROM UNNEST($1::text[], $2::text[]) AS checked(order_hash, status)
      WHERE orders.chain_id = 8453 AND orders.protocol_address = $3 AND orders.order_hash = checked.order_hash`,
          [
            updates.map((value) => value.hash),
            updates.map((value) => value.status),
            protocol.toLowerCase(),
          ],
        )
        .catch(() => {
          available = false;
        });
  }
  return { items: [...items.values()], available };
}

export async function listCommunityMarketplace(
  cursor?: string,
  owner?: Address,
): Promise<CommunityMarketplacePage> {
  if (!(await communityMarketplaceReady()))
    return { items: [], nextCursor: null, available: false };
  const values: (string | number)[] = [
    getMarketplaceProtocolAddress("gnars-contract").toLowerCase(),
    Math.floor(Date.now() / 1000),
  ];
  let filter = "";
  if (cursor) {
    values.push(cursor);
    filter += ` AND id < $${values.length}`;
  }
  if (owner) {
    values.push(owner.toLowerCase());
    filter += ` AND seller = $${values.length}`;
  }
  const result = await database().query<Row>(
    `SELECT * FROM public.marketplace_community_orders WHERE chain_id = 8453 AND protocol_address = $1 AND expires_at > $2 AND NOT hidden AND status IN ('active', 'invalid-owner', 'unapproved')${filter} ORDER BY id DESC LIMIT ${MARKETPLACE_PAGE_SIZE}`,
    values,
  );
  return {
    ...(await itemsFromRows(result.rows)),
    nextCursor: result.rows.length === MARKETPLACE_PAGE_SIZE ? result.rows.at(-1)!.id : null,
  };
}

export async function getCommunityToken(
  rawCollection: string,
  tokenId: string,
): Promise<MarketplacePage> {
  const collection = collectionAddress(rawCollection);
  await checkCollection(collection);
  const [metadata, owner, ready] = await Promise.all([
    nftMetadata(collection, tokenId),
    marketplaceClient.readContract({
      address: collection,
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
    }),
    communityMarketplaceReady(),
  ]);
  let offers: MarketplaceOffer[] = [];
  let available = ready;
  if (ready) {
    const rows = await database().query<Row>(
      "SELECT * FROM public.marketplace_community_orders WHERE chain_id = 8453 AND protocol_address = $1 AND collection_address = $2 AND token_id = $3 AND NOT hidden AND expires_at > $4 AND status IN ('active', 'invalid-owner', 'unapproved') ORDER BY price_wei, id DESC LIMIT 25",
      [
        getMarketplaceProtocolAddress("gnars-contract").toLowerCase(),
        collection.toLowerCase(),
        tokenId,
        Math.floor(Date.now() / 1000),
      ],
    );
    const result = await itemsFromRows(rows.rows);
    available = result.available;
    offers = result.items
      .flatMap((item) => item.offers)
      .filter((offer) => isAddressEqual(offer.seller, owner));
  }
  return {
    items: [{ ...metadata, collectionAddress: collection, tokenId, owner, offers }],
    ownershipVerified: true,
    nextCursor: null,
    sources: {
      catalogue: { available: true },
      opensea: { available: false, error: "not_configured" },
      gnars: { available: false, error: "not_configured" },
      "gnars-contract": { available, ...(!available ? { error: "unavailable" as const } : {}) },
    },
    capabilities: {
      openseaBuy: false,
      openseaSell: false,
      openseaCancel: false,
      localTrading: false,
      customTrading: ready && available,
    },
  };
}

export const communityModerationSchema = z
  .object({
    orderHash: marketplaceHashSchema,
    action: z.enum(["hide", "restore"]),
    expectedRevision: z.number().int().min(0).max(2147483646),
    reason: z.string().max(500),
    builderCode: z.literal(BUILDER_CODE),
    protocolAddress: marketplaceAddressSchema,
    authorization: z.unknown(),
  })
  .strict();
export async function listCommunityModeration(
  authorization: unknown,
  cursor?: string,
): Promise<CommunityMarketplacePage> {
  const actor = await verifyWalletAuthorization({
    authorization,
    method: "GET",
    path: "/api/marketplace/community/moderation",
    payload: {
      cursor: cursor ?? null,
      builderCode: BUILDER_CODE,
      protocolAddress: getMarketplaceProtocolAddress("gnars-contract"),
    },
  });
  if (!isCommunityModerator(actor))
    throw new RequestSecurityError(403, "This wallet is not a community marketplace moderator.");
  await requireReady();
  const rows = await database().query<Row>(
    `SELECT * FROM public.marketplace_community_orders WHERE chain_id = 8453 AND protocol_address = $1 AND hidden${cursor ? " AND id < $2" : ""} ORDER BY id DESC LIMIT ${MARKETPLACE_PAGE_SIZE}`,
    [getMarketplaceProtocolAddress("gnars-contract").toLowerCase(), ...(cursor ? [cursor] : [])],
  );
  return {
    ...(await itemsFromRows(rows.rows, true)),
    nextCursor: rows.rows.length === MARKETPLACE_PAGE_SIZE ? rows.rows.at(-1)!.id : null,
  };
}

export async function listCommunityManagedOrders(
  authorization: unknown,
  cursor?: string,
): Promise<CommunityMarketplacePage> {
  const protocol = getMarketplaceProtocolAddress("gnars-contract");
  const actor = await verifyWalletAuthorization({
    authorization,
    method: "GET",
    path: "/api/marketplace/community/manage",
    payload: { cursor: cursor ?? null, builderCode: BUILDER_CODE, protocolAddress: protocol },
  });
  await requireReady();
  const rows = await database().query<Row>(
    `SELECT * FROM public.marketplace_community_orders
    WHERE chain_id = 8453 AND protocol_address = $1 AND seller = $2 AND expires_at > $3
    AND status IN ('active', 'unapproved', 'invalid-owner')${cursor ? " AND id < $4" : ""}
    ORDER BY id DESC LIMIT ${MARKETPLACE_PAGE_SIZE}`,
    [
      protocol.toLowerCase(),
      actor.toLowerCase(),
      Math.floor(Date.now() / 1000),
      ...(cursor ? [cursor] : []),
    ],
  );
  // Keep cancellation access private even if a later query change widens the result set.
  const ownRows = rows.rows.filter((row) => isAddressEqual(row.seller, actor));
  const result = await itemsFromRows(ownRows, true);
  return {
    ...result,
    available: result.available && ownRows.length === rows.rows.length,
    nextCursor: rows.rows.length === MARKETPLACE_PAGE_SIZE ? rows.rows.at(-1)!.id : null,
  };
}

export async function moderateCommunityOrder(input: z.infer<typeof communityModerationSchema>) {
  if (
    !isAddressEqual(
      input.protocolAddress as Address,
      getMarketplaceProtocolAddress("gnars-contract"),
    )
  )
    throw new RequestSecurityError(409, "Marketplace protocol changed. Refresh before moderating.");
  const payload = {
    orderHash: input.orderHash,
    action: input.action,
    expectedRevision: input.expectedRevision,
    reason: input.reason,
    builderCode: input.builderCode,
    protocolAddress: input.protocolAddress,
  };
  const actor = await verifyWalletAuthorization({
    authorization: input.authorization,
    method: "POST",
    path: "/api/marketplace/community/moderation",
    payload,
  });
  if (!isCommunityModerator(actor))
    throw new RequestSecurityError(403, "This wallet is not a community marketplace moderator.");
  const authorization = z
    .object({ nonce: z.string().uuid() })
    .passthrough()
    .parse(input.authorization);
  await requireReady();
  const protocol = getMarketplaceProtocolAddress("gnars-contract").toLowerCase();
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<Row>(
      "SELECT * FROM public.marketplace_community_orders WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2 FOR UPDATE",
      [protocol, input.orderHash.toLowerCase()],
    );
    const row = selected.rows[0];
    if (!row) throw new RequestSecurityError(404, "Community listing was not found.");
    if (row.moderation_revision !== input.expectedRevision)
      throw new RequestSecurityError(409, "Moderation state changed. Refresh before retrying.");
    const audit = await client.query(
      `INSERT INTO public.marketplace_community_moderation (nonce, actor, protocol_address, order_hash, action, expected_revision, reason, wallet_authorization)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT (nonce) DO NOTHING RETURNING nonce`,
      [
        authorization.nonce,
        actor.toLowerCase(),
        protocol,
        input.orderHash.toLowerCase(),
        input.action,
        input.expectedRevision,
        input.reason,
        JSON.stringify(input.authorization),
      ],
    );
    if (audit.rowCount !== 1)
      throw new RequestSecurityError(409, "This moderation authorization was already used.");
    const hidden = input.action === "hide";
    await client.query(
      "UPDATE public.marketplace_community_orders SET hidden = $3, moderation_revision = moderation_revision + 1, moderated_by = $4, moderation_reason = $5, moderated_at = NOW() WHERE chain_id = 8453 AND protocol_address = $1 AND order_hash = $2",
      [protocol, input.orderHash.toLowerCase(), hidden, actor.toLowerCase(), input.reason],
    );
    await client.query("COMMIT");
    return { hidden, revision: input.expectedRevision + 1 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
