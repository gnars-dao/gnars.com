/**
 * One throttle + retry gate for every call to the Goldsky subgraph.
 *
 * Why this exists: the Builder subgraph is served from Goldsky's *public*
 * endpoint (`/api/public/<project>/…`). Public means there is no API key to
 * add and no per-key quota to raise — Cloudflare rate-limits by burst, and a
 * burst is exactly what a production build produces. Next prerenders up to
 * `staticGenerationMaxConcurrency` pages per worker across three workers, and
 * a single proposal page fans out into several subgraph reads, so the build
 * used to open ~20 connections at once. Goldsky answered 429 with
 * `retry-after: 2`, the per-call backoff ladder gave up after ~15s, and the
 * whole deploy aborted on `Export encountered an error on /en/proposals/…`.
 *
 * Two things were missing and both live here now:
 *
 * 1. **A shared limit.** Retries alone can't fix a burst — every retrying call
 *    re-enters the same burst. `run()` funnels all subgraph traffic through one
 *    semaphore per process, so concurrency is bounded no matter how many
 *    callers, pages, or SDK helpers are in flight.
 * 2. **Respect for `retry-after`.** The server states how long to wait; the old
 *    ladder ignored it and retried early into another 429.
 *
 * Every subgraph caller goes through here — `subgraphQuery`, the raw fetches in
 * `services/proposals.ts`, and the `@buildeross/sdk` helpers (wrapped at the
 * call site, since the SDK owns its own fetch).
 *
 * Errors still propagate after the ladder is exhausted: a failed read must
 * render as a failure, never as zero.
 */

/** Concurrency is per process, so the build's three workers get 3x this. */
const MAX_CONCURRENCY = (() => {
  if (typeof window !== "undefined") return 8; // a browser tab is never the burst
  // `phase-production-build` is set by Next in the build process and inherited
  // by the export workers that actually render the pages.
  const isBuild = process.env.NEXT_PHASE === "phase-production-build";
  const override = Number(process.env.SUBGRAPH_MAX_CONCURRENCY);
  if (Number.isFinite(override) && override > 0) return override;
  // 1 during the build, not 2: the deploy that failed had exactly six proposal
  // reads in flight and Goldsky 429'd all six, so the ceiling sits below that.
  // Workers multiply this (3 on Vercel's 4-core builder), and a serial worker
  // costs the build seconds, not minutes — static generation is 307 pages in
  // ~20s. `SUBGRAPH_MAX_CONCURRENCY` retunes it without a code change.
  return isBuild ? 1 : 8;
})();

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;
/** Cap on an honored `retry-after`, so a hostile header can't stall a build. */
const MAX_RETRY_AFTER_MS = 30_000;

let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A 429/5xx/network failure carrying the server's own `retry-after`, so the
 * ladder can wait exactly as long as it was told to.
 */
export class SubgraphTransientError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "SubgraphTransientError";
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both are legal. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Transient by *shape*, not by string matching where we can help it: the SDK
 * throws `GraphQL Error (Code: 429)` with no structured status, so the message
 * probe stays as the fallback for callers we don't own.
 */
function classify(err: unknown): { transient: boolean; retryAfterMs?: number } {
  if (err instanceof SubgraphTransientError) {
    return { transient: true, retryAfterMs: err.retryAfterMs };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const transient =
    /\b429\b|rate.?limit|too many requests|\b50[234]\b|fetch failed|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up/i.test(
      msg,
    );
  return { transient };
}

/**
 * Run a subgraph call inside the shared limit, retrying transient failures.
 *
 * The semaphore slot is *held across retries on purpose*: a call that is being
 * rate-limited should occupy a slot rather than free it for a fresh caller that
 * would only widen the burst.
 */
export async function run<T>(fn: () => Promise<T>, label: string): Promise<T> {
  await acquire();
  try {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const { transient, retryAfterMs } = classify(err);
        if (!transient || attempt === MAX_ATTEMPTS) throw err;
        const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
        const honored = retryAfterMs !== undefined ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : 0;
        // Jitter matters more than the base delay here: without it, the pages
        // that got 429'd together also retry together.
        const delay = Math.max(backoff, honored) + Math.random() * 400;
        console.warn(
          `[subgraph:${label}] attempt ${attempt}/${MAX_ATTEMPTS} failed${
            retryAfterMs !== undefined ? ` (retry-after ${Math.round(retryAfterMs)}ms)` : ""
          }; retrying in ${Math.round(delay)}ms`,
        );
        await sleep(delay);
      }
    }
    throw lastErr;
  } finally {
    release();
  }
}

/** Exposed for tests and for logging the effective limit. */
export const subgraphGateConfig = { maxConcurrency: MAX_CONCURRENCY, maxAttempts: MAX_ATTEMPTS };
