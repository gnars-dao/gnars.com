-- Run once against the checkout database before enabling live checkout.
CREATE TABLE IF NOT EXISTS store_payment_claims (
  chain_id integer NOT NULL,
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  payer text NOT NULL CHECK (payer ~ '^0x[0-9a-f]{40}$'),
  payload_digest text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (chain_id, tx_hash)
);
