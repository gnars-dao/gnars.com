import { z } from "zod";
import { shippingAddressSchema } from "@/lib/schemas/dropship";

/**
 * Storefront checkout payload — the customer-facing side of the /store flow.
 *
 * The client collects contact + shipping details and (in live mode) pays USDC on Base,
 * then POSTs this to `/api/store/checkout`. The server re-verifies the on-chain payment
 * before forwarding a fulfillment order to KeepKey. See docs/features/store-checkout.md.
 */
export const checkoutInputSchema = z.object({
  /** Product slug from the catalog (src/data/store.json). */
  slug: z.string().min(1).max(200),
  /** Selected finish/variant title (cosmetic; passed to KeepKey in `notes`). */
  finish: z.string().max(200).optional().default(""),
  customerName: z.string().min(1, "Name is required").max(200),
  customerEmail: z.string().email("Enter a valid email").max(254),
  shippingAddress: shippingAddressSchema,
  /**
   * Base tx hash of the customer's USDC payment. Required in live mode (the server
   * verifies it); ignored in sandbox mode, where no payment is collected.
   */
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "Invalid transaction hash")
    .transform((hash) => hash.toLowerCase())
    .optional(),
});

export type CheckoutInput = z.infer<typeof checkoutInputSchema>;

export interface CheckoutResult {
  orderAccessToken: string;
  keepKeyOrderId: string;
  externalOrderId: string;
  status: string;
  sandbox: boolean;
}
