/** A fixed worker pool; results retain input order regardless of completion order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency");
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && cursor < items.length) {
        const index = cursor++;
        try {
          results[index] = await fn(items[index]);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}
