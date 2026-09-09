import { getContractAddress, hashDomain, padHex, toHex, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../../contracts/gnars-marketplace/artifacts/runtime-manifest.json";
import artifact from "../../contracts/gnars-marketplace/artifacts/Seaport.json";
import { marketplaceContractReady } from "./marketplace-contract";

const mocks = vi.hoisted(() => ({
  address: vi.fn(),
  code: vi.fn(),
  info: vi.fn(),
  chain: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/marketplace/routing", () => ({
  getGnarsMarketplaceAddress: mocks.address,
  SEAPORT_ADDRESS: "0x0000000000000068F116a894984e2DB1123eB395",
}));
vi.mock("./marketplace-common", () => ({
  marketplaceClient: { getCode: mocks.code, readContract: mocks.info, getChainId: mocks.chain },
}));

const address = "0x1111111111111111111111111111111111111111" as Address;
const canonical = "0x0000000000000068F116a894984e2DB1123eB395";
const probe = getContractAddress({ from: address, nonce: 1n });
const domain = hashDomain({
  domain: { name: "Seaport", version: "1.6", chainId: 8453, verifyingContract: address },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
  },
});
let runtime: Hex;

function setImmutable(code: Hex, name: keyof typeof manifest.immutableReferences, value: Hex): Hex {
  const bytes = Buffer.from(code.slice(2), "hex");
  for (const { start, length } of manifest.immutableReferences[name])
    Buffer.from(padHex(value, { size: length }).slice(2), "hex").copy(bytes, start);
  return `0x${bytes.toString("hex")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.address.mockReturnValue(address);
  mocks.chain.mockResolvedValue(8453);
  runtime = artifact.deployedBytecode as Hex;
  runtime = setImmutable(runtime, "_DOMAIN_SEPARATOR", domain);
  runtime = setImmutable(runtime, "_CHAIN_ID", toHex(8453));
  runtime = setImmutable(runtime, "_CONDUIT_CONTROLLER", manifest.conduitController as Hex);
  runtime = setImmutable(runtime, "_tstoreInitialSupport", "0x01");
  runtime = setImmutable(runtime, "_tloadTestContract", probe);
  mocks.code.mockImplementation(async ({ address: target }: { address: Address }) => {
    if (target === canonical) return artifact.deployedBytecode;
    if (target.toLowerCase() === probe.toLowerCase()) return "0x3d5c";
    return runtime;
  });
  mocks.info.mockResolvedValue(["1.6", domain, manifest.conduitController]);
});

describe("owned marketplace contract identity", () => {
  it("disables absent configuration without an RPC request", async () => {
    mocks.address.mockReturnValue(null);
    expect(await marketplaceContractReady()).toBe(false);
    expect(mocks.chain).not.toHaveBeenCalled();
  });
  it("accepts the pinned runtime with validated immutable values and constructor probe", async () => {
    expect(await marketplaceContractReady()).toBe(true);
  });
  it("rejects arbitrary runtime even when information() claims Seaport", async () => {
    runtime = "0x6000";
    expect(await marketplaceContractReady()).toBe(false);
  });
  it("rejects a modified instruction outside immutable slots", async () => {
    runtime = `0x00${runtime.slice(4)}`;
    expect(await marketplaceContractReady()).toBe(false);
  });
  it.each(["_NAME_HASH", "_ORDER_TYPEHASH", "_CONDUIT_CREATION_CODE_HASH"] as const)(
    "rejects modified immutable %s",
    async (name) => {
      runtime = setImmutable(runtime, name, "0x01");
      expect(await marketplaceContractReady()).toBe(false);
    },
  );
  it("rejects a canonical-address domain reused in the custom contract", async () => {
    runtime = setImmutable(runtime, "_DOMAIN_SEPARATOR", "0x01");
    expect(await marketplaceContractReady()).toBe(false);
  });
  it("rejects a missing TLOAD child contract", async () => {
    mocks.code.mockImplementation(async ({ address: target }: { address: Address }) =>
      target === canonical ? artifact.deployedBytecode : target === address ? runtime : "0x",
    );
    expect(await marketplaceContractReady()).toBe(false);
  });
  it("rejects an arbitrary TLOAD probe address", async () => {
    runtime = setImmutable(runtime, "_tloadTestContract", address);
    expect(await marketplaceContractReady()).toBe(false);
  });
  it("rejects a disabled transient-storage guard in a new Base deployment", async () => {
    runtime = setImmutable(runtime, "_tstoreInitialSupport", "0x00");
    expect(await marketplaceContractReady()).toBe(false);
  });
  it("rejects wrong chain, controller, version and RPC failure", async () => {
    mocks.chain.mockResolvedValueOnce(1);
    expect(await marketplaceContractReady()).toBe(false);
    mocks.info.mockResolvedValueOnce(["1.6", domain, address]);
    expect(await marketplaceContractReady()).toBe(false);
    mocks.info.mockResolvedValueOnce(["1.5", domain, manifest.conduitController]);
    expect(await marketplaceContractReady()).toBe(false);
    mocks.info.mockRejectedValueOnce(new Error("RPC unavailable"));
    expect(await marketplaceContractReady()).toBe(false);
  });
});
