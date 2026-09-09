type RevalidationProof = { transactionHash: string; chainId?: number };

/** Refresh after confirmation. TTLs remain the fallback if the client navigates away. */
export function requestRevalidation(tags: string[], proof: RevalidationProof): void {
  if (!tags.length) return;
  const refresh = () => {
    void fetch("/api/revalidate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags, ...proof }),
      keepalive: true,
    }).catch((error) => console.warn("Cache refresh unavailable", error));
  };
  refresh();
  // Give the indexer time without keeping a serverless function alive.
  if (typeof window !== "undefined") window.setTimeout(refresh, 45_000);
}
