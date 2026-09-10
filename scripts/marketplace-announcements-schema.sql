BEGIN;

CREATE TABLE IF NOT EXISTS public.marketplace_announcements (
  chain_id integer NOT NULL CHECK (chain_id = 8453),
  protocol_address text NOT NULL CHECK (protocol_address ~ '^0x[0-9a-f]{40}$'),
  order_hash text NOT NULL CHECK (order_hash ~ '^0x[0-9a-f]{64}$'),
  event text NOT NULL CHECK (event = 'listed'),
  idem varchar(16) NOT NULL UNIQUE,
  signer_uuid uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'retryable', 'ambiguous', 'blocked', 'manual_review')),
  cast_hash text CHECK (cast_hash IS NULL OR cast_hash ~ '^0x[0-9a-f]{40}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  first_post_at timestamptz,
  uncertain_since timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, protocol_address, order_hash, event)
);

ALTER TABLE public.marketplace_announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketplace_announcements FROM PUBLIC, anon, authenticated, service_role, gnars_marketplace;
GRANT SELECT, INSERT ON public.marketplace_announcements TO gnars_marketplace;
GRANT UPDATE (status, cast_hash, attempts, lease_token, lease_until, first_post_at, uncertain_since, next_attempt_at, last_error_code, updated_at)
  ON public.marketplace_announcements TO gnars_marketplace;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'marketplace_announcements' AND policyname = 'marketplace_announcements_runtime'
  ) THEN
    CREATE POLICY marketplace_announcements_runtime ON public.marketplace_announcements
      FOR ALL TO gnars_marketplace USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;
