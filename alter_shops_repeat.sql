-- repeat_message_enabled カラム追加
-- 実行前に確認:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'shops' AND column_name = 'repeat_message_enabled';

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS repeat_message_enabled boolean DEFAULT true;
