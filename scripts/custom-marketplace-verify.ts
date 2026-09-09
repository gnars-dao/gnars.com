/** Read-only verification of an EOA-created marketplace deployment; never signs or broadcasts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  concatHex,
  createPublicClient,
  encodeDeployData,
  hashDomain,
  http,
  isAddress,
  isAddressEqual,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { BUILDER_CODE_SUFFIX } from "../src/lib/config";

async function main() {
  const [address, deploymentHash] = process.argv.slice(2);
  assert(
    address && isAddress(address),
    "Usage: custom-marketplace-verify.ts <address> <creation-tx-hash>",
  );
  assert(/^0x[0-9a-fA-F]{64}$/.test(deploymentHash ?? ""), "Creation transaction hash required");
  const artifact = JSON.parse(
    await readFile("contracts/gnars-marketplace/artifacts/Seaport.json", "utf8"),
  ) as {
    abi: Abi;
    creationBytecode: Hex;
    deployedBytecode: Hex;
    conduitController: Address;
    creationBytecodeSha256: string;
    immutableReferences: Record<string, { start: number; length: number }[]>;
  };
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(artifact.creationBytecode.slice(2), "hex"))
      .digest("hex"),
    artifact.creationBytecodeSha256,
  );
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.CUSTOM_MARKETPLACE_VERIFY_RPC ?? "https://mainnet.base.org"),
  });
  assert.equal(await client.getChainId(), 8453);
  const receipt = await client.getTransactionReceipt({ hash: deploymentHash as Hex });
  assert.equal(receipt.status, "success");
  assert(receipt.contractAddress && isAddressEqual(receipt.contractAddress, address));
  const transaction = await client.getTransaction({ hash: deploymentHash as Hex });
  assert.equal(
    transaction.to,
    null,
    "Only direct EOA contract creation is supported by this verifier",
  );
  const expectedInput = concatHex([
    encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.creationBytecode,
      args: [artifact.conduitController],
    }),
    BUILDER_CODE_SUFFIX,
  ]);
  assert.equal(
    transaction.input.toLowerCase(),
    expectedInput.toLowerCase(),
    "Creation bytecode, constructor argument or builder tag does not match",
  );
  const code = await client.getCode({ address });
  assert(code && code !== "0x", "Contract runtime missing");
  const mask = (value: Hex) => {
    const bytes = Buffer.from(value.slice(2), "hex");
    for (const slots of Object.values(artifact.immutableReferences))
      for (const { start, length } of slots) {
        assert(start + length <= bytes.length, "Invalid immutable slot");
        bytes.fill(0, start, start + length);
      }
    return bytes.toString("hex");
  };
  assert.equal(
    mask(code),
    mask(artifact.deployedBytecode),
    "Runtime differs outside compiler-declared immutables",
  );
  const [version, separator, controller] = await client.readContract({
    address,
    abi: parseAbi([
      "function information() view returns(string version,bytes32 domainSeparator,address conduitController)",
    ]),
    functionName: "information",
  });
  assert.equal(version, "1.6");
  assert(isAddressEqual(controller, artifact.conduitController));
  assert.equal(
    separator,
    hashDomain({
      domain: { name: "Seaport", version: "1.6", chainId: 8453, verifyingContract: address },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    }),
  );
  console.log(
    `PASS Base deployment ${address}; exact creation payload, runtime, version, signing domain, controller and builder tag verified. Explorer source verification remains separate.`,
  );
}

main().catch((error: unknown) => {
  console.error(
    "FAIL [deployment verification]",
    error instanceof assert.AssertionError
      ? error.message
      : "Read-only verification failed; check the address, hash, artifact and RPC availability.",
  );
  process.exitCode = 1;
});
