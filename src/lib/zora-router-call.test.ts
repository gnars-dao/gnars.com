import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { stripPermitFromRouterCall } from "./zora-router-call";

const abi = parseAbi(["function execute(bytes commands, bytes[] inputs)"]);

/** Builds a router call the way Zora's quote endpoint does: permit first, ASCII placeholder in the signature slot, 4-byte suffix. */
function zoraStyleCall(commands: Hex, inputs: Hex[], placeholder = true): Hex {
  let data = encodeFunctionData({ abi, functionName: "execute", args: [commands, inputs] });
  if (placeholder) {
    // The permit input's signature bytes come back as raw text inside the hex string.
    const marker = "ee".repeat(16);
    const idx = data.indexOf(marker);
    if (idx < 0) throw new Error("test fixture: marker not found");
    data = (data.slice(0, idx) +
      "REPLACE_WITH_PERMIT_SIGNATURE_10" +
      data.slice(idx + marker.length)) as Hex;
  }
  return `${data}deadbeef` as Hex;
}

describe("stripPermitFromRouterCall", () => {
  const permitInput = `0x${"ee".repeat(16)}${"11".repeat(48)}` as Hex;
  const transferInput = `0x${"22".repeat(64)}` as Hex;
  const swapInput = `0x${"33".repeat(96)}` as Hex;
  const v3Input = `0x${"55".repeat(64)}` as Hex;
  const unwrapInput = `0x${"44".repeat(64)}` as Hex;

  it("drops the PERMIT2_PERMIT command and its input, keeps the rest in order", () => {
    // The live $gnars → ZORA → WETH quote: permit, transfer-from, V4 swap, V3 swap, unwrap.
    const call = zoraStyleCall("0x0a0210000c", [
      permitInput,
      transferInput,
      swapInput,
      v3Input,
      unwrapInput,
    ]);
    const out = stripPermitFromRouterCall(call);
    expect(out.before).toBe("0x0a0210000c");
    expect(out.after).toBe("0x0210000c");
    expect(out.suffix).toBe("0xdeadbeef");
    expect(out.data.endsWith("deadbeef")).toBe(true);
    const decoded = decodeFunctionData({ abi, data: out.data.slice(0, -8) as Hex });
    expect(decoded.args[0]).toBe("0x0210000c");
    expect(decoded.args[1]).toEqual([transferInput, swapInput, v3Input, unwrapInput]);
  });

  it("respects the allow-revert flag bit when matching the command type", () => {
    // 0x8a = PERMIT2_PERMIT with FLAG_ALLOW_REVERT set.
    const call = zoraStyleCall("0x8a10", [permitInput, swapInput]);
    expect(stripPermitFromRouterCall(call).after).toBe("0x10");
  });

  it("leaves a call with no permit untouched apart from re-encoding", () => {
    const call = zoraStyleCall("0x10", [swapInput], false);
    const out = stripPermitFromRouterCall(call);
    expect(out.after).toBe("0x10");
    expect(out.data).toBe(call);
  });

  it("refuses a call that is not execute(bytes,bytes[])", () => {
    expect(() => stripPermitFromRouterCall("0x3593564c00")).toThrow(/selector/);
  });
});
