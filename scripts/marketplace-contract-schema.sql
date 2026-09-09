BEGIN;

-- A separate protocol namespace preserves every existing canonical Seaport order.
CREATE TABLE IF NOT EXISTS public.marketplace_contract_orders (
  id BIGSERIAL UNIQUE NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  protocol_address TEXT NOT NULL CHECK (
    protocol_address ~ '^0x[0-9a-f]{40}$' AND protocol_address NOT IN (
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000068f116a894984e2db1123eb395',
      '0x1e0049783f008a0085193e00003d00cd54003c71'
    )
  ),
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
  PRIMARY KEY (chain_id, protocol_address, order_hash)
);

CREATE INDEX IF NOT EXISTS marketplace_contract_orders_live_page
  ON public.marketplace_contract_orders (protocol_address, id DESC)
  WHERE status IN ('active', 'invalid-owner', 'unapproved');
CREATE INDEX IF NOT EXISTS marketplace_contract_orders_seller
  ON public.marketplace_contract_orders (seller, expires_at);
CREATE INDEX IF NOT EXISTS marketplace_contract_orders_live_token
  ON public.marketplace_contract_orders (protocol_address, token_id, price_wei, id DESC)
  WHERE status IN ('active', 'invalid-owner', 'unapproved');

ALTER TABLE public.marketplace_contract_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketplace_contract_orders FROM PUBLIC, anon, authenticated, service_role, gnars_marketplace;
REVOKE ALL ON SEQUENCE public.marketplace_contract_orders_id_seq FROM PUBLIC, anon, authenticated, service_role, gnars_marketplace;
GRANT SELECT, INSERT ON public.marketplace_contract_orders TO gnars_marketplace;
GRANT UPDATE (status, checked_at) ON public.marketplace_contract_orders TO gnars_marketplace;
GRANT USAGE ON SEQUENCE public.marketplace_contract_orders_id_seq TO gnars_marketplace;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'marketplace_contract_orders'
      AND policyname = 'marketplace_backend_contract_orders'
  ) THEN
    CREATE POLICY marketplace_backend_contract_orders ON public.marketplace_contract_orders
      FOR ALL TO gnars_marketplace USING (true) WITH CHECK (true);
  END IF;
END;
$$;

COMMIT;
