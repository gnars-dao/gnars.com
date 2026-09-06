CREATE TABLE IF NOT EXISTS marketplace_orders (
  id BIGSERIAL UNIQUE NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  order_hash TEXT NOT NULL CHECK (order_hash ~ '^0x[0-9a-f]{64}$'),
  token_id NUMERIC(78, 0) NOT NULL CHECK (token_id >= 0),
  seller TEXT NOT NULL CHECK (seller ~ '^0x[0-9a-f]{40}$'),
  price_wei NUMERIC(78, 0) NOT NULL CHECK (price_wei > 0),
  expires_at BIGINT NOT NULL,
  signed_order JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'filled', 'expired', 'invalid-owner', 'unapproved', 'invalid-counter')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, order_hash)
);

CREATE INDEX IF NOT EXISTS marketplace_orders_live_page
  ON marketplace_orders (id DESC) WHERE status IN ('active', 'invalid-owner', 'unapproved');
CREATE INDEX IF NOT EXISTS marketplace_orders_seller ON marketplace_orders (seller, expires_at);

CREATE TABLE IF NOT EXISTS marketplace_rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL CHECK (hits > 0),
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS marketplace_rate_limits_expiry ON marketplace_rate_limits (expires_at);
