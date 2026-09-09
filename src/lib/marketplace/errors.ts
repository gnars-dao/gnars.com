export class MarketplaceApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly status: number;

  constructor(options: {
    message: string;
    code: string;
    retryable: boolean;
    status: number;
    requestId?: string;
  }) {
    super(options.message);
    this.name = "MarketplaceApiError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

/** Older deployments may return only an error string; preserve that compatibility. */
export function parseMarketplaceApiError(body: unknown, status: number): MarketplaceApiError {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return new MarketplaceApiError({
    message:
      typeof data.error === "string" ? data.error.slice(0, 500) : "Marketplace request failed.",
    code:
      typeof data.code === "string" && /^[A-Z_]{1,80}$/.test(data.code)
        ? data.code
        : "REQUEST_FAILED",
    retryable:
      typeof data.retryable === "boolean" ? data.retryable : status === 429 || status >= 500,
    status,
    requestId:
      typeof data.requestId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(data.requestId)
        ? data.requestId
        : undefined,
  });
}
