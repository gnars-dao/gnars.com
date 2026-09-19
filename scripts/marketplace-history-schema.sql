BEGIN;

CREATE TABLE IF NOT EXISTS public.marketplace_history_checkpoints (
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  protocol_address TEXT NOT NULL CHECK (protocol_address ~ '^0x[0-9a-f]{40}$'),
  deployment_hash TEXT NOT NULL CHECK (deployment_hash ~ '^0x[0-9a-f]{64}$'),
  start_block NUMERIC(78,0) NOT NULL CHECK (start_block >= 0),
  indexed_through NUMERIC(78,0),
  block_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, protocol_address),
  CHECK ((indexed_through IS NULL AND block_hash IS NULL) OR
    (indexed_through IS NOT NULL AND indexed_through >= start_block AND block_hash IS NOT NULL AND block_hash ~ '^0x[0-9a-f]{64}$'))
);
ALTER TABLE public.marketplace_history_checkpoints
  ADD COLUMN IF NOT EXISTS finalized_target NUMERIC(78,0) CHECK (finalized_target >= 0);

CREATE TABLE IF NOT EXISTS public.marketplace_history_events (
  chain_id INTEGER NOT NULL,
  protocol_address TEXT NOT NULL,
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  block_number NUMERIC(78,0) NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  collection_address TEXT CHECK (collection_address ~ '^0x[0-9a-f]{40}$'),
  token_id NUMERIC(78,0) CHECK (token_id >= 0),
  event JSONB NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  PRIMARY KEY (chain_id, protocol_address, transaction_hash, log_index),
  UNIQUE (chain_id, protocol_address, block_number, log_index),
  FOREIGN KEY (chain_id, protocol_address) REFERENCES public.marketplace_history_checkpoints,
  CHECK ((collection_address IS NULL) = (token_id IS NULL))
);
CREATE INDEX IF NOT EXISTS marketplace_history_nft_activity
  ON public.marketplace_history_events (chain_id, protocol_address, collection_address, token_id, block_number DESC, log_index DESC)
  WHERE collection_address IS NOT NULL;

ALTER TABLE public.marketplace_history_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_history_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketplace_history_checkpoints, public.marketplace_history_events
  FROM PUBLIC, anon, authenticated, service_role, gnars_marketplace;
GRANT SELECT ON public.marketplace_history_checkpoints, public.marketplace_history_events TO gnars_marketplace;
DROP POLICY IF EXISTS marketplace_backend_history_checkpoints ON public.marketplace_history_checkpoints;
CREATE POLICY marketplace_backend_history_checkpoints ON public.marketplace_history_checkpoints
  FOR SELECT TO gnars_marketplace USING (true);
DROP POLICY IF EXISTS marketplace_backend_history_events ON public.marketplace_history_events;
CREATE POLICY marketplace_backend_history_events ON public.marketplace_history_events
  FOR SELECT TO gnars_marketplace USING (true);

COMMIT;
