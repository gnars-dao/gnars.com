import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  hashTypedData,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Address,
} from "viem";
import { entryPoint06Abi } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { COMMUNITY_FEE_RECIPIENT } from "./community-policy";
import { OPENSEA_CONDUIT_ADDRESS, OPENSEA_CONDUIT_KEY } from "./routing";
import {
  canAbandonMarketplaceSignature,
  canAcceptMarketplaceSignature,
  canReplaceMarketplaceAttempt,
  getListingCancellation,
  getListingFulfillment,
  getListingOrderHash,
  getListingPriceWei,
  getListingStatus,
  getListingTypedData,
  SEAPORT_ADDRESS,
  seaportAbi,
  validateListingOnchain,
  validateListingStructure,
  verifyMarketplaceTransaction,
  type SeaportClient,
  type SignedListing,
} from "./seaport";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const royaltyRecipient = "0x2222222222222222222222222222222222222222" as Address;
const now = Math.floor(Date.now() / 1000);
afterEach(() => vi.unstubAllEnvs());
function listing(): SignedListing {
  return {
    parameters: {
      offerer: account.address,
      zone: zeroAddress,
      offer: [
        {
          itemType: 2,
          token: DAO_ADDRESSES.token,
          identifierOrCriteria: "42",
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "1000000000000000000",
          endAmount: "1000000000000000000",
          recipient: account.address,
        },
      ],
      orderType: 0,
      startTime: String(now - 10),
      endTime: String(now + 86400),
      zoneHash: zeroHash,
      salt: "42",
      conduitKey: zeroHash,
      counter: "0",
    },
    signature: "0x11",
  };
}
function client(order: SignedListing, overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    getOrderStatus: [false, false, 0n, 0n],
    getCounter: 0n,
    ownerOf: account.address,
    getApproved: SEAPORT_ADDRESS,
    isApprovedForAll: false,
    getOrderHash: getListingOrderHash(order.parameters),
    supportsInterface: false,
    ...overrides,
  };
  return {
    getChainId: vi.fn(async () => 8453),
    getBlock: vi.fn(async () => ({ timestamp: BigInt(now) })),
    getCode: vi.fn(async () => undefined),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      const value = values[functionName];
      if (value instanceof Error) throw value;
      return value;
    }),
  } as unknown as SeaportClient;
}

describe("community ERC721 Seaport orders", () => {
  const custom = "0x3333333333333333333333333333333333333333" as Address;
  const collection = "0x4444444444444444444444444444444444444444" as Address;
  const feePolicy = { basisPoints: 250, recipient: COMMUNITY_FEE_RECIPIENT };
  const options = { source: "gnars-contract" as const, collectionAddress: collection, feePolicy };
  function communityOrder() {
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", custom);
    const order = listing();
    order.parameters.offer[0].token = collection;
    const payment = order.parameters.consideration[0];
    order.parameters.consideration = [
      { ...payment, startAmount: "925000000000000000", endAmount: "925000000000000000" },
      {
        ...payment,
        recipient: COMMUNITY_FEE_RECIPIENT,
        startAmount: "25000000000000000",
        endAmount: "25000000000000000",
      },
      {
        ...payment,
        recipient: royaltyRecipient,
        startAmount: "50000000000000000",
        endAmount: "50000000000000000",
      },
    ];
    return order;
  }
  it("requires explicit collection and fee policy; legacy routes stay DAO-only", () => {
    const order = communityOrder();
    expect(validateListingStructure(order, options)).toEqual(order);
    expect(() => validateListingStructure(order, { source: "gnars-contract" })).toThrow();
    expect(() => validateListingStructure(order, { ...options, feePolicy: undefined })).toThrow();
    expect(() => validateListingStructure(order, { ...options, source: "gnars" })).toThrow();
    expect(() =>
      validateListingStructure(order, { ...options, collectionAddress: royaltyRecipient }),
    ).toThrow();
    order.parameters.offer[0].itemType = 3;
    expect(() => validateListingStructure(order, options)).toThrow();
  });
  it.each(["recipient", "amount", "rate", "extra"])("rejects altered community %s", (field) => {
    const order = communityOrder();
    if (field === "recipient") order.parameters.consideration[1].recipient = royaltyRecipient;
    if (field === "amount")
      order.parameters.consideration[1].startAmount = order.parameters.consideration[1].endAmount =
        "1";
    if (field === "extra")
      order.parameters.consideration.push({ ...order.parameters.consideration[1] });
    expect(() =>
      validateListingStructure(
        order,
        field === "rate" ? { ...options, feePolicy: { ...feePolicy, basisPoints: 500 } } : options,
      ),
    ).toThrow();
  });
  it("checks ownership, royalty, approval and signature against the selected collection and custom domain", async () => {
    const order = communityOrder();
    order.signature = await account.signTypedData(getListingTypedData(order.parameters, options));
    const reader = client(order, {
      getApproved: custom,
      supportsInterface: true,
      royaltyInfo: [royaltyRecipient, 50000000000000000n],
    });
    await expect(validateListingOnchain(reader, order, options)).resolves.toEqual({
      orderHash: getListingOrderHash(order.parameters),
    });
    for (const [call] of vi.mocked(reader.readContract).mock.calls) {
      if (
        ["ownerOf", "getApproved", "supportsInterface", "royaltyInfo"].includes(call.functionName)
      )
        expect(call.address).toBe(collection);
    }
    expect(getListingFulfillment(order, options).to).toBe(custom);
    const decoded = decodeFunctionData({
      abi: seaportAbi,
      data: getListingCancellation(order, options).data,
    });
    expect(decoded.functionName).toBe("cancel");
    if (decoded.functionName === "cancel")
      expect(decoded.args[0][0].offer[0].token.toLowerCase()).toBe(collection);
    await expect(
      validateListingOnchain(
        client(order, { getApproved: custom, supportsInterface: false }),
        order,
        options,
      ),
    ).rejects.toThrow("ERC721");
    await expect(
      validateListingOnchain(
        client(order, {
          getApproved: custom,
          supportsInterface: true,
          royaltyInfo: [royaltyRecipient, 0n],
        }),
        order,
        options,
      ),
    ).rejects.toThrow("royalty");
  });
  it("cancels with the signed policy snapshot even after fee configuration changes", () => {
    const order = communityOrder();
    vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", "500");
    expect(getListingCancellation(order, options).to).toBe(custom);
    vi.stubEnv("MARKETPLACE_COMMUNITY_FEE_BPS", "");
    expect(getListingCancellation(order, options).to).toBe(custom);
  });
});

describe("canonical Gnars Seaport orders", () => {
  it("accepts ECDSA signed orders from delegated EOAs without requiring EIP1271", async () => {
    const order = listing();
    order.signature = await account.signTypedData(getListingTypedData(order.parameters));
    const reader = client(order, {
      isValidSignature: new Error("EOA delegation need not support EIP1271"),
    });
    vi.mocked(reader.getCode).mockResolvedValue(`0xef0100${royaltyRecipient.slice(2)}`);
    await expect(validateListingOnchain(reader, order)).resolves.toEqual({
      orderHash: getListingOrderHash(order.parameters),
    });
    expect(
      vi
        .mocked(reader.readContract)
        .mock.calls.some(([call]) => call.functionName === "isValidSignature"),
    ).toBe(false);
  });
  it("separates custom signature domain, reads, approvals and transaction targets", async () => {
    const custom = "0x3333333333333333333333333333333333333333";
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", custom);
    const order = listing();
    const options = { source: "gnars-contract" as const };
    const typed = getListingTypedData(order.parameters, options);
    expect(typed.domain.verifyingContract).toBe(custom);
    expect(hashTypedData(typed)).not.toBe(hashTypedData(getListingTypedData(order.parameters)));
    order.signature = await account.signTypedData(typed);
    const reader = client(order, { getApproved: custom });
    await expect(validateListingOnchain(reader, order, options)).resolves.toEqual({
      orderHash: getListingOrderHash(order.parameters),
    });
    for (const [call] of vi.mocked(reader.readContract).mock.calls) {
      if (["getOrderStatus", "getCounter", "getOrderHash"].includes(call.functionName))
        expect(call.address).toBe(custom);
    }
    expect(getListingFulfillment(order, options).to).toBe(custom);
    expect(getListingCancellation(order, options).to).toBe(custom);
    expect(getListingCancellation(order).to).toBe(SEAPORT_ADDRESS);
    await expect(getListingStatus(client(order), order, options)).resolves.toBe("unapproved");
    await expect(validateListingOnchain(client(order), order)).rejects.toThrow(
      "Invalid owner signature",
    );
    order.signature = await account.signTypedData(getListingTypedData(order.parameters));
    await expect(
      validateListingOnchain(client(order, { getApproved: custom }), order, options),
    ).rejects.toThrow("Invalid owner signature");
  });
  it("cannot create custom typed data or transactions without the configured deployment", () => {
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", "");
    const options = { source: "gnars-contract" as const };
    expect(() => getListingTypedData(listing().parameters, options)).toThrow("not configured");
    expect(() => getListingFulfillment(listing(), options)).toThrow("not configured");
    expect(() => getListingCancellation(listing(), options)).toThrow("not configured");
  });
  it("passes the custom deployment domain digest to EIP-1271 smart wallets", async () => {
    const custom = "0x3333333333333333333333333333333333333333";
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", custom);
    const order = listing();
    const reader = client(order, { getApproved: custom, isValidSignature: "0x1626ba7e" });
    vi.mocked(reader.getCode).mockResolvedValue("0x1234");
    await validateListingOnchain(reader, order, { source: "gnars-contract" });
    expect(reader.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: account.address,
        functionName: "isValidSignature",
        args: [
          hashTypedData(getListingTypedData(order.parameters, { source: "gnars-contract" })),
          order.signature,
        ],
      }),
    );
  });
  it("allows explicit signature-only discard and rejects late results for discarded ids", () => {
    const attempt = { id: "old", kind: "list", phase: "unknown" };
    expect(canAbandonMarketplaceSignature(attempt)).toBe(true);
    expect(canAcceptMarketplaceSignature(attempt, "old")).toBe(true);
    expect(canAcceptMarketplaceSignature(null, "old")).toBe(false);
    expect(canAcceptMarketplaceSignature({ ...attempt, id: "new" }, "old")).toBe(false);
    expect(canAbandonMarketplaceSignature({ ...attempt, transactionIntent: {} })).toBe(false);
    expect(canAbandonMarketplaceSignature({ ...attempt, txHash: zeroHash })).toBe(false);
    expect(canAbandonMarketplaceSignature({ ...attempt, listing: listing() })).toBe(false);
  });
  it.each(["unknown", "pending", "confirming", "signing", "saving", "approving"])(
    "preserves the durable %s barrier across reload",
    (phase) => {
      const saved = JSON.parse(JSON.stringify({ phase, kind: "list" }));
      expect(canReplaceMarketplaceAttempt(saved)).toBe(false);
    },
  );
  it("does not permit a failed label to bypass an unresolved broadcast", () => {
    expect(canReplaceMarketplaceAttempt({ phase: "failed", txHash: zeroHash })).toBe(false);
    expect(
      canReplaceMarketplaceAttempt({ phase: "failed", txHash: zeroHash, transactionFailed: true }),
    ).toBe(true);
    expect(
      canReplaceMarketplaceAttempt({ phase: "failed", kind: "list", listing: listing() }),
    ).toBe(false);
    expect(canReplaceMarketplaceAttempt({ phase: "complete", listing: listing() })).toBe(true);
    expect(
      canReplaceMarketplaceAttempt({ phase: "failed", kind: "cancel", listing: listing() }),
    ).toBe(false);
    expect(
      canReplaceMarketplaceAttempt({
        phase: "failed",
        kind: "cancel",
        listing: listing(),
        txHash: zeroHash,
        transactionFailed: true,
      }),
    ).toBe(false);
  });
  it.each(["chain", "account", "target", "value", "calldata", "old-block"])(
    "rejects attached transaction with wrong %s",
    (field) => {
      const call = getListingFulfillment(listing());
      const intent = {
        account: account.address,
        ...call,
        value: call.value.toString(),
        startedBlock: "100",
      };
      const tx = {
        chainId: 8453,
        from: account.address,
        to: call.to as Address,
        value: call.value,
        input: call.data,
        blockNumber: 101n,
      };
      if (field === "chain") tx.chainId = 1;
      if (field === "account") tx.from = royaltyRecipient;
      if (field === "target") tx.to = royaltyRecipient;
      if (field === "value") tx.value += 1n;
      if (field === "calldata") tx.input = "0x1234";
      if (field === "old-block") tx.blockNumber = 100n;
      expect(() => verifyMarketplaceTransaction(intent, tx)).toThrow();
    },
  );
  it("accepts a pending identity-matched hash without claiming confirmation", () => {
    const call = getListingFulfillment(listing());
    const intent = {
      account: account.address,
      ...call,
      value: call.value.toString(),
      startedBlock: "100",
    };
    const tx = {
      chainId: 8453,
      from: account.address,
      to: call.to,
      value: call.value,
      input: call.data,
      blockNumber: null,
    };
    expect(verifyMarketplaceTransaction(intent, tx)).toBe(true);
    expect(
      verifyMarketplaceTransaction(
        intent,
        { ...tx, blockNumber: 101n },
        { status: "reverted", logs: [] },
      ),
    ).toBe(false);
  });
  it("requires the account operation result inside an AA bundle and handles outer reverts", () => {
    const call = getListingFulfillment(listing());
    const intent = {
      account: account.address,
      ...call,
      value: call.value.toString(),
      startedBlock: "100",
    };
    const callData = encodeFunctionData({
      abi: parseAbi(["function execute(address target,uint256 value,bytes data)"]),
      functionName: "execute",
      args: [call.to, call.value, call.data],
    });
    const input = encodeFunctionData({
      abi: entryPoint06Abi,
      functionName: "handleOps",
      args: [
        [
          {
            sender: account.address,
            nonce: 0n,
            initCode: "0x",
            callData,
            callGasLimit: 100000n,
            verificationGasLimit: 100000n,
            preVerificationGas: 10000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            paymasterAndData: "0x",
            signature: "0x",
          },
        ],
        royaltyRecipient,
      ],
    });
    const tx = {
      chainId: 8453,
      from: royaltyRecipient,
      to: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address,
      value: 0n,
      input,
      blockNumber: 101n,
    };
    expect(verifyMarketplaceTransaction(intent, tx)).toBe(true);
    expect(verifyMarketplaceTransaction(intent, tx, { status: "reverted", logs: [] })).toBe(false);
    expect(() => verifyMarketplaceTransaction(intent, tx, { status: "success", logs: [] })).toThrow(
      "execution result",
    );
    const topics = encodeEventTopics({
      abi: entryPoint06Abi,
      eventName: "UserOperationEvent",
      args: { userOpHash: zeroHash, sender: account.address, paymaster: zeroAddress },
    });
    const outcomeLog = (success: boolean, nonce = 0n) => ({
      address: tx.to,
      topics: topics.map((topic) => {
        if (typeof topic !== "string") throw new Error("Expected a concrete event topic");
        return topic;
      }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
        [nonce, success, 1n, 1n],
      ),
    });
    expect(
      verifyMarketplaceTransaction(intent, tx, { status: "success", logs: [outcomeLog(true)] }),
    ).toBe(true);
    expect(
      verifyMarketplaceTransaction(intent, tx, { status: "success", logs: [outcomeLog(false)] }),
    ).toBe(false);
    expect(() =>
      verifyMarketplaceTransaction(intent, tx, { status: "success", logs: [outcomeLog(true, 1n)] }),
    ).toThrow("execution result");
  });
  it("round-trips exact native ETH fulfillment calldata", () => {
    const order = listing();
    expect(validateListingStructure(order)).toEqual(order);
    const call = getListingFulfillment(order),
      decoded = decodeFunctionData({ abi: seaportAbi, data: call.data });
    expect(call.to).toBe(SEAPORT_ADDRESS);
    expect(call.value).toBe(1000000000000000000n);
    expect(decoded.functionName).toBe("fulfillOrder");
    if (decoded.functionName !== "fulfillOrder") throw new Error("wrong ABI");
    expect(decoded.args[0].parameters.offer[0].identifierOrCriteria).toBe(42n);
    expect(decoded.args[0].parameters.totalOriginalConsiderationItems).toBe(1n);
    expect(decoded.args[1]).toBe(zeroHash);
  });
  it("encodes cancellation for the exact signed components", () => {
    const order = listing(),
      call = getListingCancellation(order),
      decoded = decodeFunctionData({ abi: seaportAbi, data: call.data });
    expect(call.value).toBe(0n);
    expect(decoded.functionName).toBe("cancel");
    if (decoded.functionName !== "cancel") throw new Error("wrong ABI");
    expect(decoded.args[0][0].counter).toBe(0n);
    expect(decoded.args[0][0].salt).toBe(42n);
  });
  it.each([
    "collection",
    "quantity",
    "currency",
    "recipient",
    "dynamic",
    "conduit",
    "zone",
    "expiry",
    "range",
    "criteria",
  ])("rejects unsafe %s changes", (field) => {
    const order = listing(),
      p = order.parameters;
    if (field === "collection") p.offer[0].token = royaltyRecipient;
    if (field === "quantity") p.offer[0].startAmount = "2";
    if (field === "currency") p.consideration[0].itemType = 1;
    if (field === "recipient") p.consideration[0].recipient = royaltyRecipient;
    if (field === "dynamic") p.consideration[0].endAmount = "1";
    if (field === "conduit") p.conduitKey = `0x${"11".repeat(32)}`;
    if (field === "zone") p.zone = royaltyRecipient;
    if (field === "expiry") p.endTime = String(now - 1);
    if (field === "range") p.endTime = String(now + 86400 * 40);
    if (field === "criteria") p.offer[0].itemType = 4;
    expect(() => validateListingStructure(order)).toThrow();
  });
  it("rejects overflowing consideration totals", () => {
    const order = listing();
    order.parameters.consideration[0].startAmount = (2n ** 256n - 1n).toString();
    order.parameters.consideration.push({
      ...order.parameters.consideration[0],
      startAmount: "1",
      recipient: royaltyRecipient,
    });
    expect(() => getListingPriceWei(order)).toThrow("uint256");
  });
  it("binds typed signatures to Base and canonical Seaport 1.6", () => {
    const typed = getListingTypedData(listing().parameters);
    expect(typed.domain).toEqual({
      name: "Seaport",
      version: "1.6",
      chainId: 8453,
      verifyingContract: SEAPORT_ADDRESS,
    });
  });
  it("validates real EOA signatures using the owner, not an admin", async () => {
    const order = listing();
    order.signature = await account.signTypedData(getListingTypedData(order.parameters));
    await expect(validateListingOnchain(client(order), order)).resolves.toEqual({
      orderHash: getListingOrderHash(order.parameters),
    });
    const wrong = privateKeyToAccount(`0x${"22".repeat(32)}`);
    order.signature = await wrong.signTypedData(getListingTypedData(order.parameters));
    await expect(validateListingOnchain(client(order), order)).rejects.toThrow("owner signature");
  });
  it("requires the exact EIP1271 magic value for deployed smart accounts", async () => {
    const order = listing(),
      reader = client(order, { isValidSignature: "0xffffffff" });
    vi.mocked(reader.getCode).mockResolvedValue("0x6000");
    await expect(validateListingOnchain(reader, order)).rejects.toThrow("Smart account");
    const valid = client(order, { isValidSignature: "0x1626ba7e" });
    vi.mocked(valid.getCode).mockResolvedValue("0x6000");
    await expect(validateListingOnchain(valid, order)).resolves.toBeDefined();
  });
  it.each([
    ["cancelled", { getOrderStatus: [false, true, 0n, 0n] }],
    ["filled", { getOrderStatus: [true, false, 1n, 1n] }],
    ["invalid-counter", { getCounter: 1n }],
    ["invalid-owner", { ownerOf: royaltyRecipient }],
    ["unapproved", { getApproved: zeroAddress }],
  ] as const)("reconciles %s from onchain state", async (status, overrides) => {
    const order = listing();
    await expect(getListingStatus(client(order, overrides), order)).resolves.toBe(status);
  });
  it("does not turn RPC failures into an inactive status or zero royalty", async () => {
    const order = listing();
    await expect(
      getListingStatus(client(order, { ownerOf: new Error("RPC down") }), order),
    ).rejects.toThrow("RPC down");
    order.signature = await account.signTypedData(getListingTypedData(order.parameters));
    await expect(
      validateListingOnchain(client(order, { supportsInterface: new Error("RPC down") }), order),
    ).rejects.toThrow("RPC down");
  });
  it("requires declared collection royalties and rejects arbitrary extra fees", async () => {
    const order = listing();
    order.parameters.consideration[0].startAmount = "950000000000000000";
    order.parameters.consideration[0].endAmount = "950000000000000000";
    order.parameters.consideration.push({
      ...order.parameters.consideration[0],
      startAmount: "50000000000000000",
      endAmount: "50000000000000000",
      recipient: royaltyRecipient,
    });
    order.signature = await account.signTypedData(getListingTypedData(order.parameters));
    await expect(
      validateListingOnchain(
        client(order, {
          supportsInterface: true,
          royaltyInfo: [royaltyRecipient, 50000000000000000n],
        }),
        order,
      ),
    ).resolves.toBeDefined();
    await expect(validateListingOnchain(client(order), order)).rejects.toThrow("royalty");
  });
  it("allows required OpenSea fee items only through the explicit source path", async () => {
    const order = listing();
    for (let i = 0; i < 9; i++)
      order.parameters.consideration.push({
        ...order.parameters.consideration[0],
        recipient: royaltyRecipient,
        startAmount: "100",
        endAmount: "100",
      });
    expect(() => validateListingStructure(order)).toThrow();
    expect(validateListingStructure(order, { source: "opensea" })).toEqual(order);
    order.signature = await account.signTypedData(getListingTypedData(order.parameters));
    const reader = client(order, {
      supportsInterface: new Error("Must not request native royalty"),
    });
    await expect(validateListingOnchain(reader, order, { source: "opensea" })).resolves.toEqual({
      orderHash: getListingOrderHash(order.parameters),
    });
    expect(
      vi
        .mocked(reader.readContract)
        .mock.calls.some(([call]) => call.functionName === "supportsInterface"),
    ).toBe(false);
    expect(getListingFulfillment(order, { source: "opensea" }).value).toBe(
      getListingPriceWei(order),
    );
    expect(getListingCancellation(order, { source: "opensea" }).value).toBe(0n);
    order.parameters.consideration.push({ ...order.parameters.consideration[1] });
    expect(() => validateListingStructure(order, { source: "opensea" })).toThrow();
  });
  it.each(["orderType", "zone", "conduit"])("keeps authored OpenSea %s restricted", (field) => {
    const order = listing();
    if (field === "orderType") Object.assign(order.parameters, { orderType: 1 });
    if (field === "zone") order.parameters.zone = royaltyRecipient;
    if (field === "conduit") order.parameters.conduitKey = `0x${"11".repeat(32)}`;
    expect(() => validateListingStructure(order, { source: "opensea" })).toThrow();
  });
  it("uses the signed OpenSea conduit operator rather than direct Seaport approval", async () => {
    const order = listing();
    order.parameters.conduitKey = OPENSEA_CONDUIT_KEY;
    expect(() => validateListingStructure(order)).toThrow("Unsupported Seaport routing");
    expect(validateListingStructure(order, { source: "opensea" })).toEqual(order);
    expect(await getListingStatus(client(order), order, { source: "opensea" })).toBe("unapproved");
    const reader = client(order, { getApproved: OPENSEA_CONDUIT_ADDRESS });
    order.signature = await account.signTypedData(getListingTypedData(order.parameters));
    await expect(validateListingOnchain(reader, order, { source: "opensea" })).resolves.toEqual({
      orderHash: getListingOrderHash(order.parameters),
    });
    const globallyApproved = client(order, { getApproved: zeroAddress, isApprovedForAll: true });
    expect(await getListingStatus(globallyApproved, order, { source: "opensea" })).toBe("active");
    expect(globallyApproved.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        functionName: "isApprovedForAll",
        args: [account.address, OPENSEA_CONDUIT_ADDRESS],
      }),
    );
  });
  it.each([zeroHash, OPENSEA_CONDUIT_KEY])("preserves signed routing when cancelling %s", (key) => {
    const order = listing();
    order.parameters.conduitKey = key;
    const transaction = getListingCancellation(order, { source: "opensea" });
    const decoded = decodeFunctionData({ abi: seaportAbi, data: transaction.data });
    expect(decoded.functionName).toBe("cancel");
    if (decoded.functionName !== "cancel") throw new Error("Unexpected cancellation");
    expect(decoded.args[0][0].conduitKey).toBe(key);
    expect(getListingOrderHash(order.parameters)).not.toBe(zeroHash);
  });
  it.each([
    ["counter", { getCounter: 1n }],
    ["owner", { ownerOf: royaltyRecipient }],
    ["approval", { getApproved: zeroAddress }],
    ["hash", { getOrderHash: zeroHash }],
  ])("still verifies OpenSea %s onchain", async (_name, overrides) => {
    const order = listing();
    order.signature = await account.signTypedData(getListingTypedData(order.parameters));
    await expect(
      validateListingOnchain(client(order, overrides), order, { source: "opensea" }),
    ).rejects.toThrow();
  });
  it("still verifies OpenSea EOA and smart account signatures", async () => {
    const order = listing();
    order.signature = await privateKeyToAccount(`0x${"22".repeat(32)}`).signTypedData(
      getListingTypedData(order.parameters),
    );
    await expect(
      validateListingOnchain(client(order), order, { source: "opensea" }),
    ).rejects.toThrow("owner signature");
    const reader = client(order, { isValidSignature: "0xffffffff" });
    vi.mocked(reader.getCode).mockResolvedValue("0x6000");
    await expect(validateListingOnchain(reader, order, { source: "opensea" })).rejects.toThrow(
      "Smart account",
    );
  });
});
