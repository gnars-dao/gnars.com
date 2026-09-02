import { decodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from "viem";

/**
 * Zora's quote endpoint returns a Universal Router `execute(bytes commands,
 * bytes[] inputs)` call. For an ERC-20 sell it front-loads a PERMIT2_PERMIT
 * command whose signature slot is a literal ASCII placeholder
 * (`REPLACE_WITH_PERMIT_SIGNATURE_…`) until the SDK signs the permit offchain
 * and re-quotes.
 *
 * Smart accounts under sponsored gas don't want an extra typed-data prompt per
 * coin. They can grant the same allowance onchain instead — `coin.approve(PERMIT2)`
 * then `PERMIT2.approve(coin, router, amount, expiration)` — and execute the
 * router call with the permit command removed. This helper does the removal.
 *
 * Validated on a Base fork against the live router (scripts/sim-migrate-batch.ts).
 */

const UNIVERSAL_ROUTER_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs)"]);
const EXECUTE_SELECTOR = "0x24856bc3";
const PERMIT2_PERMIT = 0x0a;
const COMMAND_TYPE_MASK = 0x3f;

export interface StrippedRouterCall {
  data: Hex;
  /** Command bytes before/after, for logging. */
  before: string;
  after: string;
  /** Trailing bytes Zora appends (attribution suffix) — preserved. */
  suffix: Hex;
}

export function stripPermitFromRouterCall(data: Hex): StrippedRouterCall {
  if (!data.startsWith(EXECUTE_SELECTOR)) {
    throw new Error(`Unexpected router selector ${data.slice(0, 10)}`);
  }
  // Zora appends a 4-byte attribution suffix after the ABI payload; the payload
  // itself is a whole number of 32-byte words. Peel it off before decoding.
  let body = data.slice(10);
  let suffix: Hex = "0x";
  const rem = (body.length / 2) % 32;
  if (rem !== 0) {
    suffix = `0x${body.slice(body.length - rem * 2)}`;
    body = body.slice(0, body.length - rem * 2);
  }
  // The placeholder signature is raw ASCII inside the hex string. Blank it so the
  // payload decodes; that input is dropped anyway.
  const sanitized = `0x${body.replace(/[^0-9a-fA-F]/g, "0")}` as Hex;
  const [commands, inputs] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    sanitized,
  );
  const cmdBytes = (commands.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16));
  if (cmdBytes.length !== inputs.length) {
    throw new Error(`Router call has ${cmdBytes.length} commands but ${inputs.length} inputs`);
  }
  const keep = cmdBytes.map((c) => (c & COMMAND_TYPE_MASK) !== PERMIT2_PERMIT);
  const newCommands = `0x${cmdBytes
    .filter((_, i) => keep[i])
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
  const newInputs = inputs.filter((_, i) => keep[i]);
  const encoded = encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [newCommands, newInputs],
  });
  return {
    data: `${encoded}${suffix.slice(2)}` as Hex,
    before: commands,
    after: newCommands,
    suffix,
  };
}
