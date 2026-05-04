# Smart Reservation Pro

LINE customers can book, cancel, and check reservations through an automated
reservation assistant. The service uses Express, LINE Messaging API, a message
processing provider, Supabase, Paddle, Google OAuth, and Resend email delivery.

## Structure

- `index.js` - Express server, API routes, LINE webhook, Paddle webhook, cron jobs.
- `public/index.html` - public landing page, Google login, shop registration, payment flow.
- `public/shop-dashboard.html` - shop owner dashboard.
- `public/dashboard.html` - admin dashboard.
- `*.sql` - Supabase schema and production hardening SQL.
- `test_ai_quality.js` - automated response quality test script.

## Required Environment Variables

```text
SESSION_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
ADMIN_PASSWORD
PADDLE_WEBHOOK_SECRET
```

Optional:

```text
RESEND_API_KEY
CALENDAR_TOKEN_SECRET
PADDLE_API_KEY
PADDLE_ENV
PADDLE_API_BASE
ALERT_WEBHOOK_URL
ALERT_EMAIL
ENABLE_LINE_PUSH_REMINDERS
PORT
NODE_ENV
```

Use a long random value for `SESSION_SECRET`, `ADMIN_PASSWORD`, and
`CALENDAR_TOKEN_SECRET`. If `CALENDAR_TOKEN_SECRET` is omitted, the app falls
back to `SESSION_SECRET`.

`ENABLE_LINE_PUSH_REMINDERS` is off by default. Set it to `true` only when the
LINE plan and message quota can safely cover reminder push messages.

## Local Run

```bash
npm install
node index.js
```

The server starts on `http://localhost:3000` unless `PORT` is set.

## Supabase Setup

Apply SQL files in this order when preparing production:

1. `add_features.sql`
2. `alter_shops_repeat.sql`
3. `production_safety.sql`

`production_safety.sql` adds reservation indexes, duplicate booking protection,
operation event logging, admin support notes, payment sync timestamps, and RLS
on public tables. This app uses the Supabase service role key on the server, so
browser clients should not access Supabase tables directly.

## Operations

- `GET /health` returns a lightweight health check for uptime and database access.
- `GET /api/admin/ops` powers the admin operations dashboard.
- `POST /api/admin/sync-payments` syncs Paddle subscription status when
  `PADDLE_API_KEY` is configured.
- `GET /api/admin/backup` exports a JSON backup of core tables.
- `POST /api/admin/restore` validates a backup first. Send `confirm: "RESTORE"`
  to upsert restorable rows.

Alerts are sent through `ALERT_WEBHOOK_URL`, or through `ALERT_EMAIL` when
`RESEND_API_KEY` is also configured. Warning, error, and critical operation
events are stored in `ops_events` when `production_safety.sql` has been applied.

## Production Checks

Before deploy:

```bash
node --check index.js
npm audit --audit-level=moderate
```

After deploy:

- Confirm LINE webhook responds successfully.
- Confirm Paddle webhook signature validation succeeds.
- Confirm a shop dashboard calendar URL works with the generated long token.
- Confirm duplicate reservations for the same shop/date/time are rejected.
