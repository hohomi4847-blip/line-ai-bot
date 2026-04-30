-- Google Review + Customer Carte feature columns
-- Run in Supabase SQL editor before deploying

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS google_review_url text;

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS review_request_enabled boolean DEFAULT false;

CREATE TABLE IF NOT EXISTS customer_cartes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  shop_id uuid REFERENCES shops(id),
  line_user_id text NOT NULL,
  customer_name text,
  visit_count integer DEFAULT 0,
  last_visit_date date,
  memo text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(shop_id, line_user_id)
);
