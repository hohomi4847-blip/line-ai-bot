'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test_secret';
process.env.GOOGLE_CLIENT_ID = 'test_google_id';
process.env.GOOGLE_CLIENT_SECRET = 'test_google_secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_service_role_key';
process.env.ANTHROPIC_API_KEY = 'test_anthropic_key';
process.env.ADMIN_PASSWORD = 'test_admin_password';
process.env.PADDLE_WEBHOOK_SECRET = 'test_paddle_secret';

const assert = require('assert');
const {
  normalizeTime,
  isValidDateString,
  validateReservationFields,
  getBusinessSlotIssue,
  isReservationIntentText,
  isUnresolvedAssistantText,
  isResolvedAssistantText,
  buildSystemHealth,
  sanitizeBusinessHours,
  sanitizeMenuItems,
} = require('./index');

const shop = {
  business_hours: {
    mon: { open: '09:00', close: '18:00', closed: false },
    tue: { open: '09:00', close: '18:00', closed: false },
    wed: { open: '09:00', close: '18:00', closed: false },
    thu: { open: '09:00', close: '18:00', closed: false },
    fri: { open: '09:00', close: '18:00', closed: false },
    sat: { open: '10:00', close: '15:00', closed: false },
    sun: { open: '09:00', close: '18:00', closed: true },
  },
  closed_days: ['2026-05-06'],
  menu_items: [{ name: 'カット', duration: 60, price: 5000 }],
  reservation_interval: 60,
};

assert.strictEqual(normalizeTime('9:05'), '09:05');
assert.strictEqual(normalizeTime('25:00'), null);
assert.strictEqual(normalizeTime('12:99'), null);

assert.strictEqual(isValidDateString('2026-05-11'), true);
assert.strictEqual(isValidDateString('2026-02-30'), false);
assert.strictEqual(isValidDateString('2026-13-01'), false);

assert.strictEqual(getBusinessSlotIssue(shop, '2026-05-11', '10:00', 60), null);
assert.strictEqual(getBusinessSlotIssue(shop, '2026-05-03', '10:00', 60), 'closed_day');
assert.strictEqual(getBusinessSlotIssue(shop, '2026-05-06', '10:00', 60), 'closed_day');
assert.strictEqual(getBusinessSlotIssue(shop, '2026-05-11', '18:00', 60), 'outside_hours');

const valid = validateReservationFields(shop, {
  name: '山田太郎',
  service: 'カット',
  date: '2026-05-11',
  time: '10:00',
});
assert.strictEqual(valid.ok, true);
assert.strictEqual(valid.time, '10:00');
assert.strictEqual(valid.durationMinutes, 60);

assert.strictEqual(validateReservationFields(shop, {
  name: 'お客様',
  service: 'カット',
  date: '2026-05-11',
  time: '10:00',
}).ok, false);

assert.strictEqual(validateReservationFields(shop, {
  name: '山田太郎',
  service: 'カット',
  date: '2026-05-11',
  time: '18:00',
}).ok, false);

assert.strictEqual(isReservationIntentText('明日の空きはありますか？'), true);
assert.strictEqual(isUnresolvedAssistantText('ご希望のメニューを教えてください。'), true);
assert.strictEqual(isResolvedAssistantText('ご予約を承りました！'), true);

assert.deepStrictEqual(sanitizeBusinessHours({
  mon: { open: '9:00', close: '18:00', closed: false },
}).mon, { open: '09:00', close: '18:00', closed: false });
assert.strictEqual(sanitizeBusinessHours({ mon: { open: '18:00', close: '09:00', closed: false } }), null);
assert.strictEqual(sanitizeMenuItems([{ name: 'カット', price: 5000, duration: 60 }])[0].duration, 60);

const health = buildSystemHealth({
  integrations: { alerts: true, paddleApi: true },
  metrics: { autoResponseErrors24h: 0, unresolvedConsultations: 0 },
  recentEvents: [],
});
assert.strictEqual(health.status, 'ok');

console.log('reservation safety tests passed');
