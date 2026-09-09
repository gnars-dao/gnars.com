type ConfirmationAttempt = {
  id: string;
  txHash?: string;
  transactionIntent?: unknown;
  transactionFailed?: boolean;
  error?: { code: string; retryable?: boolean };
  phase: string;
};

export const confirmationPendingError = {
  code: "CONFIRMATION_PENDING",
  message: "Waiting for Base transaction confirmation",
  retryable: true,
} as const;

export function confirmationAttemptKey(attempt: ConfirmationAttempt | null): string | null {
  return attempt?.txHash &&
    attempt.transactionIntent &&
    !attempt.transactionFailed &&
    attempt.error?.code !== "TRANSACTION_MISMATCH" &&
    ["pending", "confirming", "unknown"].includes(attempt.phase)
    ? `${attempt.id}:${attempt.txHash.toLowerCase()}`
    : null;
}

/** One read-only retry loop per account, shared by every mounted marketplace surface. */
export function createConfirmationRecovery({
  attempt,
  check,
  changed,
  durationMs = 120_000,
}: {
  attempt: () => string | null;
  check: () => Promise<void>;
  changed: (active: boolean) => void;
  durationMs?: number;
}) {
  let consumers = 0;
  let visible = true;
  let active = false;
  let running = false;
  let identity: string | null = null;
  let deadline = 0;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  const status = (next: boolean) => {
    if (active === next) return;
    active = next;
    changed(next);
  };
  const clear = () => {
    clearTimeout(timer);
    clearTimeout(expiry);
    timer = expiry = undefined;
  };
  const refresh = () => {
    const next = attempt();
    if (next !== identity) {
      clear();
      identity = next;
      deadline = Date.now() + durationMs;
      retries = 0;
    }
    if (!identity || !consumers || !visible || Date.now() >= deadline) {
      clear();
      status(false);
      return;
    }
    status(true);
    if (!expiry) expiry = setTimeout(refresh, Math.max(1, deadline - Date.now()));
    if (running || timer) return;
    const delay = Math.min(1500 * 2 ** retries, 15_000);
    timer = setTimeout(
      async () => {
        timer = undefined;
        if (!consumers || !visible || Date.now() >= deadline || attempt() !== identity) {
          refresh();
          return;
        }
        running = true;
        retries++;
        try {
          await check();
        } catch {
          // The caller records actionable errors; a failed read must not orphan this loop.
        } finally {
          running = false;
          refresh();
        }
      },
      Math.min(delay, Math.max(1, deadline - Date.now())),
    );
  };
  return {
    refresh,
    retain() {
      consumers++;
      refresh();
      return () => {
        consumers--;
        refresh();
      };
    },
    setVisible(value: boolean) {
      visible = value;
      refresh();
    },
  };
}
