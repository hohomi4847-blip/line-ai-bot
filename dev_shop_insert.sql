-- 開発者テスト店舗 INSERT
-- 実行前に既存レコードを確認:
--   SELECT * FROM shops WHERE owner_email = 'hohomi4847@gmail.com';
--
-- 既存レコードがある場合は UPDATE を使用:
--   UPDATE shops
--   SET shop_name = '🔧 開発者テスト（削除禁止）',
--       business_type = 'beauty_salon',
--       is_paid = true,
--       plan_status = 'active'
--   WHERE owner_email = 'hohomi4847@gmail.com';
--
-- 存在しない場合は以下の INSERT を実行:

INSERT INTO shops (
  owner_email,
  shop_name,
  business_type,
  is_paid,
  plan_status,
  line_channel_secret,
  line_channel_access_token,
  trial_started_at,
  created_at,
  updated_at
)
SELECT
  'hohomi4847@gmail.com',
  '🔧 開発者テスト（削除禁止）',
  'beauty_salon',
  true,
  'active',
  '',
  '',
  NOW(),
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM shops WHERE owner_email = 'hohomi4847@gmail.com'
);
