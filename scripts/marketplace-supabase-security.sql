ALTER TABLE public.marketplace_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.marketplace_orders, public.marketplace_rate_limits
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.marketplace_orders_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

GRANT CONNECT ON DATABASE postgres TO gnars_marketplace;
GRANT USAGE ON SCHEMA public TO gnars_marketplace;
GRANT SELECT, INSERT, UPDATE ON public.marketplace_orders TO gnars_marketplace;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_rate_limits TO gnars_marketplace;
GRANT USAGE ON SEQUENCE public.marketplace_orders_id_seq TO gnars_marketplace;

CREATE POLICY marketplace_backend_orders ON public.marketplace_orders
  FOR ALL TO gnars_marketplace USING (true) WITH CHECK (true);
CREATE POLICY marketplace_backend_budgets ON public.marketplace_rate_limits
  FOR ALL TO gnars_marketplace USING (true) WITH CHECK (true);
