-- Production safety hardening
-- Run this in the Supabase SQL editor before or with the next production deploy.

-- Required columns used by the application.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS duration_minutes integer DEFAULT 60;

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS reminder_sent boolean DEFAULT false;

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS admin_note text;

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS payment_synced_at timestamptz;

-- Prevent exact double-booking for the same shop/date/start time.
-- The server also checks overlapping durations, but this protects against
-- simultaneous requests that reach the database at the same moment.
CREATE UNIQUE INDEX IF NOT EXISTS reservations_unique_confirmed_start
  ON reservations (shop_id, reservation_date, reservation_time)
  WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS reservations_shop_date_status_idx
  ON reservations (shop_id, reservation_date, status);

CREATE INDEX IF NOT EXISTS conversations_user_shop_created_idx
  ON conversations (line_user_id, shop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS customer_cartes_shop_visit_idx
  ON customer_cartes (shop_id, visit_count DESC);

CREATE TABLE IF NOT EXISTS ops_events (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL CHECK (level IN ('info', 'warn', 'error', 'critical')),
  type text NOT NULL,
  message text NOT NULL,
  shop_id uuid,
  meta jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ops_events_created_idx
  ON ops_events (created_at DESC);

CREATE INDEX IF NOT EXISTS ops_events_shop_created_idx
  ON ops_events (shop_id, created_at DESC);

-- This app talks to Supabase with the server-side service role key.
-- Direct browser access to public tables should stay closed.
ALTER TABLE IF EXISTS shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS customer_cartes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ops_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS session ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_shops ON shops;
CREATE POLICY service_role_all_shops ON shops
  FOR ALL TO public
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS service_role_all_reservations ON reservations;
CREATE POLICY service_role_all_reservations ON reservations
  FOR ALL TO public
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS service_role_all_conversations ON conversations;
CREATE POLICY service_role_all_conversations ON conversations
  FOR ALL TO public
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS service_role_all_templates ON templates;
CREATE POLICY service_role_all_templates ON templates
  FOR ALL TO public
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS service_role_all_customer_cartes ON customer_cartes;
CREATE POLICY service_role_all_customer_cartes ON customer_cartes
  FOR ALL TO public
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS service_role_all_ops_events ON ops_events;
CREATE POLICY service_role_all_ops_events ON ops_events
  FOR ALL TO public
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS service_role_all_session ON session;
CREATE POLICY service_role_all_session ON session
  FOR ALL TO public
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');
