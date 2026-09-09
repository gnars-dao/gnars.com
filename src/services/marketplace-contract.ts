import "server-only";
import { unstable_cache } from "next/cache";
import {
  getContractAddress,
  hashDomain,
  isAddressEqual,
  keccak256,
  padHex,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { getGnarsMarketplaceAddress, SEAPORT_ADDRESS } from "@/lib/marketplace/routing";
import manifest from "../../contracts/gnars-marketplace/artifacts/runtime-manifest.json";
import { marketplaceClient } from "./marketplace-common";

type Slot = { start: number; length: number };
const immutableReferences: Record<string, Slot[]> = manifest.immutableReferences;
const infoAbi = parseAbi([
  "function information() view returns(string version,bytes32 domainSeparator,address conduitController)",
]);

function immutableValue(code: Hex, slots: Slot[]): Hex {
  const values = slots.map(({ start, length }) =>
    code.slice(2 + start * 2, 2 + (start + length) * 2),
  );
  if (!values.length || values.some((value) => value !== values[0]))
    throw new Error("Inconsistent marketplace immutable");
  return `0x${values[0]}`;
}

function maskedRuntimeHash(code: Hex): Hex {
  const bytes = Buffer.from(code.slice(2), "hex");
  if (bytes.length !== manifest.runtimeBytes)
    throw new Error("Unexpected marketplace runtime size");
  for (const slots of Object.values(immutableReferences))
    for (const { start, length } of slots) bytes.fill(0, start, start + length);
  return keccak256(bytes);
}

const checkContract = unstable_cache(
  async (address: Address): Promise<boolean> => {
    try {
      if ((await marketplaceClient.getChainId()) !== 8453) return false;
      const [code, canonicalCode, information] = await Promise.all([
        marketplaceClient.getCode({ address }),
        marketplaceClient.getCode({ address: SEAPORT_ADDRESS }),
        marketplaceClient.readContract({ address, abi: infoAbi, functionName: "information" }),
      ]);
      if (!code || !canonicalCode) return false;
      if (
        maskedRuntimeHash(code) !== manifest.maskedRuntimeKeccak256 ||
        maskedRuntimeHash(canonicalCode) !== manifest.maskedRuntimeKeccak256
      )
        return false;
      const expectedDomain = hashDomain({
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
      const [version, domain, controller] = information;
      if (
        version !== manifest.version ||
        domain !== expectedDomain ||
        !isAddressEqual(controller, manifest.conduitController as Address)
      )
        return false;
      // Masking is only the first check: immutable constants must also match their meaning.
      // The TLOAD probe is the first CREATE in the unmodified constructor.
      const probe = getContractAddress({ from: address, nonce: 1n });
      for (const [name, slots] of Object.entries(immutableReferences)) {
        const expected =
          name === "_DOMAIN_SEPARATOR"
            ? expectedDomain
            : name === "_tloadTestContract"
              ? padHex(probe, { size: 32 })
              : name === "_tstoreInitialSupport"
                ? toHex(1n, { size: 32 })
                : name === "_CHAIN_ID"
                  ? toHex(8453n, { size: 32 })
                  : name === "_CONDUIT_CONTROLLER"
                    ? padHex(manifest.conduitController as Hex, { size: 32 })
                    : immutableValue(canonicalCode, slots);
        if (immutableValue(code, slots).toLowerCase() !== expected.toLowerCase()) return false;
      }
      // The constructor's tiny probe must be present, not an arbitrary external dependency.
      return (await marketplaceClient.getCode({ address: probe })) === "0x3d5c";
    } catch {
      return false;
    }
  },
  ["gnars-marketplace-contract-identity-v1", manifest.maskedRuntimeKeccak256],
  { revalidate: 30 },
);

export async function marketplaceContractReady(): Promise<boolean> {
  const address = getGnarsMarketplaceAddress();
  return address ? checkContract(address) : false;
}
