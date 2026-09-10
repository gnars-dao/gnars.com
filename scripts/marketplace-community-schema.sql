BEGIN;

CREATE TABLE IF NOT EXISTS public.marketplace_community_orders (
  id BIGSERIAL UNIQUE NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  protocol_address TEXT NOT NULL CHECK (protocol_address ~ '^0x[0-9a-f]{40}$'),
  order_hash TEXT NOT NULL CHECK (order_hash ~ '^0x[0-9a-f]{64}$'),
  collection_address TEXT NOT NULL CHECK (collection_address ~ '^0x[0-9a-f]{40}$'),
  token_id NUMERIC(78, 0) NOT NULL CHECK (token_id >= 0),
  seller TEXT NOT NULL CHECK (seller ~ '^0x[0-9a-f]{40}$'),
  price_wei NUMERIC(78, 0) NOT NULL CHECK (price_wei > 0),
  expires_at BIGINT NOT NULL,
  signed_order JSONB NOT NULL,
  fee_policy JSONB NOT NULL,
  metadata JSONB NOT NULL,
  eligibility_balance NUMERIC(78, 0) NOT NULL CHECK (eligibility_balance >= 6),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'filled', 'expired', 'invalid-owner', 'unapproved', 'invalid-counter')),
  hidden BOOLEAN NOT NULL DEFAULT false,
  moderation_revision INTEGER NOT NULL DEFAULT 0 CHECK (moderation_revision >= 0),
  moderated_by TEXT CHECK (moderated_by ~ '^0x[0-9a-f]{40}$'),
  moderation_reason TEXT CHECK (length(moderation_reason) <= 500),
  moderated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, protocol_address, order_hash)
);

CREATE INDEX IF NOT EXISTS marketplace_community_live_page
  ON public.marketplace_community_orders (protocol_address, id DESC)
  WHERE NOT hidden AND status IN ('active', 'invalid-owner', 'unapproved');
CREATE INDEX IF NOT EXISTS marketplace_community_live_token
  ON public.marketplace_community_orders (protocol_address, collection_address, token_id, price_wei, id DESC)
  WHERE NOT hidden AND status IN ('active', 'invalid-owner', 'unapproved');
CREATE INDEX IF NOT EXISTS marketplace_community_seller
  ON public.marketplace_community_orders (seller, expires_at);

CREATE TABLE IF NOT EXISTS public.marketplace_community_moderation (
  nonce UUID PRIMARY KEY,
  actor TEXT NOT NULL CHECK (actor ~ '^0x[0-9a-f]{40}$'),
  chain_id INTEGER NOT NULL DEFAULT 8453 CHECK (chain_id = 8453),
  protocol_address TEXT NOT NULL CHECK (protocol_address ~ '^0x[0-9a-f]{40}$'),
  order_hash TEXT NOT NULL CHECK (order_hash ~ '^0x[0-9a-f]{64}$'),
  action TEXT NOT NULL CHECK (action IN ('hide', 'restore')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  reason TEXT NOT NULL CHECK (length(reason) <= 500),
  wallet_authorization JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (chain_id, protocol_address, order_hash) REFERENCES public.marketplace_community_orders (chain_id, protocol_address, order_hash)
);

ALTER TABLE public.marketplace_community_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_community_moderation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketplace_community_orders, public.marketplace_community_moderation FROM PUBLIC, anon, authenticated, service_role, gnars_marketplace;
REVOKE ALL ON SEQUENCE public.marketplace_community_orders_id_seq FROM PUBLIC, anon, authenticated, service_role, gnars_marketplace;
GRANT SELECT, INSERT ON public.marketplace_community_orders, public.marketplace_community_moderation TO gnars_marketplace;
GRANT UPDATE (status, checked_at, hidden, moderation_revision, moderated_by, moderation_reason, moderated_at) ON public.marketplace_community_orders TO gnars_marketplace;
GRANT UPDATE (metadata) ON public.marketplace_community_orders TO gnars_marketplace;
GRANT USAGE ON SEQUENCE public.marketplace_community_orders_id_seq TO gnars_marketplace;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'marketplace_community_orders' AND policyname = 'marketplace_backend_community_orders') THEN
    CREATE POLICY marketplace_backend_community_orders ON public.marketplace_community_orders FOR ALL TO gnars_marketplace USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'marketplace_community_moderation' AND policyname = 'marketplace_backend_community_moderation') THEN
    CREATE POLICY marketplace_backend_community_moderation ON public.marketplace_community_moderation FOR ALL TO gnars_marketplace USING (true) WITH CHECK (true);
  END IF;
END;
$$;

COMMIT;
