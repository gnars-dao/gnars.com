BEGIN;

CREATE TABLE IF NOT EXISTS public.marketplace_trait_snapshots (
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  collection_address TEXT NOT NULL CHECK (collection_address ~ '^0x[0-9a-f]{40}$'),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_number NUMERIC(78, 0) NOT NULL CHECK (block_number >= 0),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, collection_address, block_hash)
);
CREATE INDEX IF NOT EXISTS marketplace_trait_snapshots_latest
  ON public.marketplace_trait_snapshots (chain_id, collection_address, block_number DESC);

CREATE OR REPLACE FUNCTION public.marketplace_trait_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Published marketplace trait snapshots are immutable';
END;
$$;
DROP TRIGGER IF EXISTS marketplace_trait_snapshot_immutable ON public.marketplace_trait_snapshots;
CREATE TRIGGER marketplace_trait_snapshot_immutable
  BEFORE UPDATE OR DELETE ON public.marketplace_trait_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.marketplace_trait_snapshot_immutable();
REVOKE ALL ON FUNCTION public.marketplace_trait_snapshot_immutable() FROM PUBLIC, anon, authenticated, service_role, gnars_marketplace;

ALTER TABLE public.marketplace_trait_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketplace_trait_snapshots FROM PUBLIC, anon, authenticated, service_role, gnars_marketplace;
GRANT SELECT ON public.marketplace_trait_snapshots TO gnars_marketplace;
DROP POLICY IF EXISTS marketplace_backend_trait_snapshots ON public.marketplace_trait_snapshots;
CREATE POLICY marketplace_backend_trait_snapshots ON public.marketplace_trait_snapshots
  FOR SELECT TO gnars_marketplace USING (true);

COMMIT;
