import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  erc721Abi,
  hashStruct,
  hashTypedData,
  isAddressEqual,
  parseAbi,
  recoverTypedDataAddress,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { entryPoint06Abi } from "viem/account-abstraction";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";

export const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395" as const;
type SignatureAttempt = {
  id: string;
  kind: string;
  phase: string;
  transactionIntent?: unknown;
  txHash?: Hex;
  listing?: unknown;
};
export function canAbandonMarketplaceSignature(attempt: SignatureAttempt | null): boolean {
  return Boolean(
    attempt &&
      attempt.kind === "list" &&
      attempt.phase === "unknown" &&
      !attempt.transactionIntent &&
      !attempt.txHash &&
      !attempt.listing,
  );
}
export function canAcceptMarketplaceSignature(
  current: SignatureAttempt | null,
  attemptId: string,
): boolean {
  return Boolean(current?.id === attemptId && canAbandonMarketplaceSignature(current));
}
export function canReplaceMarketplaceAttempt(attempt: {
  phase: string;
  kind?: string;
  txHash?: Hex;
  transactionFailed?: boolean;
  listing?: unknown;
}): boolean {
  return (
    attempt.phase === "complete" ||
    (attempt.phase === "failed" &&
      (!attempt.listing || attempt.kind === "buy") &&
      (!attempt.txHash || attempt.transactionFailed === true))
  );
}
export type SeaportClient = Pick<PublicClient, "readContract" | "getChainId" | "getCode"> & {
  getBlock(): Promise<{ timestamp: bigint }>;
};
export type MarketplaceTransactionIntent = {
  account: Address;
  to: Address;
  data: Hex;
  value: string;
  startedBlock: string;
};
export function verifyMarketplaceTransaction(
  intent: MarketplaceTransactionIntent,
  tx: {
    chainId?: number;
    from: Address;
    to: Address | null;
    input: Hex;
    value: bigint;
    blockNumber: bigint | null;
  },
  receipt?: {
    status: "success" | "reverted";
    logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
  },
): boolean {
  if (
    tx.chainId !== 8453 ||
    (tx.blockNumber !== null && tx.blockNumber <= BigInt(intent.startedBlock))
  )
    throw new Error("Transaction does not belong to this Base attempt");
  let to = tx.to,
    data = tx.input,
    value = tx.value;
  let operationSucceeded = true;
  if (!isAddressEqual(tx.from, intent.account)) {
    // Matches the application's pinned thirdweb EntryPoint 0.6 deployment.
    const entrypoint = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as const;
    if (!to || !isAddressEqual(to, entrypoint))
      throw new Error("Transaction signer does not match this account");
    const decoded = decodeFunctionData({ abi: entryPoint06Abi, data });
    if (decoded.functionName !== "handleOps")
      throw new Error("Unsupported smart-account transaction");
    const operations = decoded.args[0].filter((op) => isAddressEqual(op.sender, intent.account));
    if (operations.length !== 1) throw new Error("Ambiguous smart-account transaction");
    const op = operations[0],
      call = decodeFunctionData({
        abi: parseAbi(["function execute(address target,uint256 value,bytes data)"]),
        data: op.callData,
      });
    [to, value, data] = call.args;
    if (receipt && receipt.status !== "reverted") {
      const outcomes = receipt.logs.flatMap((log) => {
        if (!isAddressEqual(log.address, entrypoint)) return [];
        try {
          const event = decodeEventLog({
            abi: entryPoint06Abi,
            eventName: "UserOperationEvent",
            ...log,
            topics: [...log.topics] as [Hex, ...Hex[]],
          });
          return isAddressEqual(event.args.sender, intent.account) && event.args.nonce === op.nonce
            ? [event.args.success]
            : [];
        } catch {
          return [];
        }
      });
      if (outcomes.length !== 1) throw new Error("Smart-account execution result unavailable");
      operationSucceeded = outcomes[0];
    }
  }
  if (
    !to ||
    !isAddressEqual(to, intent.to) ||
    value !== BigInt(intent.value) ||
    !data.toLowerCase().startsWith(intent.data.toLowerCase())
  )
    throw new Error("Transaction calldata does not match this attempt");
  return operationSucceeded && receipt?.status !== "reverted";
}
// Canonical Seaport 1.6 types and ABI, ProjectOpenSea/seaport-types and seaport-js.
export const orderTypes = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
} as const;
export const seaportAbi = parseAbi([
  "struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }",
  "struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }",
  "struct OrderComponents { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 counter; }",
  "struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }",
  "struct Order { OrderParameters parameters; bytes signature; }",
  "function getCounter(address offerer) view returns(uint256 counter)",
  "function getOrderHash(OrderComponents order) view returns(bytes32 orderHash)",
  "function getOrderStatus(bytes32 orderHash) view returns(bool isValidated,bool isCancelled,uint256 totalFilled,uint256 totalSize)",
  "function fulfillOrder(Order order,bytes32 fulfillerConduitKey) payable returns(bool fulfilled)",
  "function cancel(OrderComponents[] orders) returns(bool cancelled)",
]);
const address = z
  .string()
  .regex(/^0x[\da-fA-F]{40}$/)
  .transform((v) => v as Address);
const bytes32 = z
  .string()
  .regex(/^0x[\da-fA-F]{64}$/)
  .transform((v) => v as Hex);
const uint = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(78)
  .refine((v) => BigInt(v) < 2n ** 256n);
const item = z
  .object({
    itemType: z.number().int(),
    token: address,
    identifierOrCriteria: uint,
    startAmount: uint,
    endAmount: uint,
  })
  .strict();
export const listingSchema = z
  .object({
    parameters: z
      .object({
        offerer: address,
        zone: address,
        offer: z.array(item).length(1),
        consideration: z
          .array(item.extend({ recipient: address }))
          .min(1)
          .max(2),
        orderType: z.literal(0),
        startTime: uint,
        endTime: uint,
        zoneHash: bytes32,
        salt: uint,
        conduitKey: bytes32,
        counter: uint,
      })
      .strict(),
    signature: z
      .string()
      .regex(/^0x(?:[\da-fA-F]{2})+$/)
      .max(8194)
      .transform((v) => v as Hex),
  })
  .strict();
export type SignedListing = z.infer<typeof listingSchema>;
export type OrderComponents = SignedListing["parameters"];
export type ListingSourceOptions = { source?: "gnars" | "opensea" };
const openSeaListingSchema = listingSchema.extend({
  parameters: listingSchema.shape.parameters.extend({
    consideration: z
      .array(item.extend({ recipient: address }))
      .min(1)
      .max(10),
  }),
});
export type ListingStatus =
  | "active"
  | "cancelled"
  | "filled"
  | "expired"
  | "invalid-owner"
  | "unapproved"
  | "invalid-counter";

export function validateListingStructure(
  raw: unknown,
  options: ListingSourceOptions & { now?: number; allowExpired?: boolean } = {},
): SignedListing {
  const listing = (options.source === "opensea" ? openSeaListingSchema : listingSchema).parse(raw),
    p = listing.parameters,
    nft = p.offer[0];
  if (
    !isAddressEqual(p.zone, zeroAddress) ||
    p.zoneHash !== zeroHash ||
    p.conduitKey !== zeroHash ||
    isAddressEqual(p.offerer, zeroAddress)
  )
    throw new Error("Unsupported Seaport routing");
  if (
    nft.itemType !== 2 ||
    !isAddressEqual(nft.token, DAO_ADDRESSES.token) ||
    nft.startAmount !== "1" ||
    nft.endAmount !== "1"
  )
    throw new Error("Only a single Gnars ERC721 is supported");
  if (!isAddressEqual(p.consideration[0].recipient, p.offerer))
    throw new Error("Seller proceeds must go to the offerer");
  for (const c of p.consideration)
    if (
      c.itemType !== 0 ||
      !isAddressEqual(c.token, zeroAddress) ||
      c.identifierOrCriteria !== "0" ||
      c.startAmount !== c.endAmount ||
      BigInt(c.startAmount) <= 0n ||
      isAddressEqual(c.recipient, zeroAddress)
    )
      throw new Error("Only fixed native ETH consideration is supported");
  const start = BigInt(p.startTime),
    end = BigInt(p.endTime),
    now = BigInt(options.now ?? Math.floor(Date.now() / 1000));
  if (end <= start || end - start > 31n * 86400n || start > now + 60n)
    throw new Error("Invalid listing time range");
  if (!options.allowExpired && end <= now) throw new Error("Listing expired");
  return listing;
}
export function getListingPriceWei(listing: SignedListing): bigint {
  const total = listing.parameters.consideration.reduce(
    (sum, item) => sum + BigInt(item.startAmount),
    0n,
  );
  if (total >= 2n ** 256n) throw new Error("Listing price exceeds uint256");
  return total;
}
export function orderValues(p: OrderComponents) {
  const mapItem = (i: OrderComponents["offer"][number]) => ({
    ...i,
    identifierOrCriteria: BigInt(i.identifierOrCriteria),
    startAmount: BigInt(i.startAmount),
    endAmount: BigInt(i.endAmount),
  });
  return {
    ...p,
    offer: p.offer.map(mapItem),
    consideration: p.consideration.map((i) => ({ ...mapItem(i), recipient: i.recipient })),
    startTime: BigInt(p.startTime),
    endTime: BigInt(p.endTime),
    salt: BigInt(p.salt),
    counter: BigInt(p.counter),
  };
}
export function getListingTypedData(parameters: OrderComponents) {
  return {
    domain: { name: "Seaport", version: "1.6", chainId: 8453, verifyingContract: SEAPORT_ADDRESS },
    types: orderTypes,
    primaryType: "OrderComponents" as const,
    message: orderValues(parameters),
  };
}
export function getListingOrderHash(parameters: OrderComponents): Hex {
  return hashStruct({
    data: orderValues(parameters),
    primaryType: "OrderComponents",
    types: orderTypes,
  });
}
const royaltyAbi = parseAbi([
  "function royaltyInfo(uint256 tokenId,uint256 salePrice) view returns(address receiver,uint256 royaltyAmount)",
]);
export async function getListingRoyalty(client: SeaportClient, tokenId: bigint, price: bigint) {
  const supported = await client.readContract({
    address: DAO_ADDRESSES.token,
    abi: parseAbi(["function supportsInterface(bytes4 interfaceId) view returns(bool)"]),
    functionName: "supportsInterface",
    args: ["0x2a55205a"],
  });
  if (!supported) return { recipient: zeroAddress as Address, amount: 0n };
  const [recipient, amount] = await client.readContract({
    address: DAO_ADDRESSES.token,
    abi: royaltyAbi,
    functionName: "royaltyInfo",
    args: [tokenId, price],
  });
  if (amount >= price || (amount > 0n && isAddressEqual(recipient, zeroAddress)))
    throw new Error("Invalid collection royalty");
  return { recipient, amount };
}
export async function getListingStatus(
  client: SeaportClient,
  listing: SignedListing,
  options: ListingSourceOptions = {},
): Promise<ListingStatus> {
  validateListingStructure(listing, { ...options, allowExpired: true });
  if ((await client.getChainId()) !== 8453) throw new Error("Base chain required");
  const p = listing.parameters,
    hash = getListingOrderHash(p);
  const [, cancelled, filled] = await client.readContract({
    address: SEAPORT_ADDRESS,
    abi: seaportAbi,
    functionName: "getOrderStatus",
    args: [hash],
  });
  if (cancelled) return "cancelled";
  if (filled > 0n) return "filled";
  const block = await client.getBlock();
  if (BigInt(p.endTime) <= block.timestamp) return "expired";
  if (BigInt(p.startTime) > block.timestamp) throw new Error("Listing has not started");
  const counter = await client.readContract({
    address: SEAPORT_ADDRESS,
    abi: seaportAbi,
    functionName: "getCounter",
    args: [p.offerer],
  });
  if (counter !== BigInt(p.counter)) return "invalid-counter";
  const tokenId = BigInt(p.offer[0].identifierOrCriteria);
  const owner = await client.readContract({
    address: DAO_ADDRESSES.token,
    abi: erc721Abi,
    functionName: "ownerOf",
    args: [tokenId],
  });
  if (!isAddressEqual(owner, p.offerer)) return "invalid-owner";
  const approved = await client.readContract({
    address: DAO_ADDRESSES.token,
    abi: erc721Abi,
    functionName: "getApproved",
    args: [tokenId],
  });
  if (
    !isAddressEqual(approved, SEAPORT_ADDRESS) &&
    !(await client.readContract({
      address: DAO_ADDRESSES.token,
      abi: erc721Abi,
      functionName: "isApprovedForAll",
      args: [p.offerer, SEAPORT_ADDRESS],
    }))
  )
    return "unapproved";
  return "active";
}
export async function validateListingOnchain(
  client: SeaportClient,
  raw: SignedListing,
  options: ListingSourceOptions & { requireApproval?: boolean } = {},
) {
  const listing = validateListingStructure(raw, options),
    p = listing.parameters;
  const status = await getListingStatus(client, listing, options);
  if (status !== "active" && !(status === "unapproved" && options.requireApproval === false))
    throw new Error(`Listing is ${status}`);
  const orderHash = getListingOrderHash(p);
  const chainHash = await client.readContract({
    address: SEAPORT_ADDRESS,
    abi: seaportAbi,
    functionName: "getOrderHash",
    args: [orderValues(p)],
  });
  if (chainHash !== orderHash) throw new Error("Seaport order hash mismatch");
  const code = await client.getCode({ address: p.offerer });
  const typed = getListingTypedData(p);
  if (code && code !== "0x") {
    const magic = await client.readContract({
      address: p.offerer,
      abi: parseAbi([
        "function isValidSignature(bytes32 hash,bytes signature) view returns(bytes4)",
      ]),
      functionName: "isValidSignature",
      args: [hashTypedData(typed), listing.signature],
    });
    if (magic !== "0x1626ba7e")
      throw new Error("Smart account does not support this Seaport signature");
  } else if (
    !isAddressEqual(
      await recoverTypedDataAddress({ ...typed, signature: listing.signature }),
      p.offerer,
    )
  )
    throw new Error("Invalid owner signature");
  // OpenSea fees are checked against a fresh collection quote at publication.
  if (options.source === "opensea") return { orderHash };
  const royalty = await getListingRoyalty(
    client,
    BigInt(p.offer[0].identifierOrCriteria),
    getListingPriceWei(listing),
  );
  if (
    royalty.amount === 0n
      ? p.consideration.length !== 1
      : p.consideration.length !== 2 ||
        !isAddressEqual(p.consideration[1].recipient, royalty.recipient) ||
        BigInt(p.consideration[1].startAmount) !== royalty.amount
  )
    throw new Error("Listing does not match the collection royalty");
  return { orderHash };
}
export function getListingFulfillment(listing: SignedListing, options: ListingSourceOptions = {}) {
  validateListingStructure(listing, options);
  const p = orderValues(listing.parameters);
  return {
    to: SEAPORT_ADDRESS,
    data: encodeFunctionData({
      abi: seaportAbi,
      functionName: "fulfillOrder",
      args: [
        {
          parameters: { ...p, totalOriginalConsiderationItems: BigInt(p.consideration.length) },
          signature: listing.signature,
        },
        zeroHash,
      ],
    }),
    value: getListingPriceWei(listing),
  };
}
export function getListingCancellation(listing: SignedListing, options: ListingSourceOptions = {}) {
  validateListingStructure(listing, { ...options, allowExpired: true });
  return {
    to: SEAPORT_ADDRESS,
    data: encodeFunctionData({
      abi: seaportAbi,
      functionName: "cancel",
      args: [[orderValues(listing.parameters)]],
    }),
    value: 0n,
  };
}
