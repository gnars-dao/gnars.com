import { isAddress } from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine(isAddress)
  .transform((value) => value.toLowerCase());
const block = z.string().regex(/^(latest|safe|finalized|0x[0-9a-fA-F]{1,16})$/);

export const alchemyRequestSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("eth_getBalance"),
    params: z.tuple([address, block]).or(z.tuple([address])),
  }),
  z.object({
    method: z.literal("alchemy_getTokenBalances"),
    params: z
      .tuple([address])
      .or(
        z.tuple([
          address,
          z.enum(["DEFAULT_TOKENS", "erc20"]).or(z.array(address).min(1).max(100)),
        ]),
      ),
  }),
  z.object({ method: z.literal("alchemy_getTokenMetadata"), params: z.tuple([address]) }),
]);
