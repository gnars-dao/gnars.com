/**
 * Normalises what a person types into an amount field into something
 * `parseEther` / `parseUnits` can read: a comma becomes a dot, everything
 * that is not a digit or a dot is dropped, and only the first dot survives.
 *
 * Why this exists: an iPhone set to a Brazilian (or any comma-decimal) region
 * shows a decimal keyboard with ONLY a comma. A field that strips non-digits
 * turns "0,05" into "005" silently, and parseEther("005") is 5 ETH — a
 * 100× (or worse) overshoot that a sponsored smart-account signature would
 * send without a review screen. Never strip a decimal separator; convert it.
 */
export function normalizeDecimalInput(raw: string): string {
  const s = raw.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const [head, ...rest] = s.split(".");
  return rest.length ? `${head}.${rest.join("")}` : head;
}
