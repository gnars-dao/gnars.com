-- Apply after the history and trait schemas. No login/password is created.
-- Grant this role only to a dedicated worker login, never to the web runtime.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gnars_marketplace_indexer') THEN
    CREATE ROLE gnars_marketplace_indexer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO gnars_marketplace_indexer;
GRANT SELECT, INSERT ON public.marketplace_history_events TO gnars_marketplace_indexer;
GRANT SELECT, INSERT, UPDATE ON public.marketplace_history_checkpoints TO gnars_marketplace_indexer;
GRANT SELECT, INSERT ON public.marketplace_trait_snapshots TO gnars_marketplace_indexer;

DROP POLICY IF EXISTS marketplace_indexer_traits_read ON public.marketplace_trait_snapshots;
CREATE POLICY marketplace_indexer_traits_read ON public.marketplace_trait_snapshots
  FOR SELECT TO gnars_marketplace_indexer USING (true);
DROP POLICY IF EXISTS marketplace_indexer_traits_insert ON public.marketplace_trait_snapshots;
CREATE POLICY marketplace_indexer_traits_insert ON public.marketplace_trait_snapshots
  FOR INSERT TO gnars_marketplace_indexer WITH CHECK (true);

DROP POLICY IF EXISTS marketplace_indexer_events_read ON public.marketplace_history_events;
CREATE POLICY marketplace_indexer_events_read ON public.marketplace_history_events
  FOR SELECT TO gnars_marketplace_indexer USING (true);
DROP POLICY IF EXISTS marketplace_indexer_events_insert ON public.marketplace_history_events;
CREATE POLICY marketplace_indexer_events_insert ON public.marketplace_history_events
  FOR INSERT TO gnars_marketplace_indexer WITH CHECK (true);
DROP POLICY IF EXISTS marketplace_indexer_checkpoints_read ON public.marketplace_history_checkpoints;
CREATE POLICY marketplace_indexer_checkpoints_read ON public.marketplace_history_checkpoints
  FOR SELECT TO gnars_marketplace_indexer USING (true);
DROP POLICY IF EXISTS marketplace_indexer_checkpoints_insert ON public.marketplace_history_checkpoints;
CREATE POLICY marketplace_indexer_checkpoints_insert ON public.marketplace_history_checkpoints
  FOR INSERT TO gnars_marketplace_indexer WITH CHECK (true);
DROP POLICY IF EXISTS marketplace_indexer_checkpoints_update ON public.marketplace_history_checkpoints;
CREATE POLICY marketplace_indexer_checkpoints_update ON public.marketplace_history_checkpoints
  FOR UPDATE TO gnars_marketplace_indexer USING (true) WITH CHECK (true);
COMMIT;
