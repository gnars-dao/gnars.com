import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import { describe, expect, it } from "vitest";
import upgraderAbi from "@/utils/abis/upgrader-eth.json";
import {
  claimCall,
  depositCall,
  UPGRADER_CLAIM_METHOD,
  UPGRADER_DEPOSIT_METHOD,
  UPGRADER_WITHDRAW_METHOD,
  withdrawCall,
} from "./upgrader-calls";

const SIGNER = "0x8Bf5941d27176242745B716251943Ae4892a3C26" as const;
const abi = parseAbi([UPGRADER_DEPOSIT_METHOD, UPGRADER_WITHDRAW_METHOD, UPGRADER_CLAIM_METHOD]);

/** Selector of a function as declared in the contract's own ABI (the dumped artifact). */
function contractSelector(name: string): { selector: string; inputs: number } {
  const entry = (
    upgraderAbi as { type: string; name?: string; inputs?: { type: string }[] }[]
  ).find((e) => e.type === "function" && e.name === name);
  if (!entry) throw new Error(`ABI has no function ${name}`);
  const types = (entry.inputs ?? []).map((i) => i.type).join(",");
  return { selector: toFunctionSelector(`${name}(${types})`), inputs: entry.inputs?.length ?? 0 };
}

/** Encodes a call the way thirdweb's prepareContractCall will, from the same method string. */
function encode(fn: "deposit" | "withdraw" | "claim", args: readonly unknown[]) {
  return encodeFunctionData({ abi, functionName: fn, args } as unknown as Parameters<
    typeof encodeFunctionData
  >[0]);
}

describe("UpgraderEth calldata", () => {
  it("deposit is the FOUR-argument signature — no bool donation", () => {
    // The contract's own ABI says four inputs; our method string must encode to
    // the same selector, or every deposit would revert at the dispatcher.
    const real = contractSelector("deposit");
    expect(real.inputs).toBe(4);
    const call = depositCall(0n, SIGNER, 123n);
    const data = encode("deposit", call.params);
    expect(data.slice(0, 10)).toBe(real.selector);
    // 4 words of arguments after the selector, not 5.
    expect((data.length - 10) / 64).toBe(4);
    const decoded = decodeFunctionData({ abi, data });
    expect(decoded.functionName).toBe("deposit");
    expect(decoded.args).toEqual([0n, SIGNER, zeroAddress, 123n]);
  });

  it("deposit sends the ETH as msg.value equal to quantity, with token = address(0)", () => {
    const call = depositCall(7n, SIGNER, 5_000n);
    expect(call.value).toBe(5_000n);
    expect(call.params[2]).toBe(zeroAddress);
    expect(call.params[3]).toBe(call.value);
  });

  it("deposit's user is the signer passed in, verbatim", () => {
    expect(depositCall(0n, SIGNER, 1n).params[1]).toBe(SIGNER);
  });

  it("refuses a zero deposit rather than sending an empty call", () => {
    expect(() => depositCall(0n, SIGNER, 0n)).toThrow();
  });

  it("withdraw mirrors deposit's arguments and attaches no ETH", () => {
    const call = withdrawCall(0n, SIGNER, 99n);
    expect(encode("withdraw", call.params).slice(0, 10)).toBe(
      contractSelector("withdraw").selector,
    );
    expect(call.params).toEqual([0n, SIGNER, zeroAddress, 99n]);
    expect(call.value).toBe(0n);
  });

  it("claim takes (upgradeId, user) only", () => {
    const call = claimCall(0n, SIGNER);
    const data = encode("claim", call.params);
    expect(data.slice(0, 10)).toBe(contractSelector("claim").selector);
    expect((data.length - 10) / 64).toBe(2);
    expect(call.value).toBe(0n);
  });
});
