/** Release a durable request only for an explicit wallet refusal, never an RPC message match. */
export function isMarketplaceWalletRejection(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6; depth++) {
    if (!current || typeof current !== "object") return false;
    if ("code" in current && (current.code === 4001 || current.code === "ACTION_REJECTED"))
      return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
