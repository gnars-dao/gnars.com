import {
  createThirdwebClient,
  encode,
  getContract,
  prepareContractCall,
  prepareTransaction,
} from "thirdweb";
import { base } from "thirdweb/chains";
import { describe, expect, it } from "vitest";
import {
  prepareContractCall as attributedContractCall,
  prepareTransaction as attributedTransaction,
  withBuilderCode,
} from "@/lib/builder-code";
import { BUILDER_CODE, BUILDER_CODE_SUFFIX, TREASURY_TOKEN_ALLOWLIST } from "@/lib/config";

const client = createThirdwebClient({ clientId: "test-only" });
const someone = "0x1234567890123456789012345678901234567890" as const;
const suffixBody = BUILDER_CODE_SUFFIX.slice(2);

describe("BUILDER_CODE_SUFFIX", () => {
  it("is the ERC-8021 framing the Base dashboard issued for our code", () => {
    const bytes = Buffer.from(suffixBody, "hex");
    // Read from the end: 16-byte marker, version, length, then the code itself.
    expect(bytes.subarray(-16).toString("hex")).toBe("8021".repeat(8));
    expect(bytes[bytes.length - 17]).toBe(0x00);
    expect(bytes[bytes.length - 18]).toBe(BUILDER_CODE.length);
    expect(bytes.subarray(0, BUILDER_CODE.length).toString("ascii")).toBe(BUILDER_CODE);
    expect(bytes.length).toBe(BUILDER_CODE.length + 18);
  });
});

describe("withBuilderCode", () => {
  it("appends the suffix to a raw value transfer, which has no calldata of its own", async () => {
    const tx = prepareTransaction({ chain: base, client, to: someone, value: 0n });

    expect(await encode(tx)).toBe("0x");
    expect(await encode(withBuilderCode(tx))).toBe(BUILDER_CODE_SUFFIX);
  });

  it("appends the suffix after ABI-encoded arguments without disturbing them", async () => {
    const tx = prepareContractCall({
      contract: getContract({ client, chain: base, address: TREASURY_TOKEN_ALLOWLIST.USDC }),
      method: "function approve(address spender, uint256 amount)",
      params: [someone, 0n],
    });

    const plain = await encode(tx);
    expect(await encode(withBuilderCode(tx))).toBe(plain + suffixBody);
  });

  it("appends the suffix to a no-arg call, where calldata is just the selector", async () => {
    const tx = prepareContractCall({
      contract: getContract({ client, chain: base, address: TREASURY_TOKEN_ALLOWLIST.WETH }),
      method: "function deposit()",
      params: [],
      value: 0n,
    });

    const plain = await encode(tx);
    expect(plain).toHaveLength(10); // 0x + 4-byte selector
    expect(await encode(withBuilderCode(tx))).toBe(plain + suffixBody);
  });

  it("leaves the original transaction untagged so callers can opt out per call", async () => {
    const tx = prepareTransaction({ chain: base, client, to: someone, value: 0n });
    withBuilderCode(tx);

    expect(await encode(tx)).toBe("0x");
  });
});

describe("the prepare* wrappers", () => {
  it("tags a contract call without the caller doing anything", async () => {
    const options = {
      contract: getContract({ client, chain: base, address: TREASURY_TOKEN_ALLOWLIST.USDC }),
      method: "function approve(address spender, uint256 amount)",
      params: [someone, 0n],
    } as const;

    const plain = await encode(prepareContractCall(options));
    expect(await encode(attributedContractCall(options))).toBe(plain + suffixBody);
  });

  it("tags calldata handed to us fully built, as the swap path does with 0x quotes", async () => {
    const quoteCalldata = "0xdeadbeef" as const;
    const options = {
      chain: base,
      client,
      to: someone,
      value: 0n,
      data: quoteCalldata,
    } as const;

    expect(await encode(prepareTransaction(options))).toBe(quoteCalldata);
    expect(await encode(attributedTransaction(options))).toBe(quoteCalldata + suffixBody);
  });
});
