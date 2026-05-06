require('dotenv').config();
const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const helmet = require('helmet');
const ical = require('ical-generator').default;
const cron = require('node-cron');

// ✅ 필수 환경변수 — 미설정 시 즉시 종료 (fallback 없음)
const REQUIRED_ENV = [
  'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY',
  'ADMIN_PASSWORD', 'PADDLE_WEBHOOK_SECRET',
];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`❌ 필수 환경변수 미설정: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const app = express();

// ✅ Railway 리버스 프록시 신뢰 설정 (rate limit IP 정확도)
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// ✅ Paddle webhook은 raw body 필요 - 반드시 먼저
app.use('/paddle/webhook', express.raw({ type: 'application/json' }));

function preserveRawBody(req, _res, buf) {
  if (req.originalUrl && req.originalUrl.startsWith('/webhook/')) {
    req.rawBody = buf;
  }
}

app.use(cookieParser());
app.use(express.json({ limit: '10mb', verify: preserveRawBody }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const JWT_SECRET = process.env.SESSION_SECRET; // fallback 없음 — 위 REQUIRED_ENV 검증으로 보장
const JWT_EXPIRES = '7d';
const CALENDAR_TOKEN_SECRET = process.env.CALENDAR_TOKEN_SECRET || JWT_SECRET;
const STARTED_AT = new Date();
const OPS_EVENTS_LIMIT = 300;
const opsEvents = [];
const alertCooldowns = new Map();

function isAlertConfigured() {
  return Boolean(process.env.ALERT_WEBHOOK_URL || (process.env.ALERT_EMAIL && process.env.RESEND_API_KEY));
}

// ✅ JWT 쿠키 발급 함수
function issueJWT(res, user) {
  const token = jwt.sign(
    { email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7일
  });
}

// ✅ JWT 검증 미들웨어
function verifyJWT(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    req.user = null;
    res.clearCookie('auth_token');
  }
  next();
}

app.use(verifyJWT);

function makeCalendarToken(shop) {
  return crypto
    .createHmac('sha256', CALENDAR_TOKEN_SECRET)
    .update(`${shop.id}:${shop.owner_email}`)
    .digest('hex');
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// ✅ JWT 필수 미들웨어 (미인증 시 401)
function requireJWT(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '認証が必要です' });
  next();
}

// ✅ Passport 초기화 (세션 없이 사용)
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://line-ai-bot-production-2d6d.up.railway.app/auth/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    const name = profile.displayName;
    done(null, { email, name });
  } catch (err) {
    done(err, null);
  }
}));

// ✅ 세션 없이 Passport 사용
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());

// ✅ 운영자 인증 미들웨어
// query string 지원 제거 — 서버 로그에 패스워드 평문 노출 방지
function adminAuth(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const current = adminAttempts.get(key);
  if (current?.lockedUntil && current.lockedUntil > now) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらくしてから再試行してください。' });
  }

  const pw = req.headers['x-admin-password'];
  if (!pw || pw !== process.env.ADMIN_PASSWORD) {
    const failed = (current?.failed || 0) + 1;
    adminAttempts.set(key, {
      failed: failed >= 5 ? 0 : failed,
      lockedUntil: failed >= 5 ? now + 30 * 60 * 1000 : 0,
    });
    return res.status(401).json({ error: '認証が必要です' });
  }
  adminAttempts.delete(key);
  next();
}

const adminAttempts = new Map();

// ✅ 입력값 검증
function validateRegisterInput({ email, shopName, businessType, channelSecret, channelToken }) {
  if (!email || !shopName || !businessType || !channelSecret || !channelToken) return false;
  if (typeof email !== 'string' || !email.includes('@')) return false;
  if (shopName.length > 100) return false;
  return true;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function sanitizeBusinessHours(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowedDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const result = {};
  for (const day of allowedDays) {
    const item = value[day];
    if (!item || typeof item !== 'object') continue;
    const open = normalizeTime(item.open || '09:00');
    const close = normalizeTime(item.close || '19:00');
    const closed = Boolean(item.closed);
    if (!closed && (!open || !close || open >= close)) return null;
    result[day] = { open: open || '09:00', close: close || '19:00', closed };
  }
  return Object.keys(result).length > 0 ? result : null;
}

function sanitizeMenuItems(value) {
  if (!Array.isArray(value)) return null;
  const items = [];
  for (const item of value.slice(0, 80)) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim().slice(0, 80);
    if (!name) continue;
    const price = Number(item.price);
    const duration = Number(item.duration);
    items.push({
      name,
      price: Number.isFinite(price) && price >= 0 && price <= 10000000 ? Math.round(price) : 0,
      duration: Number.isFinite(duration) && duration > 0 && duration <= 480 ? Math.round(duration) : 60,
    });
  }
  return items;
}

function sanitizeClosedDays(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter(isValidDateString))].slice(0, 365);
}

// ✅ iCal 텍스트 정제 (HTML 이스케이프 금지 — iCal은 평문, 라이브러리가 자체 처리)
function sanitizeIcalText(str) {
  if (!str) return '';
  return String(str).replace(/[\r\n\t]/g, ' ').slice(0, 200);
}

// ✅ 시간 정규화
function normalizeTime(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).trim().split(':');
  if (parts.length < 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function isValidDateString(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

// ✅ 과거 날짜 체크
function isPastDate(date, time) {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStr = jstNow.toISOString().split('T')[0];
  if (date < todayStr) return true;
  if (date === todayStr) {
    const currentTime = jstNow.toISOString().split('T')[1].slice(0, 5);
    if (time <= currentTime) return true;
  }
  return false;
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function getBusinessSlotIssue(shop, date, time, durationMinutes) {
  if (!isValidDateString(date)) return 'invalid_date';
  const normalizedTime = normalizeTime(time);
  if (!normalizedTime) return 'invalid_time';
  const dayKeys = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayKey = dayKeys[new Date(`${date}T00:00:00+09:00`).getDay()];
  const hours = shop?.business_hours?.[dayKey];
  if (Array.isArray(shop?.closed_days) && shop.closed_days.includes(date)) return 'closed_day';
  if (!hours || hours.closed) return 'closed_day';
  const open = normalizeTime(hours.open || '10:00');
  const close = normalizeTime(hours.close || '19:00');
  if (!open || !close || open >= close) return 'invalid_hours';
  const start = timeToMinutes(normalizedTime);
  const end = start + (Number(durationMinutes) || 60);
  if (start < timeToMinutes(open) || end > timeToMinutes(close)) return 'outside_hours';
  return null;
}

function businessSlotIssueMessage(issue, date, time) {
  const dayJa = isValidDateString(date) ? getDayJa(date) : '';
  if (issue === 'closed_day') return `${date}（${dayJa}）は定休日となっております。別の日程をお知らせください。`;
  if (issue === 'outside_hours') return `${date} ${time}は営業時間外です。営業時間内のお時間をお知らせください。`;
  if (issue === 'invalid_hours') return '店舗の営業時間設定を確認できませんでした。恐れ入りますが、別のお時間でお問い合わせください。';
  if (issue === 'invalid_time') return 'ご予約の時間を正しくお知らせください。（例：14:00）';
  return 'ご予約の日付を正しくお知らせください。（例：2026-05-01）';
}

function validateReservationFields(shop, { name, service, date, time }, options = {}) {
  const requireName = options.requireName !== false;
  const normalizedTime = normalizeTime(time);
  const invalidNames = ['お客様名', 'お客様', '名前', 'name', '未定', '不明'];
  const invalidServices = ['サービス内容', 'メニュー', '未定', '不明'];
  const cleanName = String(name || '').trim();
  const cleanService = String(service || '').trim();
  if (requireName && (!cleanName || invalidNames.includes(cleanName) || cleanName.length < 2)) {
    return { ok: false, message: 'ご予約のお名前をフルネームで教えていただけますか？' };
  }
  if (!cleanService || invalidServices.includes(cleanService)) {
    return { ok: false, message: 'ご希望のメニューを教えてください。' };
  }
  if (!isValidDateString(date)) {
    return { ok: false, message: 'ご予約の日付を正しくお知らせください。（例：2026-05-01）' };
  }
  if (!normalizedTime) {
    return { ok: false, message: 'ご予約の時間を正しくお知らせください。（例：14:00）' };
  }
  if (isPastDate(date, normalizedTime)) {
    return { ok: false, message: '申し訳ございません。過去の日時は予約できません。改めてご希望の日時をお聞かせください。' };
  }
  const durationMinutes = getServiceDuration(shop, cleanService);
  const businessIssue = getBusinessSlotIssue(shop, date, normalizedTime, durationMinutes);
  if (businessIssue) {
    return { ok: false, message: businessSlotIssueMessage(businessIssue, date, normalizedTime) };
  }
  return {
    ok: true,
    name: cleanName.slice(0, 100),
    service: cleanService.slice(0, 100),
    date,
    time: normalizedTime,
    durationMinutes,
  };
}

const reservationLocks = new Map();
async function withReservationLock(key, fn) {
  const previous = reservationLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => next);
  reservationLocks.set(key, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (reservationLocks.get(key) === tail) reservationLocks.delete(key);
  }
}

function getServiceDuration(shop, serviceType) {
  const fallback = Number(shop.reservation_interval) || 60;
  const items = Array.isArray(shop.menu_items) ? shop.menu_items : [];
  const match = items.find(m => String(m.name || '').trim() === String(serviceType || '').trim());
  const duration = Number(match?.duration);
  return Number.isFinite(duration) && duration > 0 && duration <= 480 ? duration : fallback;
}

function getDayJa(date) {
  const dayNames = ['日','月','火','水','木','金','土'];
  return dayNames[new Date(date + 'T00:00:00+09:00').getDay()] || '';
}

function buildShopDiagnostics(shop, events = []) {
  const hours = shop?.business_hours || {};
  const menuItems = Array.isArray(shop?.menu_items) ? shop.menu_items : [];
  const hasOpenHours = Object.values(hours).some(h => h && !h.closed && h.open && h.close && h.open < h.close);
  const checks = [
    {
      key: 'payment',
      level: shop?.is_paid && ['active', 'trial', 'trialing'].includes(shop?.plan_status || '') ? 'ok' : 'warn',
      label: '決済ステータス',
      message: shop?.is_paid ? `利用可能です（${shop.plan_status || 'unknown'}）` : '支払い状態を確認してください。',
    },
    {
      key: 'line',
      level: shop?.line_channel_secret && shop?.line_channel_access_token ? 'ok' : 'error',
      label: 'LINE連携',
      message: shop?.line_channel_secret && shop?.line_channel_access_token ? 'Webhook応答に必要な認証情報があります。' : 'LINE Channel Secret / Access Token が不足しています。',
    },
    {
      key: 'description',
      level: shop?.shop_description ? 'ok' : 'warn',
      label: '店舗紹介文',
      message: shop?.shop_description ? '自動応答で店舗情報を案内できます。' : '店舗紹介文を入力すると自動応答の品質が上がります。',
    },
    {
      key: 'hours',
      level: hasOpenHours ? 'ok' : 'error',
      label: '営業時間',
      message: hasOpenHours ? '予約可能な営業時間が設定されています。' : '少なくとも1日は営業日と営業時間を設定してください。',
    },
    {
      key: 'menu',
      level: menuItems.length > 0 ? 'ok' : 'warn',
      label: 'メニュー',
      message: menuItems.length > 0 ? `${menuItems.length}件のメニューがあります。` : 'メニューを登録すると所要時間と売上分析が安定します。',
    },
    {
      key: 'review',
      level: !shop?.review_request_enabled || shop?.google_review_url ? 'ok' : 'warn',
      label: '口コミURL',
      message: !shop?.review_request_enabled ? '口コミ依頼は無効です。' : '口コミ依頼に使うURLが設定されています。',
    },
  ];
  const aiEvents = events.filter(e => ['auto_response_failed', 'auto_parse_failed', 'ai_response_failed', 'ai_parse_failed', 'reservation_change_failed', 'reservation_processing_failed'].includes(e.type));
  checks.push({
    key: 'ai_monitoring',
    level: aiEvents.length === 0 ? 'ok' : 'warn',
    label: '自動応答エラー監視',
    message: aiEvents.length === 0 ? '直近の自動応答エラーはありません。' : `直近で${aiEvents.length}件の自動応答/予約処理エラーがあります。`,
  });
  const score = checks.reduce((sum, c) => sum + (c.level === 'ok' ? 1 : 0), 0);
  return {
    status: checks.some(c => c.level === 'error') ? 'error' : checks.some(c => c.level === 'warn') ? 'warn' : 'ok',
    score,
    total: checks.length,
    checks,
    recentEvents: events.slice(0, 10),
  };
}

function isReservationIntentText(text) {
  return /(予約|空き|空い|変更|キャンセル|お願い|伺い|行きたい|できますか|可能|希望|取りたい|予約したい)/.test(String(text || ''));
}

function isUnresolvedAssistantText(text) {
  return /(教えて|お知らせください|いかがでしょうか|確認|番号|フルネーム|メニュー|日付|時間|空き時間帯)/.test(String(text || ''));
}

function isResolvedAssistantText(text) {
  return /(ご予約を承りました|ご予約を変更いたしました|ご予約をキャンセルいたしました|予約完了|変更いたしました|キャンセルいたしました)/.test(String(text || ''));
}

async function getUnresolvedReservationConsultations(shopId = null) {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  let convQuery = supabase.from('conversations')
    .select('line_user_id, shop_id, role, content, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(3000);
  let resQuery = supabase.from('reservations')
    .select('line_user_id, shop_id, created_at')
    .gte('created_at', since)
    .eq('status', 'confirmed')
    .limit(3000);
  if (shopId) {
    convQuery = convQuery.eq('shop_id', shopId);
    resQuery = resQuery.eq('shop_id', shopId);
  }
  const [convRes, reservationRes] = await Promise.all([convQuery, resQuery]);
  if (convRes.error) throw convRes.error;

  const confirmedAfter = new Map();
  (reservationRes.data || []).forEach(r => {
    const key = `${r.shop_id}:${r.line_user_id}`;
    const time = new Date(r.created_at || 0).getTime();
    confirmedAfter.set(key, Math.max(confirmedAfter.get(key) || 0, time));
  });

  const grouped = new Map();
  (convRes.data || []).forEach(row => {
    const key = `${row.shop_id}:${row.line_user_id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  });

  const items = [];
  for (const [key, rows] of grouped.entries()) {
    const latest = rows[rows.length - 1];
    const lastUser = [...rows].reverse().find(r => r.role === 'user');
    const lastAssistant = [...rows].reverse().find(r => r.role === 'assistant');
    if (!lastUser && !lastAssistant) continue;
    const lastUserTime = lastUser ? new Date(lastUser.created_at).getTime() : 0;
    const confirmedTime = confirmedAfter.get(key) || 0;
    if (confirmedTime > lastUserTime) continue;
    if (lastAssistant && isResolvedAssistantText(lastAssistant.content)) continue;

    const assistantOpen = lastAssistant && isUnresolvedAssistantText(lastAssistant.content);
    const userIntentOpen = lastUser && isReservationIntentText(lastUser.content) && latest.role === 'user';
    if (!assistantOpen && !userIntentOpen) continue;

    const [itemShopId, lineUserId] = key.split(':');
    items.push({
      shop_id: itemShopId,
      line_user_id: lineUserId,
      last_role: latest.role,
      last_message: String(latest.content || '').replace(/\[[A-Z_]+\].*?\[\/[A-Z_]+\]/gs, '').trim().slice(0, 180),
      last_at: latest.created_at,
      reason: assistantOpen ? 'waiting_for_customer_info' : 'customer_message_needs_reply',
    });
  }

  return items.sort((a, b) => new Date(b.last_at) - new Date(a.last_at)).slice(0, 100);
}

function buildSystemHealth({ integrations, metrics, recentEvents }) {
  const checks = [
    { key: 'alerts', ok: integrations.alerts, label: '障害通知' },
    { key: 'database', ok: true, label: 'データベース' },
    { key: 'payments', ok: integrations.paddleApi, label: '決済同期' },
    { key: 'auto_errors', ok: (metrics.autoResponseErrors24h || 0) === 0, label: '自動応答エラー' },
    { key: 'unresolved', ok: (metrics.unresolvedConsultations || 0) <= 5, label: '未確定相談' },
  ];
  const critical = (recentEvents || []).some(e => e.level === 'critical');
  const score = checks.reduce((sum, c) => sum + (c.ok ? 20 : 0), 0) - (critical ? 20 : 0);
  const normalized = Math.max(0, Math.min(100, score));
  return {
    score: normalized,
    status: normalized >= 90 ? 'ok' : normalized >= 70 ? 'warn' : 'error',
    checks,
  };
}

function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const json = JSON.stringify(meta);
  return JSON.parse(json.length > 4000 ? json.slice(0, 4000) : json);
}

async function sendOpsAlert(event) {
  const key = `${event.level}:${event.type}`;
  const now = Date.now();
  const last = alertCooldowns.get(key) || 0;
  if (now - last < 10 * 60 * 1000) return;
  alertCooldowns.set(key, now);

  const text = `[${event.level.toUpperCase()}] ${event.type}\n${event.message}\n${new Date(event.created_at).toISOString()}`;
  try {
    if (process.env.ALERT_WEBHOOK_URL) {
      await fetch(process.env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, event }),
      });
    }
    if (process.env.ALERT_EMAIL) {
      await sendEmailNotification(
        process.env.ALERT_EMAIL,
        `【スマート予約Pro Alert】${event.type}`,
        `<pre style="font-family:monospace;white-space:pre-wrap;">${escapeHtml(text)}</pre>`
      );
    }
  } catch (e) {
    console.error('운영 알림 전송 실패:', e.message);
  }
}

async function logOpsEvent(level, type, message, meta = {}, shopId = null) {
  const event = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    level,
    type,
    message: String(message || '').slice(0, 500),
    shop_id: shopId,
    meta: safeMeta(meta),
  };
  opsEvents.unshift(event);
  if (opsEvents.length > OPS_EVENTS_LIMIT) opsEvents.pop();

  const logLine = `[OPS:${level}] ${type} ${event.message}`;
  if (level === 'critical' || level === 'error') console.error(logLine, event.meta);
  else if (level === 'warn') console.warn(logLine, event.meta);
  else console.log(logLine, event.meta);

  supabase.from('ops_events').insert(event).then(({ error }) => {
    if (error && !['42P01', '42703'].includes(error.code)) {
      console.error('ops_events 기록 실패:', error.message);
    }
  }).catch(() => {});

  if (['warn', 'error', 'critical'].includes(level)) sendOpsAlert(event).catch(() => {});
  return event;
}

function mapPaddleStatusToPlan(subscription) {
  const status = subscription?.status;
  const scheduled = subscription?.scheduled_change;
  const period = subscription?.current_billing_period;
  const nextBilledAt = subscription?.items?.find(item => item.next_billed_at)?.next_billed_at;
  const endDate = scheduled?.effective_at || period?.ends_at || nextBilledAt || null;
  if (status === 'active' || status === 'trialing') {
    return { is_paid: true, plan_status: 'active', subscription_end_date: endDate };
  }
  if (status === 'past_due') return { is_paid: false, plan_status: 'past_due', subscription_end_date: endDate };
  if (status === 'paused') return { is_paid: false, plan_status: 'paused', subscription_end_date: endDate };
  if (status === 'canceled') return { is_paid: false, plan_status: 'canceled', subscription_end_date: endDate };
  return { is_paid: false, plan_status: status || 'unknown', subscription_end_date: endDate };
}

async function fetchPaddleSubscription(subscriptionId) {
  if (!process.env.PADDLE_API_KEY) throw new Error('PADDLE_API_KEY is not configured');
  const baseUrl = process.env.PADDLE_API_BASE
    || (process.env.PADDLE_ENV === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com');
  const response = await fetch(`${baseUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Paddle API ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.data;
}

// ✅ 업종별 재방문 주기 + 메시지
const REVISIT_WEEKS = {
  beauty_salon: 5, nail_salon: 4, eyebrow_salon: 4, osteopathy: 4,
  massage: 4, dental: 12, gym: 4, yoga: 4, pet_salon: 4,
  restaurant: 4, acupuncture: 4,
};
function getReturnVisitMessage(businessType) {
  const w = REVISIT_WEEKS[businessType] || 4;
  const map = {
    beauty_salon:  `カラーやパーマのリタッチは約${w}週間が理想的です✨ 次回のご予約もぜひお気軽に😊`,
    nail_salon:    `ネイルのもちは約${w}週間。次回もお爪をきれいにしましょう💅`,
    eyebrow_salon: `眉のデザインは約${w}週間でリタッチをおすすめします✨`,
    osteopathy:    `定期的なケアで体の不調を予防できます。次回は約${w}週間後が目安です😊`,
    massage:       `約${w}週間に一度のケアで疲れを溜めずに過ごせます🌿`,
    dental:        `次回の定期健診は約${w}週間後をおすすめします🦷`,
    gym:           `定期的なトレーニングで目標達成を応援します💪 約${w}週間後にまたお越しください！`,
    yoga:          `継続的な練習が身体と心のバランスを整えます🧘 また一緒に練習しましょう！`,
    pet_salon:     `次回のグルーミングは約${w}週間後がおすすめです🐾`,
    restaurant:    `またのご来店を心よりお待ちしております🍽️`,
    acupuncture:   `定期的な施術で健康維持をサポートします🪡 約${w}週間後にまたお越しください。`,
  };
  return map[businessType] || `またのご利用をお待ちしております😊（目安：約${w}週間後）`;
}

// ✅ 이전 예약 기억
async function getLastReservation(lineUserId, shopId) {
  const { data } = await supabase.from('reservations')
    .select('customer_name, service_type, reservation_date')
    .eq('line_user_id', lineUserId).eq('shop_id', shopId).eq('status', 'confirmed')
    .order('reservation_date', { ascending: false }).limit(1);
  return data?.[0] || null;
}

// ✅ 빈 시간 계산 (DB 기반)
async function getAvailableSlots(shopId, date) {
  try {
    const { data: si } = await supabase.from('shops')
      .select('business_hours, closed_days, reservation_interval').eq('id', shopId).single();
    if (!si) return null;
    const dayKeys = ['sun','mon','tue','wed','thu','fri','sat'];
    const dayKey  = dayKeys[new Date(date + 'T00:00:00+09:00').getDay()];
    const hours   = si.business_hours?.[dayKey];
    const specificClosed = Array.isArray(si.closed_days) && si.closed_days.includes(date);
    if (specificClosed || !hours || hours.closed) return { closed: true };
    const intv = si.reservation_interval || 60;
    const [oH, oM] = (hours.open  || '10:00').split(':').map(Number);
    const [cH, cM] = (hours.close || '19:00').split(':').map(Number);
    const openMin = oH * 60 + oM, closeMin = cH * 60 + cM;
    const { data: res } = await supabase.from('reservations')
      .select('reservation_time, duration_minutes')
      .eq('shop_id', shopId).eq('reservation_date', date).eq('status', 'confirmed');
    const slots = [];
    for (let m = openMin; m + intv <= closeMin; m += intv) {
      slots.push(`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`);
    }
    const available = slots.filter(slot => {
      const sMin = timeToMinutes(slot);
      return !(res || []).some(r => {
        const rS = timeToMinutes(r.reservation_time);
        const rE = rS + (r.duration_minutes || intv);
        return sMin >= rS && sMin < rE;
      });
    });
    return { closed: false, open: hours.open, close: hours.close, available };
  } catch (e) { return null; }
}

// ✅ 취소 대기 상태 확인 (2시간 이내 assistant 메시지)
async function checkPendingCancelInHistory(lineUserId, shopId) {
  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase.from('conversations')
      .select('content').eq('line_user_id', lineUserId).eq('shop_id', shopId)
      .eq('role', 'assistant').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(5);
    for (const msg of (data || [])) {
      const m = msg.content?.match(/\[CANCEL_PENDING\](.*?)\[\/CANCEL_PENDING\]/s);
      if (m) {
        try {
          const p = JSON.parse(m[1]);
          if (!p.id) continue;
          const { data: r } = await supabase.from('reservations').select('status').eq('id', p.id).single();
          if (r?.status === 'confirmed') return p;
        } catch { continue; }
      }
    }
  } catch { }
  return null;
}

// ✅ 복수 취소 대기 상태 확인
async function checkPendingMultiCancelInHistory(lineUserId, shopId) {
  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase.from('conversations')
      .select('content').eq('line_user_id', lineUserId).eq('shop_id', shopId)
      .eq('role', 'assistant').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(5);
    for (const msg of (data || [])) {
      const m = msg.content?.match(/\[CANCEL_PENDING_MULTI\](.*?)\[\/CANCEL_PENDING_MULTI\]/s);
      if (m) { try { return { reservations: JSON.parse(m[1]) }; } catch { continue; } }
    }
  } catch { }
  return null;
}

async function checkPendingChangeInHistory(lineUserId, shopId) {
  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase.from('conversations')
      .select('content').eq('line_user_id', lineUserId).eq('shop_id', shopId)
      .eq('role', 'assistant').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(8);
    for (const msg of (data || [])) {
      const m = msg.content?.match(/\[CHANGE_PENDING\](.*?)\[\/CHANGE_PENDING\]/s);
      if (!m) continue;
      try {
        const pending = JSON.parse(m[1]);
        if (!pending.old?.id || !pending.next?.date || !pending.next?.time) continue;
        const { data: r } = await supabase.from('reservations')
          .select('status').eq('id', pending.old.id).eq('shop_id', shopId).single();
        if (r?.status === 'confirmed') return pending;
      } catch {
        continue;
      }
    }
  } catch { }
  return null;
}

async function checkPendingMultiChangeInHistory(lineUserId, shopId) {
  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase.from('conversations')
      .select('content').eq('line_user_id', lineUserId).eq('shop_id', shopId)
      .eq('role', 'assistant').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(8);
    for (const msg of (data || [])) {
      const m = msg.content?.match(/\[CHANGE_PENDING_MULTI\](.*?)\[\/CHANGE_PENDING_MULTI\]/s);
      if (m) {
        try {
          const p = JSON.parse(m[1]);
          if (Array.isArray(p.reservations) && p.next?.date && p.next?.time) return p;
        } catch {
          continue;
        }
      }
    }
  } catch { }
  return null;
}

function parsePendingTag(content, tag) {
  const m = content?.match(new RegExp(`\\[${tag}\\](.*?)\\[\\/${tag}\\]`, 's'));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function getLatestPendingAction(lineUserId, shopId) {
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data } = await supabase.from('conversations')
      .select('content, created_at').eq('line_user_id', lineUserId).eq('shop_id', shopId)
      .eq('role', 'assistant').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(12);
    for (const msg of (data || [])) {
      const change = parsePendingTag(msg.content, 'CHANGE_PENDING');
      if (change?.old?.id && change?.next?.date && change?.next?.time) {
        const { data: r } = await supabase.from('reservations')
          .select('status').eq('id', change.old.id).eq('shop_id', shopId).single();
        if (r?.status === 'confirmed') return { type: 'change', payload: change, createdAt: msg.created_at };
        continue;
      }
      const changeMulti = parsePendingTag(msg.content, 'CHANGE_PENDING_MULTI');
      if (Array.isArray(changeMulti?.reservations) && changeMulti.next?.date && changeMulti.next?.time) {
        return { type: 'change_multi', payload: changeMulti, createdAt: msg.created_at };
      }
      const cancel = parsePendingTag(msg.content, 'CANCEL_PENDING');
      if (cancel?.id) {
        const { data: r } = await supabase.from('reservations')
          .select('status').eq('id', cancel.id).eq('shop_id', shopId).single();
        if (r?.status === 'confirmed') return { type: 'cancel', payload: cancel, createdAt: msg.created_at };
        continue;
      }
      const cancelMulti = parsePendingTag(msg.content, 'CANCEL_PENDING_MULTI');
      if (Array.isArray(cancelMulti)) {
        return { type: 'cancel_multi', payload: { reservations: cancelMulti }, createdAt: msg.created_at };
      }
    }
  } catch { }
  return null;
}

// ✅ 확인 메시지 판정
function isConfirmationMessage(msg) {
  const t = msg.trim().toLowerCase();
  return ['はい', 'yes', 'ok', 'ｏｋ', 'お願いします', 'おねがいします', 'キャンセルします', 'キャンセルして'].some(
    w => t === w || t === w + '!' || t === w + '！'
  );
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

// ✅ 이메일 HTML 빌더 (캔슬)
function buildCancelEmailHtml(shopName, name, date, dayJa, time, service) {
  const t = String(time || '').slice(0, 5);
  const safe = {
    shopName: escapeHtml(shopName),
    name: escapeHtml(name || '-'),
    date: escapeHtml(date),
    dayJa: escapeHtml(dayJa),
    time: escapeHtml(t),
    service: escapeHtml(service || '-'),
  };
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <h2 style="color:#DC2626;">【キャンセル通知】</h2>
    <p style="color:#555;margin-bottom:16px;">店舗：${safe.shopName}</p>
    <table style="width:100%;border-collapse:collapse;">
      <tr><th style="background:#fef2f2;padding:10px;border:1px solid #dde;text-align:left;width:35%;">お客様名</th><td style="padding:10px;border:1px solid #dde;">${safe.name}</td></tr>
      <tr><th style="background:#fef2f2;padding:10px;border:1px solid #dde;text-align:left;">予約日時</th><td style="padding:10px;border:1px solid #dde;">${safe.date}（${safe.dayJa}）${safe.time}</td></tr>
      <tr><th style="background:#fef2f2;padding:10px;border:1px solid #dde;text-align:left;">メニュー</th><td style="padding:10px;border:1px solid #dde;">${safe.service}</td></tr>
    </table>
    <p style="margin-top:20px;"><a href="https://line-ai-bot-production-2d6d.up.railway.app/shop-dashboard.html" style="color:#06C755;font-weight:bold;">ダッシュボードで確認 →</a></p>
  </div>`;
}

// ✅ 이메일 HTML 빌더 (신규 예약)
function buildNewResEmailHtml(shopName, name, date, dayJa, time, service) {
  const safe = {
    shopName: escapeHtml(shopName),
    name: escapeHtml(name),
    date: escapeHtml(date),
    dayJa: escapeHtml(dayJa),
    time: escapeHtml(time),
    service: escapeHtml(service),
  };
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <h2 style="color:#06C755;">【新規予約通知】</h2>
    <p style="color:#555;margin-bottom:16px;">店舗：${safe.shopName}</p>
    <table style="width:100%;border-collapse:collapse;">
      <tr><th style="background:#f0f9f4;padding:10px;border:1px solid #dde;text-align:left;width:35%;">お客様名</th><td style="padding:10px;border:1px solid #dde;">${safe.name}</td></tr>
      <tr><th style="background:#f0f9f4;padding:10px;border:1px solid #dde;text-align:left;">予約日時</th><td style="padding:10px;border:1px solid #dde;">${safe.date}（${safe.dayJa}）${safe.time}</td></tr>
      <tr><th style="background:#f0f9f4;padding:10px;border:1px solid #dde;text-align:left;">メニュー</th><td style="padding:10px;border:1px solid #dde;">${safe.service}</td></tr>
    </table>
    <p style="margin-top:20px;"><a href="https://line-ai-bot-production-2d6d.up.railway.app/shop-dashboard.html" style="color:#06C755;font-weight:bold;">ダッシュボードで確認する →</a></p>
	  </div>`;
}

function buildChangeEmailHtml(shopName, name, oldRes, nextRes) {
  const safe = {
    shopName: escapeHtml(shopName),
    name: escapeHtml(name || '-'),
    oldDate: escapeHtml(oldRes.date),
    oldDay: escapeHtml(oldRes.dayJa),
    oldTime: escapeHtml(String(oldRes.time || '').slice(0, 5)),
    oldService: escapeHtml(oldRes.service || '-'),
    newDate: escapeHtml(nextRes.date),
    newDay: escapeHtml(nextRes.dayJa),
    newTime: escapeHtml(String(nextRes.time || '').slice(0, 5)),
    newService: escapeHtml(nextRes.service || '-'),
  };
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <h2 style="color:#2563EB;">【予約変更通知】</h2>
    <p style="color:#555;margin-bottom:16px;">店舗：${safe.shopName}</p>
    <table style="width:100%;border-collapse:collapse;">
      <tr><th style="background:#eff6ff;padding:10px;border:1px solid #dde;text-align:left;width:35%;">お客様名</th><td style="padding:10px;border:1px solid #dde;">${safe.name}</td></tr>
      <tr><th style="background:#eff6ff;padding:10px;border:1px solid #dde;text-align:left;">変更前</th><td style="padding:10px;border:1px solid #dde;">${safe.oldDate}（${safe.oldDay}）${safe.oldTime} / ${safe.oldService}</td></tr>
      <tr><th style="background:#eff6ff;padding:10px;border:1px solid #dde;text-align:left;">変更後</th><td style="padding:10px;border:1px solid #dde;">${safe.newDate}（${safe.newDay}）${safe.newTime} / ${safe.newService}</td></tr>
    </table>
    <p style="margin-top:20px;"><a href="https://line-ai-bot-production-2d6d.up.railway.app/shop-dashboard.html" style="color:#06C755;font-weight:bold;">ダッシュボードで確認する →</a></p>
  </div>`;
}

// ✅ 1회성 서비스 구매 후 고객에게 발송하는 질문 이메일 템플릿
const SERVICE_QUESTION_TEMPLATES = {
  'pri_01kqxxs9xvygq5rtm2ch9398nw': {
    name: 'LINEスタートパック',
    questions: `以下の情報をメールに返信する形でお送りください。

━━━━━━━━━━━━━━━━━━━━━━
【基本情報】
━━━━━━━━━━━━━━━━━━━━━━
①お名前：
②お電話番号：
③お店の名前：
④業種（例：美容室、ネイルサロン など）：
⑤お店の住所：
⑥最寄り駅と徒歩分数（例：渋谷駅 徒歩3分）：

━━━━━━━━━━━━━━━━━━━━━━
【営業情報】
━━━━━━━━━━━━━━━━━━━━━━
⑦営業時間（曜日別でお知らせください）：
⑧定休日：
⑨お店の特徴・強み（例：10年の経験・完全個室・駐車場あり）：
⑩ターゲットのお客様（例：30〜50代女性・ファミリー層）：
⑪メニューと料金（例：カット ¥4,000 / カラー ¥8,000）：

━━━━━━━━━━━━━━━━━━━━━━
【LINE設定】
━━━━━━━━━━━━━━━━━━━━━━
⑫LINE公式アカウントはお持ちですか？（はい／いいえ）：
⑬LINE Channel Secret（お持ちの方のみ）：
⑭LINE Channel Access Token（お持ちの方のみ）：
⑮リッチメニューのボタン構成のご希望
　（例：予約 / メニュー / アクセス / お問い합わせ）
　ご希望なければ「おまかせ」とご記入ください：

━━━━━━━━━━━━━━━━━━━━━━
【デザイン】
━━━━━━━━━━━━━━━━━━━━━━
⑯ご希望の雰囲気
　（親しみやすい／上品・高級感／シンプル／おまかせ）：
⑰ご希望のカラーイメージ（なければ「おまかせ」）：
⑱ロゴ・画像がある場合は添付してください

━━━━━━━━━━━━━━━━━━━━━━
【その他】
━━━━━━━━━━━━━━━━━━━━━━
⑲その他ご要望・こだわり：
⑳納期のご希望（通常3営業日以内／急ぎ希望）：`,
  },
  'pri_01kqxxx1dpg4tqm7c3mdg6d4cv': {
    name: 'Googleビジネスプロフィール設定パック',
    questions: `以下の情報をメールに返信する形でお送りください。

━━━━━━━━━━━━━━━━━━━━━━
【基本情報】
━━━━━━━━━━━━━━━━━━━━━━
①お名前：
②お電話番号：
③お店の名前（Googleに表示される正確な名称）：
④業種：
⑤お店の正確な住所（郵便番号含む）：
⑥店舗の電話番号：

━━━━━━━━━━━━━━━━━━━━━━
【営業情報】
━━━━━━━━━━━━━━━━━━━━━━
⑦営業時間（曜日別）：
⑧定休日：
⑨ウェブサイトURL（なければ空欄）：
⑩お店の特徴・強み：
⑪お客様へのアピールポイント（他店との違い）：
⑫主なメニューと料金：

━━━━━━━━━━━━━━━━━━━━━━
【写真・アカウント】
━━━━━━━━━━━━━━━━━━━━━━
⑬お店の外観写真を添付してください（必須・2枚以上）：
⑭店内写真があれば添付してください：
⑮メニュー・施術写真があれば添付してください：
⑯Googleアカウントはお持ちですか？（はい／いいえ）：
⑰Googleアカウントのメールアドレス（お持ちの方のみ）：

━━━━━━━━━━━━━━━━━━━━━━
【その他】
━━━━━━━━━━━━━━━━━━━━━━
⑱その他ご要望：
⑲納期のご希望（通常3営業日以内／急ぎ希望）：`,
  },
  'pri_01kqxxz153aqjsmcgp11ewm9dm': {
    name: 'Instagramスタートパック',
    questions: `以下の情報をメールに返信する形でお送りください。

━━━━━━━━━━━━━━━━━━━━━━
【基本情報】
━━━━━━━━━━━━━━━━━━━━━━
①お名前：
②お電話番号：
③お店の名前：
④業種：
⑤お店の特徴・強み：
⑥ターゲットのお客様：
⑦メニューと料金（主なもの）：

━━━━━━━━━━━━━━━━━━━━━━
【Instagram設定】
━━━━━━━━━━━━━━━━━━━━━━
⑧Instagramアカウントはお持ちですか？（はい／いいえ）：
⑨既存アカウントのID（お持ちの方のみ・@なし）：
⑩ご希望のアカウント名・ID候補
　（例：yamada_beauty_tokyo）：

━━━━━━━━━━━━━━━━━━━━━━
【デザイン・投稿】
━━━━━━━━━━━━━━━━━━━━━━
⑪ご希望の雰囲気
　（大人っぽい・上品／明るい・親しみやすい／シンプル・ナチュラル／おまかせ）：
⑫参考にしたいInstagramアカウント（なければ空欄）：
⑬最初の3投稿で伝えたいこと
　（例：開業ご挨拶・メニュー紹介・スタッフ紹介）：
⑭お店・スタッフの写真を添付してください（必須・3枚以上）：
⑮ロゴ・ブランド素材があれば添付してください：

━━━━━━━━━━━━━━━━━━━━━━
【連携・その他】
━━━━━━━━━━━━━━━━━━━━━━
⑯LINEのURL（すでにお持ちの方のみ）：
⑰その他ご要望：
⑱納期のご希望（通常3営業日以内／急ぎ希望）：`,
  },
  'pri_01kqxy12gs97a00wx47w0bdq44': {
    name: '集客フルパック',
    questions: `LINE・Google・Instagram全ての設定を行います。
以下の情報をメールに返信する形でお送りください。

━━━━━━━━━━━━━━━━━━━━━━
【基本情報】
━━━━━━━━━━━━━━━━━━━━━━
①お名前：
②お電話番号：
③お店の名前：
④業種：
⑤お店の住所（郵便番号含む）：
⑥最寄り駅と徒歩分数：

━━━━━━━━━━━━━━━━━━━━━━
【営業情報】
━━━━━━━━━━━━━━━━━━━━━━
⑦営業時間（曜日別）：
⑧定休日：
⑨お店の特徴・強み：
⑩ターゲットのお客様：
⑪メニューと料金：
⑫ウェブサイトURL（なければ空欄）：

━━━━━━━━━━━━━━━━━━━━━━
【LINE設定】
━━━━━━━━━━━━━━━━━━━━━━
⑬LINE公式アカウントはお持ちですか？（はい／いいえ）：
⑭LINE Channel Secret（お持ちの方のみ）：
⑮LINE Channel Access Token（お持ちの方のみ）：
⑯リッチメニューのボタン構成のご希望（なければ「おまかせ」）：

━━━━━━━━━━━━━━━━━━━━━━
【Google設定】
━━━━━━━━━━━━━━━━━━━━━━
⑰Googleアカウントはお持ちですか？（はい／いいえ）：
⑱Googleアカウントのメールアドレス（お持ちの方のみ）：

━━━━━━━━━━━━━━━━━━━━━━
【Instagram設定】
━━━━━━━━━━━━━━━━━━━━━━
⑲Instagramアカウントはお持ちですか？（はい／いいえ）：
⑳既存アカウントのID（お持ちの方のみ）：
㉑ご希望のアカウント名・ID候補：
㉒最初の3投稿で伝えたいこと：

━━━━━━━━━━━━━━━━━━━━━━
【デザイン・写真】
━━━━━━━━━━━━━━━━━━━━━━
㉓ご希望の雰囲気
　（親しみやすい／上品・高級感／シンプル／おまかせ）：
㉔ご希望のカラーイメージ（なければ「おまかせ」）：
㉕お店の外観・内装・メニュー写真を添付してください：
㉖ロゴ・ブランド素材があれば添付してください：

━━━━━━━━━━━━━━━━━━━━━━
【その他】
━━━━━━━━━━━━━━━━━━━━━━
㉗その他ご要望・こだわり：
㉘納期のご希望（通常3営業日以内／急ぎ希望）：`,
  },
  'pri_01kqxy42cpb268xw8nep10s0ma': {
    name: 'LINEリッチメニューリニューアル',
    questions: `以下の情報をメールに返信する形でお送りください。

━━━━━━━━━━━━━━━━━━━━━━
【基本情報】
━━━━━━━━━━━━━━━━━━━━━━
①お名前：
②お電話番号：
③お店の名前：
④業種：

━━━━━━━━━━━━━━━━━━━━━━
【リニューアル内容】
━━━━━━━━━━━━━━━━━━━━━━
⑤リニューアルの理由・目的
　（季節に合わせたい／デザインを新しくしたい／ボタン構成を変えたい／その他）：
⑥ご希望のテーマ・季節
　（例：夏・母の日・秋冬・クリスマス）：
⑦現在のリッチメニューのスクリーンショットを添付してください：
⑧ご希望のボタン構成
　（例：予約 / メニュー / お得情報 / アクセス）：
⑨ご希望のカラー・デザインイメージ（なければ「おまかせ」）：

━━━━━━━━━━━━━━━━━━━━━━
【LINE情報】
━━━━━━━━━━━━━━━━━━━━━━
⑩LINE Channel Access Token（設定代行に必要）：

━━━━━━━━━━━━━━━━━━━━━━
【その他】
━━━━━━━━━━━━━━━━━━━━━━
⑪その他ご要望：
⑫納期のご希望（通常3営業日以内／急ぎ希望）：`,
  },
  'pri_01kqxy6bzc3ffzfkrttr0vrznj': {
    name: '名刺・チラシ作成パック',
    questions: `以下の情報をメールに返信する形でお送りください。

━━━━━━━━━━━━━━━━━━━━━━
【基本情報】
━━━━━━━━━━━━━━━━━━━━━━
①お名前：
②役職・肩書き（例：代表・オーナー・スタイリスト）：
③お電話番号：
④メールアドレス（名刺に記載する場合）：
⑤お店の名前：
⑥業種：
⑦住所：
⑧ウェブサイトURL（なければ空欄）：
⑨LINEのURL（QRコード生成に使用）：

━━━━━━━━━━━━━━━━━━━━━━
【制作物】
━━━━━━━━━━━━━━━━━━━━━━
⑩制作物の種類
　（名刺／チラシA4／チラシA5／名刺+チラシセット）：
⑪掲載したいメニュー・サービス
　（例：カット ¥4,000 / カラー ¥8,000）：

━━━━━━━━━━━━━━━━━━━━━━
【デザイン】
━━━━━━━━━━━━━━━━━━━━━━
⑫ご希望のデザインイメージ
　（シンプル・モダン／上品・高級感／明るい・ポップ／おまかせ）：
⑬ご希望のカラー（なければ「おまかせ」）：
⑭参考にしたいデザイン画像があれば添付してください：
⑮ロゴ・素材があれば添付してください：

━━━━━━━━━━━━━━━━━━━━━━
【その他】
━━━━━━━━━━━━━━━━━━━━━━
⑯その他ご要望：
　※修正は1回まで無料です
　※納品はデジタルデータ（PDF）のみです。印刷は別途お客様にてお手配ください。
⑰納期のご希望（通常3営業日以内／急ぎ希望）：`,
  },
  'pri_01kqxy7z4bewp58sxe6vwgf00q': {
    name: '開業・移転完全サポートセット',
    questions: `開業・移転おめでとうございます！
全力でサポートいたします。
以下の情報をメールに返信する形でお送りください。

━━━━━━━━━━━━━━━━━━━━━━
【基本情報】
━━━━━━━━━━━━━━━━━━━━━━
①お名前：
②お電話番号：
③お店の名前：
④業種：
⑤開業・移転の予定日：
⑥新しいお店の住所（郵便番号含む）：
⑦開業・移転のどちらですか？（新規開業／移転オープン）：
⑧移転前の店舗情報（移転の方のみ）：

━━━━━━━━━━━━━━━━━━━━━━
【店舗情報】
━━━━━━━━━━━━━━━━━━━━━━
⑨最寄り駅と徒歩分数：
⑩営業時間（曜日別）：
⑪定休日：
⑫お店の特徴・強み：
⑬ターゲットのお客様：
⑭メニューと料金：
⑮ウェブサイトURL（なければ空欄）：

━━━━━━━━━━━━━━━━━━━━━━
【開業キャンペーン】
━━━━━━━━━━━━━━━━━━━━━━
⑯開業記念キャンペーンはありますか？
　（ある／ない／提案してほしい）：
⑰キャンペーン内容（ある方のみ）
　（例：オープン1ヶ月間 全メニュー20%OFF）：

━━━━━━━━━━━━━━━━━━━━━━
【LINE設定】
━━━━━━━━━━━━━━━━━━━━━━
⑱LINE設定の要否
　（新規で設定してほしい／すでに持っている／不要）：
⑲LINE Channel情報（お持ちの方のみ）：

━━━━━━━━━━━━━━━━━━━━━━
【Google設定】
━━━━━━━━━━━━━━━━━━━━━━
⑳Google設定の要否
　（新規で設定してほしい／すでに持っている／不要）：
㉑Googleアカウントのメール（お持ちの方のみ）：

━━━━━━━━━━━━━━━━━━━━━━
【Instagram設定】
━━━━━━━━━━━━━━━━━━━━━━
㉒Instagram設定の要否
　（新規で設定してほしい／すでに持っている／不要）：
㉓既存アカウントID（お持ちの方のみ）：
㉔ご希望のアカウント名・ID候補：

━━━━━━━━━━━━━━━━━━━━━━
【デザイン・写真】
━━━━━━━━━━━━━━━━━━━━━━
㉕ご希望の雰囲気
　（上品・高級感／親しみやすい／シンプル・ナチュラル／おまかせ）：
㉖お店のロゴを添付してください（あれば）：
㉗お店・内装の写真を添付してください（必須）：
㉘参考にしたいデザインがあれば添付してください：

━━━━━━━━━━━━━━━━━━━━━━
【その他】
━━━━━━━━━━━━━━━━━━━━━━
㉙その他ご要望・こだわり：
㉚納期のご希望
　（開業日の1週間前まで／開業日の3日前まで・別途ご相談）：`,
  },
};

// ✅ 1회성 서비스 구매 완료 이메일 HTML 빌더
function buildServicePurchaseEmailHtml(serviceName, customerEmail) {
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <h2 style="color:#06C755;">【ご購入ありがとうございます】</h2>
    <p style="color:#333;font-size:15px;line-height:1.8;margin-bottom:16px;">
      <strong>${escapeHtml(serviceName)}</strong>をご購入いただきありがとうございます。<br>
      担当者より3営業日以内に必要情報のご案内メールをお送りします。<br>
      今しばらくお待ちください。
    </p>
    <div style="background:#f0f9f4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin-bottom:20px;">
      <p style="color:#16a34a;font-weight:700;margin-bottom:8px;">✅ ご購入内容</p>
      <p style="color:#333;font-size:14px;">${escapeHtml(serviceName)}</p>
    </div>
    <p style="color:#555;font-size:13px;line-height:1.7;">
      ご不明な点がございましたら、このメールへの返信にてお問い合わせください。<br>
      引き続きよろしくお願いいたします。
    </p>
    <p style="margin-top:24px;font-size:13px;color:#999;">スマート予約Pro サポートチーム</p>
  </div>`;
}

// ✅ 담당자(개발자)에게 발송하는 작업 의뢰 이메일 HTML 빌더
function buildServiceOrderEmailHtml(serviceName, customerEmail, questions) {
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <h2 style="color:#2563EB;">【新規サービス購入通知】</h2>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:16px;margin-bottom:20px;">
      <p style="color:#1d4ed8;font-weight:700;margin-bottom:8px;">購入サービス</p>
      <p style="color:#333;font-size:15px;">${escapeHtml(serviceName)}</p>
      <p style="color:#1d4ed8;font-weight:700;margin-top:12px;margin-bottom:4px;">お客様メールアドレス</p>
      <p style="color:#333;font-size:14px;">${escapeHtml(customerEmail)}</p>
    </div>
    <p style="color:#333;font-size:14px;line-height:1.8;margin-bottom:16px;">
      上記のお客様に以下の質問メールを送信してください。<br>
      回答を受け取り次第、作業を開始してください。
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;">
      <p style="color:#374151;font-weight:700;margin-bottom:12px;">📋 送信する質問内容</p>
      <pre style="font-size:13px;color:#374151;white-space:pre-wrap;line-height:1.8;">${escapeHtml(questions)}</pre>
    </div>
    <p style="margin-top:20px;font-size:13px;color:#999;">スマート予約Pro 管理システム</p>
  </div>`;
}

// ✅ Resend 이메일 알림 (실패해도 예약/취소에 영향 없음)
async function sendEmailNotification(ownerEmail, subject, bodyHtml) {
  if (!process.env.RESEND_API_KEY || !ownerEmail) return;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'スマート予約Pro <onboarding@resend.dev>',
        to: ownerEmail,
        subject,
        html: bodyHtml,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend API ${response.status}: ${body.slice(0, 300)}`);
    }
    console.log(`✅ メール送信: ${subject}`);
  } catch (e) {
    console.error('メール送信失敗:', e.message);
  }
}

async function updateCustomerCarte(shopId, lineUserId, customerName, reservationDate) {
  try {
    const { data: existing } = await supabase.from('customer_cartes')
      .select('id, visit_count').eq('shop_id', shopId).eq('line_user_id', lineUserId).single();
    if (existing) {
      await supabase.from('customer_cartes').update({
        customer_name: customerName,
        visit_count: (existing.visit_count || 0) + 1,
        last_visit_date: reservationDate,
        updated_at: new Date().toISOString(),
      }).eq('id', existing.id);
    } else {
      await supabase.from('customer_cartes').insert({
        shop_id: shopId, line_user_id: lineUserId,
        customer_name: customerName, visit_count: 1,
        last_visit_date: reservationDate,
      });
    }
  } catch (e) {
    console.error('カルテ更新エラー:', e.message);
  }
}

async function getConversationHistory(lineUserId, shopId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('line_user_id', lineUserId)
    .eq('shop_id', shopId)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(10);
  return data || [];
}

async function saveConversation(lineUserId, shopId, role, content) {
  const { error } = await supabase.from('conversations').insert({
    line_user_id: lineUserId,
    shop_id: shopId,
    role,
    content,
  });
  if (error) {
    await logOpsEvent('warn', 'conversation_save_failed', error.message, { lineUserId, role }, shopId);
  }
}

async function cleanOldConversations() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('conversations').delete().lt('created_at', cutoff);
  console.log('✅ 오래된 대화 정리 완료');
}

async function getShopExtraInfo(shopId) {
  const { data } = await supabase
    .from('shops')
    .select('shop_description, business_hours, menu_items')
    .eq('id', shopId)
    .single();

  let extraInfo = '';
  if (data?.shop_description) extraInfo += `\n店舗情報: ${data.shop_description}`;
  if (data?.business_hours) {
    const dayNames = { mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日' };
    const hoursText = Object.entries(data.business_hours).map(([day, h]) =>
      h.closed ? `${dayNames[day]}:定休日` : `${dayNames[day]}:${h.open}〜${h.close}`
    ).join(', ');
    extraInfo += `\n営業時間: ${hoursText}`;
  }
  if (data?.menu_items?.length > 0) {
    const menuText = data.menu_items.map(m => `${m.name}(${m.price}円・${m.duration}分)`).join(', ');
    extraInfo += `\nメニュー: ${menuText}`;
  }
  return extraInfo;
}

async function checkReservationConflict(shopId, date, time, durationMinutes = 60, excludeReservationId = null) {
  const { data } = await supabase
    .from('reservations')
    .select('id, reservation_time, duration_minutes')
    .eq('shop_id', shopId)
    .eq('reservation_date', date)
    .eq('status', 'confirmed');

  if (!data || data.length === 0) return false;
  const newStart = timeToMinutes(time);
  const newEnd = newStart + durationMinutes;
  return data.some(r => {
    if (excludeReservationId && r.id === excludeReservationId) return false;
    const existStart = timeToMinutes(r.reservation_time);
    const existEnd = existStart + (r.duration_minutes || 60);
    return newStart < existEnd && newEnd > existStart;
  });
}

async function sendReminders() {
  if (process.env.ENABLE_LINE_PUSH_REMINDERS !== 'true') return;
  try {
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const tomorrow = new Date(jstNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const { data: reservations } = await supabase
      .from('reservations')
      .select('*, shops(shop_name, line_channel_access_token, is_paid)')
      .eq('reservation_date', tomorrowStr)
      .eq('status', 'confirmed')
      .eq('reminder_sent', false);

    if (!reservations || reservations.length === 0) return;

    for (const r of reservations) {
      try {
        if (!r.shops?.line_channel_access_token || !r.shops?.is_paid) continue;
        const client = new line.messagingApi.MessagingApiClient({
          channelAccessToken: r.shops.line_channel_access_token,
        });
        await client.pushMessage({
          to: r.line_user_id,
          messages: [{ type: 'text', text: `【予約リマインダー】\n明日のご予約のご確認です。\n\n📅 日時：${r.reservation_date} ${r.reservation_time?.slice(0, 5)}\n✂️ メニュー：${r.service_type || '-'}\n🏪 店舗：${r.shops.shop_name}\n\n当日のご来店をお待ちしております。` }],
        });
        await supabase.from('reservations').update({ reminder_sent: true }).eq('id', r.id);
      } catch (e) {
        console.error(`리마인더 실패: ${r.customer_name}`, e.message);
        await logOpsEvent('warn', 'reminder_send_failed', e.message, {
          reservationId: r.id,
          lineUserId: r.line_user_id,
        }, r.shop_id);
      }
    }
  } catch (e) {
    console.error('리마인더 오류:', e);
    await logOpsEvent('error', 'reminder_job_failed', e.message);
  }
}

async function runHealthMonitor() {
  try {
    const { error } = await supabase.from('shops').select('id', { count: 'exact', head: true }).limit(1);
    if (error) throw error;
    if (!process.env.RESEND_API_KEY) {
      await logOpsEvent('warn', 'resend_not_configured', 'RESEND_API_KEY is not configured; email notifications are disabled.');
    }
    if (!process.env.PADDLE_API_KEY) {
      await logOpsEvent('warn', 'paddle_api_not_configured', 'PADDLE_API_KEY is not configured; manual payment sync is disabled.');
    }
  } catch (e) {
    await logOpsEvent('critical', 'health_check_failed', e.message);
  }
}

if (process.env.NODE_ENV !== 'test') {
  cron.schedule('0 0 * * *', sendReminders, { timezone: 'UTC' });
  cron.schedule('0 1 * * 1', cleanOldConversations, { timezone: 'UTC' });
  cron.schedule('*/15 * * * *', runHealthMonitor, { timezone: 'UTC' });
  console.log('⏰ 스케줄러 시작');
}

// ✅ Rate Limiting
// 회원가입: IP당 15분에 10회
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。しばらくしてから再試行してください。' },
});
// 관리자 API: IP당 5분에 30회
const adminLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。' },
});

// ============================
// ✅ Google OAuth 라우트 (JWT 방식)
// ============================
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  session: false
}));

app.get('/auth/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed', session: false }),
  (req, res) => {
    // ✅ JWT 쿠키 발급 후 메인으로 이동
    issueJWT(res, req.user);
    res.redirect('/');
  }
);

// ✅ 현재 로그인 유저 정보 API
app.get('/api/me', (req, res) => {
  if (req.user) {
    res.json({ success: true, user: req.user });
  } else {
    res.json({ success: false });
  }
});

// ✅ 내 가게 정보 API (JWT 필수 + 결제/만료 체크)
app.get('/api/my-shop', requireJWT, async (req, res) => {
  try {
    const { data: shop } = await supabase.from('shops').select('*')
      .eq('owner_email', req.user.email).single();
    if (!shop) return res.json({ success: false, reason: 'no_shop' });
    if (shop.subscription_end_date && new Date(shop.subscription_end_date) < new Date()) {
      await supabase.from('shops').update({ is_paid: false, plan_status: 'expired' }).eq('id', shop.id);
      shop.is_paid = false;
      shop.plan_status = 'expired';
    }
    const { line_channel_secret, line_channel_access_token, ...safeShop } = shop;
    safeShop.calendar_token = makeCalendarToken(shop);
    res.json({ success: true, shop: safeShop });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// ✅ 로그아웃 - 쿠키 삭제
app.get('/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/');
});

// ============================
// Paddle Webhook
// ============================
// ✅ Paddle v2 웹훅 서명 검증 (HMAC-SHA256)
function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = {};
  signatureHeader.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx !== -1) parts[part.slice(0, idx)] = part.slice(idx + 1);
  });
  const ts = parts['ts'];
  const h1 = parts['h1'];
  if (!ts || !h1) return false;
  const computed = crypto
    .createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(h1, 'hex'));
  } catch {
    return false;
  }
}

app.post('/paddle/webhook', async (req, res) => {
  // ── 1단계: 서명 검증 — try/catch 밖에서 처리하여 우회 불가 ──
  const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('❌ [Paddle] PADDLE_WEBHOOK_SECRET 미설정 — webhook 거부');
    logOpsEvent('critical', 'paddle_secret_missing', 'PADDLE_WEBHOOK_SECRET is not configured').catch(() => {});
    return res.status(401).json({ error: 'Server misconfiguration' });
  }

  const sig     = req.headers['paddle-signature'];
  const rawBody = req.body.toString();

  if (!verifyPaddleSignature(rawBody, sig, webhookSecret)) {
    console.warn(`⚠️ [Paddle] 서명 검증 실패 | IP=${req.ip} | Paddle-Signature: ${sig || '(없음)'}`);
    logOpsEvent('warn', 'paddle_signature_failed', 'Invalid Paddle webhook signature', { ip: req.ip }).catch(() => {});
    return res.status(401).json({ error: 'Invalid signature' });
  }
  console.log(`✅ [Paddle] 서명 검증 성공 | IP=${req.ip}`);

  // ── 2단계: 비즈니스 로직 — Paddle 재시도 방지를 위해 항상 200 반환 ──
  try {
    const body = JSON.parse(rawBody);
    const eventType = body.event_type;
    const eventId = body.event_id || body.id || null;

    // Paddle v2 webhook: customData は custom_data (snake_case) で届く
    // camelCase フォールバックも念のため確認
    const shopId = body.data?.custom_data?.shopId
                || body.data?.customData?.shopId
                || null;
    const customerEmail = body.data?.customer?.email
      || body.data?.custom_data?.email
      || body.data?.customData?.email
      || null;

    console.log(`📦 Paddle webhook: ${eventType} | shopId=${shopId} | email=${customerEmail}`);
    await logOpsEvent('info', 'paddle_webhook_received', eventType, { eventId, shopId, customerEmail }, shopId);

    // shopId が優先 — なければ email にフォールバック
    function buildQuery(table, updateData) {
      const q = supabase.from(table).update(updateData);
      if (shopId) {
        console.log(`  → match by shopId: ${shopId}`);
        return q.eq('id', shopId);
      }
      if (customerEmail) {
        console.log(`  → match by email (fallback): ${customerEmail}`);
        return q.eq('owner_email', customerEmail);
      }
      return null;
    }

    // ✅ 1회성 서비스 여부 판단
    const txPriceId = body.data?.items?.[0]?.price?.id || null;
    const isOneTimeService = Boolean(SERVICE_QUESTION_TEMPLATES[txPriceId]);
    const isSubscriptionTx = (Boolean(body.data?.subscription_id) || eventType === 'subscription.created') && !isOneTimeService;

    if ((eventType === 'transaction.completed' && isSubscriptionTx) || eventType === 'subscription.created') {
      if (!shopId && !customerEmail) {
        console.warn('⚠️ shopId も email もなし — スキップ');
      } else {
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 7);
        const q = buildQuery('shops', {
          is_paid: true,
          plan_status: 'active',
          paddle_subscription_id: body.data?.subscription_id || body.data?.id || null,
          trial_started_at: new Date().toISOString(),
          subscription_end_date: trialEnd.toISOString(),
        });
        if (q) {
          const { error } = await q;
          if (error) {
            console.error('shop 활성화 실패:', error);
            await logOpsEvent('error', 'paddle_activation_failed', error.message, { eventId, eventType, shopId, customerEmail }, shopId);
          } else {
            console.log(`✅ shop 활성화 완료`);
            await logOpsEvent('info', 'shop_activated_by_paddle', 'Shop activated by Paddle webhook', { eventId, eventType }, shopId);
          }
        }
      }
    }

    if (eventType === 'subscription.canceled') {
      if (!shopId && !customerEmail) {
        console.warn('⚠️ shopId も email もなし — スキップ');
      } else {
        // effective_at: 실제 서비스 종료 시점(청구 주기 말) — 이 날짜까지 서비스 유지
        // canceled_at: 취소 요청 시점 — effective_at 없을 때만 fallback
        const endDate =
          body.data?.scheduled_change?.effective_at ||
          body.data?.effective_at ||
          body.data?.canceled_at ||
          new Date().toISOString();
        const q = buildQuery('shops', {
          plan_status: 'canceled',
          subscription_end_date: endDate,
        });
        console.log(`  → 서비스 종료 예정일: ${endDate}`);
        if (q) {
          const { error } = await q;
          if (error) {
            console.error('subscription.canceled 업데이트 실패:', error);
            await logOpsEvent('error', 'paddle_cancel_failed', error.message, { eventId, shopId, customerEmail }, shopId);
          } else {
            console.log(`🚫 구독 취소 완료`);
            await logOpsEvent('info', 'subscription_canceled_by_paddle', 'Subscription cancellation synced', { eventId, endDate }, shopId);
          }
        }
      }
    }

    // ✅ 1회성 서비스 구매 완료 처리
    if (eventType === 'transaction.completed' && isOneTimeService) {
      try {
        const items = body.data?.items || [];
        const priceId = items[0]?.price?.id || null;
        const template = priceId ? SERVICE_QUESTION_TEMPLATES[priceId] : null;

        if (template && customerEmail) {
          const OWNER_EMAIL = process.env.OWNER_EMAIL || process.env.ALERT_EMAIL;

          // 1. 고객에게 구매 완료 + 안내 이메일 발송
          await sendEmailNotification(
            customerEmail,
            `【スマート予約Pro】${template.name}のご購入ありがとうございます`,
            buildServicePurchaseEmailHtml(template.name, customerEmail)
          );

          // 2. 개발자(오너)에게 작업 의뢰 이메일 발송
          if (OWNER_EMAIL) {
            await sendEmailNotification(
              OWNER_EMAIL,
              `【新規購入】${template.name} - ${customerEmail}`,
              buildServiceOrderEmailHtml(template.name, customerEmail, template.questions)
            );
          }

          await logOpsEvent(
            'info',
            'service_purchase_email_sent',
            `${template.name} 구매 이메일 발송 완료`,
            { priceId, customerEmail },
            null
          );

          console.log(`✅ 서비스 구매 이메일 발송: ${template.name} → ${customerEmail}`);
        }
      } catch (e) {
        console.error('서비스 구매 이메일 발송 오류:', e.message);
        await logOpsEvent('warn', 'service_purchase_email_failed', e.message, { customerEmail });
      }
    }

    if (eventType === 'transaction.refunded') {
      if (!shopId && !customerEmail) {
        console.warn('⚠️ shopId も email もなし — スキップ');
      } else {
        const q = buildQuery('shops', {
          is_paid: false,
          plan_status: 'refunded',
        });
        if (q) {
          const { error } = await q;
          if (error) {
            console.error('transaction.refunded 업데이트 실패:', error);
            await logOpsEvent('error', 'paddle_refund_failed', error.message, { eventId, shopId, customerEmail }, shopId);
          } else {
            console.log(`💰 환불 완료`);
            await logOpsEvent('warn', 'shop_refunded_by_paddle', 'Shop marked refunded by Paddle webhook', { eventId }, shopId);
          }
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (e) {
    console.error('Paddle webhook 오류:', e);
    await logOpsEvent('error', 'paddle_webhook_error', e.message);
    res.status(200).json({ received: true });
  }
});

// ============================
// API
// ============================
app.post('/api/admin/activate-shop', adminLimiter, adminAuth, async (req, res) => {
  const { shopId, activate } = req.body;
  if (!isUuid(shopId)) return res.status(400).json({ success: false, reason: 'invalid_shop_id' });
  try {
    // 개발자 테스트 가게는 비활성화 불가 — 서버 이중 차단
    if (!activate) {
      const { data: shopCheck } = await supabase.from('shops')
        .select('owner_email').eq('id', shopId).single();
      if (shopCheck?.owner_email === 'hohomi4847@gmail.com') {
        return res.status(403).json({ success: false, reason: 'dev_shop_protected' });
      }
    }
    await supabase.from('shops').update({
      is_paid: activate,
      plan_status: activate ? 'active' : 'suspended',
    }).eq('id', shopId);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

app.get('/api/shop-settings', requireJWT, async (req, res) => {
  const { shopId } = req.query;
  if (!isUuid(shopId)) return res.status(400).json({ error: 'invalid shopId' });
  try {
    const { data } = await supabase.from('shops')
      .select('shop_description, business_hours, menu_items, closed_days, reservation_interval, repeat_message_enabled, google_review_url, review_request_enabled, owner_email')
      .eq('id', shopId).single();
    if (!data || data.owner_email !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    const { owner_email, ...safeData } = data;
    res.json(safeData);
  } catch (e) {
    res.status(500).json({});
  }
});

app.get('/api/shop-diagnostics', requireJWT, async (req, res) => {
  const { shopId } = req.query;
  if (!isUuid(shopId)) return res.status(400).json({ error: 'invalid shopId' });
  try {
    const { data: shop } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (!shop || shop.owner_email !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [{ data: events, error: eventsError }, unresolved] = await Promise.all([
      supabase.from('ops_events')
        .select('level, type, message, created_at, meta')
        .eq('shop_id', shopId)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(20),
      getUnresolvedReservationConsultations(shopId),
    ]);
    if (eventsError) throw eventsError;
    const diagnostics = buildShopDiagnostics(shop, events || []);
    diagnostics.unresolvedConsultations = unresolved;
    diagnostics.checks.push({
      key: 'unresolved_consultations',
      level: unresolved.length === 0 ? 'ok' : unresolved.length <= 3 ? 'warn' : 'error',
      label: '未確定の予約相談',
      message: unresolved.length === 0 ? '未確定の予約相談はありません。' : `${unresolved.length}件の未確定相談があります。`,
    });
    diagnostics.total = diagnostics.checks.length;
    diagnostics.score = diagnostics.checks.reduce((sum, c) => sum + (c.level === 'ok' ? 1 : 0), 0);
    diagnostics.status = diagnostics.checks.some(c => c.level === 'error') ? 'error' : diagnostics.checks.some(c => c.level === 'warn') ? 'warn' : 'ok';
    res.json(diagnostics);
  } catch (e) {
    await logOpsEvent('error', 'shop_diagnostics_failed', e.message, { shopId }, shopId);
    res.status(500).json({ error: 'error' });
  }
});

app.get('/api/shop-reservations', requireJWT, async (req, res) => {
  const { shopId } = req.query;
  if (!isUuid(shopId)) return res.status(400).json({ error: 'invalid shopId' });
  try {
    const { data: shop } = await supabase.from('shops').select('owner_email').eq('id', shopId).single();
    if (!shop || shop.owner_email !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    const { data } = await supabase.from('reservations').select('*')
      .eq('shop_id', shopId).order('reservation_date', { ascending: true });
    res.json({ reservations: data || [] });
  } catch (e) {
    res.status(500).json({ reservations: [] });
  }
});

app.post('/api/cancel-reservation', requireJWT, async (req, res) => {
  const { reservationId, shopId } = req.body;
  if (!isUuid(reservationId) || !isUuid(shopId)) return res.status(400).json({ success: false, reason: 'invalid_id' });
  try {
    const { data: shop } = await supabase.from('shops').select('owner_email').eq('id', shopId).single();
    if (!shop || shop.owner_email !== req.user.email) return res.status(403).json({ success: false });
    const { error } = await supabase.from('reservations').update({ status: 'canceled' })
      .eq('id', reservationId).eq('shop_id', shopId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/shop-update', requireJWT, async (req, res) => {
  const { shopId, ...updateData } = req.body;
  if (!isUuid(shopId)) return res.status(400).json({ success: false, reason: 'invalid_shop_id' });
  try {
    const { data: shop } = await supabase.from('shops').select('id')
      .eq('id', shopId).eq('owner_email', req.user.email).single();
    if (!shop) return res.status(403).json({ success: false });
	    const allowedFields = ['shop_description', 'business_hours', 'menu_items', 'closed_days', 'reservation_interval', 'repeat_message_enabled', 'google_review_url', 'review_request_enabled'];
	    const safeUpdate = {};
	    allowedFields.forEach(f => { if (updateData[f] !== undefined) safeUpdate[f] = updateData[f]; });
	    if (Object.keys(safeUpdate).length === 0) {
	      return res.status(400).json({ success: false, reason: 'no_fields' });
	    }
    // ✅ shop_description 길이 제한 — 응답 프롬프트 토큰 폭증 방지
    if (typeof safeUpdate.shop_description === 'string' && safeUpdate.shop_description.length > 500) {
      return res.status(400).json({ success: false, reason: 'description_too_long' });
    }
	    if (safeUpdate.google_review_url) {
	      try { new URL(safeUpdate.google_review_url); } catch (_) {
	        return res.status(400).json({ success: false, reason: 'invalid_url' });
	      }
	    }
	    if (safeUpdate.business_hours !== undefined) {
	      const hours = sanitizeBusinessHours(safeUpdate.business_hours);
	      if (!hours) return res.status(400).json({ success: false, reason: 'invalid_business_hours' });
	      safeUpdate.business_hours = hours;
	    }
	    if (safeUpdate.menu_items !== undefined) {
	      const menu = sanitizeMenuItems(safeUpdate.menu_items);
	      if (!menu || menu.length === 0) return res.status(400).json({ success: false, reason: 'invalid_menu_items' });
	      safeUpdate.menu_items = menu;
	    }
	    if (safeUpdate.closed_days !== undefined) {
	      const closedDays = sanitizeClosedDays(safeUpdate.closed_days);
	      if (!closedDays) return res.status(400).json({ success: false, reason: 'invalid_closed_days' });
	      safeUpdate.closed_days = closedDays;
	    }
	    if (safeUpdate.reservation_interval !== undefined) {
	      const interval = Number(safeUpdate.reservation_interval);
	      if (!Number.isFinite(interval) || interval < 5 || interval > 480) {
	        return res.status(400).json({ success: false, reason: 'invalid_reservation_interval' });
	      }
	      safeUpdate.reservation_interval = Math.round(interval);
	    }
	    const { error } = await supabase.from('shops').update(safeUpdate).eq('id', shopId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/dashboard', adminLimiter, adminAuth, async (_req, res) => {
  try {
    const jstToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
    // 최대 1000건으로 제한 — 대량 데이터 로드 시 메모리/타임아웃 방지
    const { data: reservations } = await supabase.from('reservations').select('*')
      .order('created_at', { ascending: false }).limit(1000);
    const { data: shops } = await supabase.from('shops')
      .select('id, shop_name, business_type, owner_email, is_paid, plan_status, created_at')
      .order('created_at', { ascending: false }).limit(1000);
    const safeReservations = reservations || [];
    const safeShops = shops || [];
    res.json({
      totalReservations: safeReservations.length,
      todayReservations: safeReservations.filter(r => r.reservation_date === jstToday).length,
      totalShops: safeShops.length,
      reservations: safeReservations,
      shops: safeShops,
    });
  } catch (e) {
    res.status(500).json({ error: 'error' });
  }
});

app.get('/health', async (_req, res) => {
  const checks = {
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: STARTED_AT.toISOString(),
    env: {
      resend: Boolean(process.env.RESEND_API_KEY),
      paddleApi: Boolean(process.env.PADDLE_API_KEY),
	      alertWebhook: Boolean(process.env.ALERT_WEBHOOK_URL),
	      alertEmail: Boolean(process.env.ALERT_EMAIL),
	      alertsReady: isAlertConfigured(),
	      linePushReminders: process.env.ENABLE_LINE_PUSH_REMINDERS === 'true',
	    },
    database: 'unknown',
  };
  try {
    const { error } = await supabase.from('shops').select('id', { count: 'exact', head: true }).limit(1);
    checks.database = error ? 'error' : 'ok';
    const ok = checks.database === 'ok';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks });
  } catch (e) {
    checks.database = 'error';
    res.status(503).json({ status: 'degraded', checks });
  }
});

app.get('/api/admin/ops', adminLimiter, adminAuth, async (_req, res) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
	    const [shopsRes, todayRes, weekRes, dbEventsRes, unresolved] = await Promise.all([
	      supabase.from('shops').select('id, shop_name, owner_email, is_paid, plan_status, paddle_subscription_id, subscription_end_date, created_at').order('created_at', { ascending: false }).limit(1000),
	      supabase.from('reservations').select('id, shop_id, status, created_at').gte('created_at', since24h).limit(5000),
	      supabase.from('reservations').select('id, shop_id, status, created_at').gte('created_at', since7d).limit(10000),
	      supabase.from('ops_events').select('*').order('created_at', { ascending: false }).limit(100),
	      getUnresolvedReservationConsultations(),
	    ]);

    const shops = shopsRes.data || [];
    const paidShops = shops.filter(s => s.is_paid);
    const syncNeeded = shops.filter(s => s.paddle_subscription_id && !['active', 'trial', 'trialing'].includes(s.plan_status || '')).length;
    const dbEvents = dbEventsRes.error ? [] : (dbEventsRes.data || []);
    const recentEvents = dbEvents.length > 0 ? dbEvents : opsEvents;
	    const integrations = {
	      resend: Boolean(process.env.RESEND_API_KEY),
	      paddleApi: Boolean(process.env.PADDLE_API_KEY),
	      alerts: isAlertConfigured(),
	      linePushReminders: process.env.ENABLE_LINE_PUSH_REMINDERS === 'true',
	    };
	    const metrics = {
	      totalShops: shops.length,
	      paidShops: paidShops.length,
	      inactivePaidRisk: shops.filter(s => s.is_paid && !['active', 'trial', 'trialing'].includes(s.plan_status || '')).length,
	      reservations24h: (todayRes.data || []).length,
	      reservations7d: (weekRes.data || []).length,
	      syncNeeded,
	      unresolvedConsultations: unresolved.length,
	      autoResponseErrors24h: recentEvents.filter(e =>
	        ['auto_response_failed', 'ai_response_failed', 'reservation_processing_failed'].includes(e.type)
	        && new Date(e.created_at) >= new Date(since24h)
	      ).length,
	    };
	    const health = buildSystemHealth({ integrations, metrics, recentEvents });
	    res.json({
	      status: 'ok',
	      generatedAt: new Date().toISOString(),
	      uptimeSeconds: Math.round(process.uptime()),
	      startedAt: STARTED_AT.toISOString(),
	      integrations,
	      metrics,
	      health,
	      unresolvedConsultations: unresolved.slice(0, 30),
	      shops: shops.slice(0, 100),
	      recentEvents,
      errors: [shopsRes.error, todayRes.error, weekRes.error, dbEventsRes.error].filter(Boolean).map(e => e.message),
    });
  } catch (e) {
    await logOpsEvent('error', 'admin_ops_failed', e.message);
    res.status(500).json({ status: 'error' });
  }
});

app.get('/api/admin/shop/:shopId', adminLimiter, adminAuth, async (req, res) => {
  const { shopId } = req.params;
  if (!isUuid(shopId)) return res.status(400).json({ error: 'invalid_shop_id' });
  try {
	    const [shopRes, reservationsRes, conversationsRes, cartesRes, eventsRes] = await Promise.all([
      supabase.from('shops').select('*').eq('id', shopId).single(),
      supabase.from('reservations').select('*').eq('shop_id', shopId).order('created_at', { ascending: false }).limit(50),
      supabase.from('conversations').select('line_user_id, role, content, created_at').eq('shop_id', shopId).order('created_at', { ascending: false }).limit(50),
      supabase.from('customer_cartes').select('*').eq('shop_id', shopId).order('updated_at', { ascending: false }).limit(50),
      supabase.from('ops_events').select('*').eq('shop_id', shopId).order('created_at', { ascending: false }).limit(50),
	    ]);
	    if (shopRes.error || !shopRes.data) return res.status(404).json({ error: 'shop_not_found' });
	    const { line_channel_secret, line_channel_access_token, ...safeShop } = shopRes.data;
	    const diagnostics = buildShopDiagnostics(shopRes.data, eventsRes.error ? [] : (eventsRes.data || []));
	    res.json({
	      shop: safeShop,
	      reservations: reservationsRes.data || [],
	      conversations: conversationsRes.data || [],
	      cartes: cartesRes.data || [],
	      events: eventsRes.error ? [] : (eventsRes.data || []),
	      diagnostics,
	    });
  } catch (e) {
    await logOpsEvent('error', 'admin_shop_detail_failed', e.message, { shopId }, shopId);
    res.status(500).json({ error: 'error' });
  }
});

app.post('/api/admin/shop-note', adminLimiter, adminAuth, async (req, res) => {
  const { shopId, note } = req.body || {};
  if (!isUuid(shopId)) return res.status(400).json({ success: false, reason: 'invalid_shop_id' });
  try {
    const safeNote = typeof note === 'string' ? note.slice(0, 2000) : '';
    const { error } = await supabase.from('shops').update({ admin_note: safeNote }).eq('id', shopId);
    if (error) throw error;
    await logOpsEvent('info', 'admin_note_saved', 'Admin note updated', { length: safeNote.length }, shopId);
    res.json({ success: true });
  } catch (e) {
    await logOpsEvent('error', 'admin_note_failed', e.message, { shopId }, shopId);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/sync-payments', adminLimiter, adminAuth, async (req, res) => {
  const { shopId } = req.body || {};
  if (shopId && !isUuid(shopId)) return res.status(400).json({ success: false, reason: 'invalid_shop_id' });
  if (!process.env.PADDLE_API_KEY) return res.status(400).json({ success: false, reason: 'paddle_api_key_missing' });
  try {
    let query = supabase.from('shops').select('id, shop_name, owner_email, paddle_subscription_id, is_paid, plan_status');
    if (shopId) query = query.eq('id', shopId);
    else query = query.not('paddle_subscription_id', 'is', null).limit(100);
    const { data: shops, error } = await query;
    if (error) throw error;

    const results = [];
    for (const shop of shops || []) {
      try {
        if (!shop.paddle_subscription_id) {
          results.push({ shopId: shop.id, success: false, reason: 'no_subscription_id' });
          continue;
        }
        const subscription = await fetchPaddleSubscription(shop.paddle_subscription_id);
        const mapped = mapPaddleStatusToPlan(subscription);
        const { error: updateError } = await supabase.from('shops').update({
          is_paid: mapped.is_paid,
          plan_status: mapped.plan_status,
          subscription_end_date: mapped.subscription_end_date,
          payment_synced_at: new Date().toISOString(),
        }).eq('id', shop.id);
        if (updateError) throw updateError;
        results.push({ shopId: shop.id, success: true, paddleStatus: subscription.status, planStatus: mapped.plan_status });
      } catch (e) {
        results.push({ shopId: shop.id, success: false, reason: e.message });
        await logOpsEvent('warn', 'payment_sync_shop_failed', e.message, { shopId: shop.id }, shop.id);
      }
    }
    await logOpsEvent('info', 'payment_sync_completed', `Payment sync processed ${results.length} shop(s)`, { results });
    res.json({ success: true, results });
  } catch (e) {
    await logOpsEvent('error', 'payment_sync_failed', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/test-alert', adminLimiter, adminAuth, async (_req, res) => {
  try {
    const event = await logOpsEvent('warn', 'test_alert', 'This is a test alert from Smart Reservation operations.');
    res.json({ success: true, eventId: event.id, alertsReady: isAlertConfigured() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/backup', adminLimiter, adminAuth, async (_req, res) => {
  try {
    const tables = ['shops', 'reservations', 'conversations', 'customer_cartes', 'templates', 'ops_events'];
    const backup = {
      format: 'line-ai-bot-backup-v1',
      exportedAt: new Date().toISOString(),
      tables: {},
    };
    for (const table of tables) {
      const { data, error } = await supabase.from(table).select('*').limit(10000);
      backup.tables[table] = error ? { error: error.message, rows: [] } : { rows: data || [] };
    }
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="line-ai-bot-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (e) {
    await logOpsEvent('error', 'backup_failed', e.message);
    res.status(500).json({ error: 'backup_failed' });
  }
});

app.post('/api/admin/restore', adminLimiter, adminAuth, async (req, res) => {
  const { backup, confirm } = req.body || {};
  if (!backup || backup.format !== 'line-ai-bot-backup-v1' || !backup.tables) {
    return res.status(400).json({ success: false, reason: 'invalid_backup' });
  }
  const restorable = ['shops', 'reservations', 'customer_cartes'];
  const summary = {};
  for (const table of restorable) {
    const rows = Array.isArray(backup.tables[table]?.rows) ? backup.tables[table].rows : [];
    summary[table] = rows.filter(row => row && row.id).length;
  }
  if (confirm !== 'RESTORE') {
    return res.json({ success: true, dryRun: true, summary, message: 'Send confirm: RESTORE to upsert rows.' });
  }
  try {
    const restored = {};
    for (const table of restorable) {
      const rows = (backup.tables[table]?.rows || []).filter(row => row && row.id);
      restored[table] = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        if (chunk.length === 0) continue;
        const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'id' });
        if (error) throw error;
        restored[table] += chunk.length;
      }
    }
    await logOpsEvent('critical', 'backup_restored', 'Backup restore was executed', { restored });
    res.json({ success: true, restored });
  } catch (e) {
    await logOpsEvent('error', 'restore_failed', e.message, { summary });
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/register', registerLimiter, requireJWT, async (req, res) => {
  // ✅ JWT から email を取得 — body の email は使わない (なりすまし防止)
  const email = req.user.email;
  const { shopName, businessType, channelSecret, channelToken } = req.body;
  if (!validateRegisterInput({ email, shopName, businessType, channelSecret, channelToken })) {
    return res.json({ success: false, reason: 'invalid_input' });
  }
  try {
    const { data: existing } = await supabase.from('shops').select('id, is_paid').eq('owner_email', email).single();
    if (existing) return res.json({ success: false, reason: 'already_registered', isPaid: existing.is_paid, shopId: existing.id });
    const { data: newShop, error } = await supabase.from('shops').insert({
      owner_email: email, shop_name: shopName, business_type: businessType,
      line_channel_secret: channelSecret, line_channel_access_token: channelToken,
      is_paid: false, plan_status: 'pending', trial_started_at: new Date().toISOString(),
    }).select().single();
    if (error) throw error;
    res.json({ success: true, shopId: newShop.id });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

app.get('/api/calendar/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    if (!isUuid(shopId)) return res.status(404).send('Not found');
    const { token } = req.query;
    const { data: shop } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (!shop) return res.status(404).send('Not found');
    if (!shop.is_paid) return res.status(401).send('Unauthorized');
    if (!safeEqualString(token, makeCalendarToken(shop))) return res.status(403).send('Forbidden');
    const { data: reservations } = await supabase.from('reservations').select('*')
      .eq('shop_id', shopId).eq('status', 'confirmed').order('reservation_date', { ascending: true });
    const calendar = ical({ name: shop.shop_name, timezone: 'Asia/Tokyo' });
    (reservations || []).forEach(r => {
      if (!r.reservation_date || !r.reservation_time) return;
      const startDate = new Date(`${r.reservation_date}T${r.reservation_time}+09:00`);
      const endDate = new Date(startDate.getTime() + (r.duration_minutes || 60) * 60 * 1000);
      calendar.createEvent({
        start: startDate, end: endDate, timezone: 'Asia/Tokyo',
        summary: `${sanitizeIcalText(r.customer_name) || 'お客様'} - ${sanitizeIcalText(r.service_type) || '予約'}`,
      });
    });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.send(calendar.toString());
  } catch (e) {
    res.status(500).send('Error');
  }
});

app.get('/api/calendar', adminAuth, async (req, res) => {
  try {
    const { data: reservations } = await supabase.from('reservations').select('*').order('reservation_date', { ascending: true });
    const calendar = ical({ name: 'スマート予約Pro - 全予約', timezone: 'Asia/Tokyo' });
    (reservations || []).forEach(r => {
      if (!r.reservation_date || !r.reservation_time) return;
      const startDate = new Date(`${r.reservation_date}T${r.reservation_time}+09:00`);
      const endDate = new Date(startDate.getTime() + (r.duration_minutes || 60) * 60 * 1000);
      calendar.createEvent({ start: startDate, end: endDate, timezone: 'Asia/Tokyo',
        summary: `${sanitizeIcalText(r.customer_name) || 'お客様'} - ${sanitizeIcalText(r.service_type) || '予約'}` });
    });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.send(calendar.toString());
  } catch (e) {
    res.status(500).send('Error');
  }
});

app.get('/api/shop-analytics', requireJWT, async (req, res) => {
  const { shopId } = req.query;
  if (!isUuid(shopId)) return res.status(400).json({ error: 'invalid shopId' });
  try {
    const { data: shop } = await supabase.from('shops')
      .select('owner_email, menu_items').eq('id', shopId).single();
    if (!shop || shop.owner_email !== req.user.email) return res.status(403).json({ error: 'Forbidden' });

    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const thisMonth = jstNow.toISOString().slice(0, 7);
    const lastMonthDate = new Date(jstNow.getFullYear(), jstNow.getMonth() - 1, 1);
    const lastMonth = lastMonthDate.toISOString().slice(0, 7);

    const { data: reservations } = await supabase.from('reservations')
      .select('customer_name, service_type, reservation_date, reservation_time, line_user_id')
      .eq('shop_id', shopId).eq('status', 'confirmed')
      .gte('reservation_date', lastMonth + '-01')
      .order('reservation_date', { ascending: true });

    const all = reservations || [];
    const thisMonthRes = all.filter(r => r.reservation_date?.startsWith(thisMonth));
    const lastMonthRes = all.filter(r => r.reservation_date?.startsWith(lastMonth));

    const menuPrices = {};
    (shop.menu_items || []).forEach(m => { menuPrices[m.name] = m.price || 0; });
    const calcRevenue = (list) => list.reduce((sum, r) => sum + (menuPrices[r.service_type] || 0), 0);

    const thisRevenue = calcRevenue(thisMonthRes);
    const lastRevenue = calcRevenue(lastMonthRes);
    const revGrowth = lastRevenue > 0 ? Math.round((thisRevenue - lastRevenue) / lastRevenue * 100) : null;
    const countGrowth = lastMonthRes.length > 0 ? Math.round((thisMonthRes.length - lastMonthRes.length) / lastMonthRes.length * 100) : null;

    const userCounts = {};
    thisMonthRes.forEach(r => { userCounts[r.line_user_id] = (userCounts[r.line_user_id] || 0) + 1; });
    const returnCount = Object.values(userCounts).filter(c => c >= 2).length;
    const uniqueCount = Object.keys(userCounts).length;
    const returnRate = uniqueCount > 0 ? Math.round(returnCount / uniqueCount * 100) : 0;

    const menuCount = {};
    thisMonthRes.forEach(r => { if (r.service_type) menuCount[r.service_type] = (menuCount[r.service_type] || 0) + 1; });
    const topMenus = Object.entries(menuCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => ({ name, count }));

    const timeCount = {};
    thisMonthRes.forEach(r => { if (r.reservation_time) { const h = String(r.reservation_time).slice(0, 2) + ':00'; timeCount[h] = (timeCount[h] || 0) + 1; } });
    const topTimes = Object.entries(timeCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([time, count]) => ({ time, count }));

    const DAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
    const dayCount = {};
    thisMonthRes.forEach(r => { if (r.reservation_date) { const d = DAY_JA[new Date(r.reservation_date + 'T00:00:00+09:00').getDay()]; dayCount[d] = (dayCount[d] || 0) + 1; } });
    const topDays = Object.entries(dayCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([day, count]) => ({ day, count }));

    const automationSavings = Math.round(thisMonthRes.length * 0.5 * 1121);

    res.json({ thisMonth: { count: thisMonthRes.length, revenue: thisRevenue, countGrowth, revGrowth }, returnRate, topMenus, topTimes, topDays, automationSavings });
  } catch (e) {
    res.status(500).json({ error: 'error' });
  }
});

// ── 강화 1: 6개월 트렌드 API ──────────────────────────
app.get('/api/shop-analytics-trend', requireJWT, async (req, res) => {
  const { shopId } = req.query;
  if (!isUuid(shopId)) return res.status(400).json({ error: 'invalid shopId' });
  try {
    const { data: shop } = await supabase.from('shops')
      .select('owner_email, menu_items').eq('id', shopId).single();
    if (!shop || shop.owner_email !== req.user.email)
      return res.status(403).json({ error: 'Forbidden' });

    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(jstNow.getFullYear(), jstNow.getMonth() - i, 1);
      months.push({
        year:  d.getFullYear(),
        month: d.getMonth() + 1,
        label: `${d.getFullYear()}年${d.getMonth() + 1}月`,
        shortLabel: `${d.getMonth() + 1}月`,
      });
    }

    const menuPriceMap = {};
    (shop.menu_items || []).forEach(m => { menuPriceMap[m.name] = m.price || 0; });

    const results = await Promise.all(months.map(async m => {
      const from = `${m.year}-${String(m.month).padStart(2,'0')}-01`;
      const lastDay = new Date(m.year, m.month, 0).getDate();
      const to   = `${m.year}-${String(m.month).padStart(2,'0')}-${lastDay}`;
      const { data } = await supabase.from('reservations')
        .select('service_type')
        .eq('shop_id', shopId).eq('status', 'confirmed')
        .gte('reservation_date', from).lte('reservation_date', to);
      const count   = (data || []).length;
      const revenue = (data || []).reduce((s, r) => s + (menuPriceMap[r.service_type] || 0), 0);
      return { ...m, count, revenue };
    }));

    // 전월 대비 성장률 계산
    results.forEach((m, i) => {
      if (i === 0) { m.growth = null; return; }
      const prev = results[i - 1].count;
      m.growth = prev > 0 ? Math.round((m.count - prev) / prev * 100) : null;
    });

    res.json({ months: results });
  } catch (e) {
    res.status(500).json({ error: 'error' });
  }
});

// ── 강화 2: 고객 세그먼트 API ────────────────────────────
app.get('/api/shop-analytics-segment', requireJWT, async (req, res) => {
  const { shopId } = req.query;
  if (!isUuid(shopId)) return res.status(400).json({ error: 'invalid shopId' });
  try {
    const { data: shop } = await supabase.from('shops')
      .select('owner_email, menu_items').eq('id', shopId).single();
    if (!shop || shop.owner_email !== req.user.email)
      return res.status(403).json({ error: 'Forbidden' });

    const menuPriceMap = {};
    (shop.menu_items || []).forEach(m => { menuPriceMap[m.name] = m.price || 0; });

    const { data: cartes } = await supabase.from('customer_cartes')
      .select('line_user_id, visit_count, last_visit_date')
      .eq('shop_id', shopId);

    const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];

    let vip = 0, repeat = 0, newCustomers = 0, sleeping = 0;
    (cartes || []).forEach(c => {
      const isSleeping = !c.last_visit_date || c.last_visit_date < threeMonthsAgo;
      if (isSleeping) { sleeping++; return; }
      if ((c.visit_count || 0) >= 3) vip++;
      else if ((c.visit_count || 0) === 2) repeat++;
      else newCustomers++;
    });

    // VIP 매출 비율
    const { data: allRes } = await supabase.from('reservations')
      .select('line_user_id, service_type')
      .eq('shop_id', shopId).eq('status', 'confirmed');

    const userSpend = {};
    (allRes || []).forEach(r => {
      userSpend[r.line_user_id] = (userSpend[r.line_user_id] || 0) + (menuPriceMap[r.service_type] || 0);
    });
    const totalRevenue = Object.values(userSpend).reduce((s, v) => s + v, 0);

    const vipUserIds = new Set(
      (cartes || [])
        .filter(c => (c.visit_count || 0) >= 3 && c.last_visit_date >= threeMonthsAgo)
        .map(c => c.line_user_id)
    );
    const vipRevenue = Object.entries(userSpend)
      .filter(([id]) => vipUserIds.has(id))
      .reduce((s, [, v]) => s + v, 0);
    const vipRevenueRate = totalRevenue > 0
      ? Math.round(vipRevenue / totalRevenue * 100) : 0;

    res.json({ vip, repeat, newCustomers, sleeping, vipRevenueRate });
  } catch (e) {
    res.status(500).json({ error: 'error' });
  }
});

// ── 강화 3: AI 경영 어드바이스 API ──────────────────────
app.post('/api/shop-analytics-advice', requireJWT, async (req, res) => {
  const { shopId, analytics } = req.body;
  if (!isUuid(shopId)) return res.status(400).json({ error: 'invalid shopId' });
  try {
    const { data: shop } = await supabase.from('shops')
      .select('owner_email, shop_name, business_type').eq('id', shopId).single();
    if (!shop || shop.owner_email !== req.user.email)
      return res.status(403).json({ error: 'Forbidden' });

    const prompt = `あなたは日本の小規模サロン・店舗の経営アドバイザーです。
以下の予約データを分析して、店舗オーナーへの具体的なアドバイスを3つ生成してください。

店舗名: ${shop.shop_name}
業種: ${shop.business_type}
今月の予約数: ${analytics?.thisMonth?.count ?? 0}件
先月比: ${analytics?.thisMonth?.countGrowth ?? 0}%
今月の推定売上: ¥${analytics?.thisMonth?.revenue ?? 0}
リピート率: ${analytics?.returnRate ?? 0}%
人気メニュー: ${(analytics?.topMenus || []).map(m => m.name).join('、') || 'データなし'}
人気時間帯: ${(analytics?.topTimes || []).map(t => t.time).join('、') || 'データなし'}
人気曜日: ${(analytics?.topDays || []).map(d => d.day).join('、') || 'データなし'}

以下のJSON形式のみで回答してください。前置き・後置き・マークダウン不要：
{"advices":[{"level":"red","text":"..."},{"level":"yellow","text":"..."},{"level":"green","text":"..."}]}

levelの意味: red=要注意・改善が必要, yellow=チャンス・検討推奨, green=好調・このまま継続
各textは日本語で2文以内、具体的な数字や行動を含めてください。`;

    const aiRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = aiRes.content[0].text.trim();
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch (e) {
    console.error('advice API error:', e);
    res.status(500).json({ error: 'error' });
  }
});

app.get('/api/customer-cartes', requireJWT, async (req, res) => {
  const { shopId } = req.query;
  if (!isUuid(shopId)) return res.status(400).json({ error: 'invalid shopId' });
  try {
    const { data: shop } = await supabase.from('shops').select('owner_email').eq('id', shopId).single();
    if (!shop || shop.owner_email !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    const { data } = await supabase.from('customer_cartes').select('*')
      .eq('shop_id', shopId).order('visit_count', { ascending: false });
    res.json({ cartes: data || [] });
  } catch (e) {
    res.status(500).json({ cartes: [] });
  }
});

app.put('/api/customer-carte/:id', requireJWT, async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ success: false });
  const { memo, shopId } = req.body;
  if (!isUuid(shopId)) return res.status(400).json({ success: false, reason: 'invalid_shop_id' });
  try {
    const { data: shop } = await supabase.from('shops').select('owner_email').eq('id', shopId).single();
    if (!shop || shop.owner_email !== req.user.email) return res.status(403).json({ success: false });
    const safeMemo = typeof memo === 'string' ? memo.slice(0, 500) : '';
    const { error } = await supabase.from('customer_cartes')
      .update({ memo: safeMemo, updated_at: new Date().toISOString() })
      .eq('id', id).eq('shop_id', shopId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// ============================
// LINE Webhook
// ============================
app.post('/webhook/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
      const { data: shop } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (!shop) {
      await logOpsEvent('warn', 'line_shop_not_found', 'LINE webhook received for unknown shop', { shopId }, shopId);
      return res.status(200).json({ status: 'shop_not_found' });
    }
    line.middleware({ channelSecret: shop.line_channel_secret, channelAccessToken: shop.line_channel_access_token })(req, res, async () => {
      const events = req.body.events || [];
      if (!shop.is_paid) {
        if (events.length > 0 && events[0].replyToken) {
          const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: shop.line_channel_access_token });
          try {
            await client.replyMessage({
              replyToken: events[0].replyToken,
              messages: [{ type: 'text', text: 'サービスが停止中です。再開はこちら: https://line-ai-bot-production-2d6d.up.railway.app/' }],
            });
          } catch (_) {}
        }
        return res.status(200).json({ status: 'not_paid' });
      }
      if (shop.subscription_end_date && new Date(shop.subscription_end_date) < new Date()) {
        await supabase.from('shops').update({ is_paid: false, plan_status: 'expired' }).eq('id', shopId);
        return res.status(200).json({ status: 'expired' });
      }
      const { data: template } = await supabase.from('templates').select('*').eq('business_type', shop.business_type).single();
      await Promise.all(events.map(event => handleEvent(event, shop, template)));
      res.status(200).json({ status: 'ok' });
    });
  } catch (err) {
    console.error(err);
    await logOpsEvent('error', 'line_webhook_error', err.message);
    res.status(200).json({ status: 'error' });
  }
});

async function handleEvent(event, shop, template) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: shop.line_channel_access_token });
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const today = jstNow.toISOString().split('T')[0];
  const lineUserId = event.source.userId;
  const userMessage = event.message.text;
  const DAY_NAMES = ['日','月','火','水','木','金','土'];

  // ✅ 메시지 길이 제한 — 응답 처리 비용 폭증 방지
  if (userMessage.length > 2000) {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'メッセージが長すぎます。2000文字以内でお願いします。' }],
    });
    return;
  }

  const latestPending = await getLatestPendingAction(lineUserId, shop.id);
  if (latestPending?.type === 'change' && isConfirmationMessage(userMessage)) {
    let changeMsg = '';
    const oldRes = latestPending.payload.old;
    const nextRes = latestPending.payload.next;
    const lockKeys = [`${shop.id}:${oldRes.date}`, `${shop.id}:${nextRes.date}`].sort().join('|');
    try {
      await withReservationLock(lockKeys, async () => {
	        const validation = validateReservationFields(shop, {
	          name: oldRes.name || 'お客様',
	          service: nextRes.service || oldRes.service || '予約',
	          date: nextRes.date,
	          time: nextRes.time,
	        }, { requireName: false });
        if (!validation.ok) {
          changeMsg = validation.message;
          return;
        }
        const conflict = await checkReservationConflict(shop.id, validation.date, validation.time, validation.durationMinutes, oldRes.id);
        if (conflict) {
          changeMsg = `申し訳ございません。${validation.date} ${validation.time}はすでに予約が入っております。他のお時間はいかがでしょうか？`;
          return;
        }
        const { data: current, error: currentError } = await supabase.from('reservations')
          .select('*').eq('id', oldRes.id).eq('shop_id', shop.id).single();
        if (currentError || !current || current.status !== 'confirmed') {
          changeMsg = '申し訳ございません。変更対象のご予約が見つかりませんでした。';
          return;
        }
        const { error: cancelError } = await supabase.from('reservations')
          .update({ status: 'canceled' }).eq('id', oldRes.id).eq('shop_id', shop.id);
        if (cancelError) throw cancelError;
        const { error: insertError } = await supabase.from('reservations').insert({
          line_user_id: lineUserId,
          shop_id: shop.id,
          customer_name: String(current.customer_name || oldRes.name || 'お客様').slice(0, 100),
          service_type: validation.service,
          reservation_date: validation.date,
          reservation_time: validation.time,
          duration_minutes: validation.durationMinutes,
          status: 'confirmed',
          reminder_sent: false,
        });
        if (insertError) throw insertError;
        changeMsg = `ご予約を変更いたしました。\n\n変更前：${oldRes.date}（${getDayJa(oldRes.date)}） ${String(oldRes.time).slice(0, 5)}\n変更後：${validation.date}（${getDayJa(validation.date)}） ${validation.time}\n✂️ ${validation.service || current.service_type || '-'}`;
        sendEmailNotification(
          shop.owner_email,
          `【予約変更】${current.customer_name || oldRes.name || 'お客様'}様 ${validation.date} ${validation.time}`,
          buildChangeEmailHtml(
            shop.shop_name,
            current.customer_name || oldRes.name,
            { ...oldRes, dayJa: getDayJa(oldRes.date) },
            { ...nextRes, date: validation.date, time: validation.time, service: validation.service, dayJa: getDayJa(validation.date) }
          )
        ).catch(() => {});
        await logOpsEvent('info', 'reservation_changed', 'Reservation changed by LINE confirmation', {
          oldReservationId: oldRes.id,
          oldDate: oldRes.date,
          newDate: validation.date,
        }, shop.id);
      });
    } catch (e) {
      console.error('予約変更確定エラー:', e);
      await logOpsEvent('error', 'reservation_change_failed', e.message, { lineUserId }, shop.id);
      changeMsg = '申し訳ございません。予約変更中にエラーが発生しました。もう一度お試しください。';
    }
    await saveConversation(lineUserId, shop.id, 'user', userMessage);
    await saveConversation(lineUserId, shop.id, 'assistant', changeMsg);
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: changeMsg }] });
    return;
  }

  if (latestPending?.type === 'change_multi') {
    const num = parseInt(userMessage.trim(), 10);
    const list = latestPending.payload.reservations || [];
    if (!isNaN(num) && num >= 1 && num <= list.length) {
      const old = list[num - 1];
      const next = latestPending.payload.next;
      let selectMsg = '';
      try {
        const validation = validateReservationFields(shop, {
          name: old.name || 'お客様',
          service: next.service || old.service || '予約',
          date: next.date,
          time: next.time,
        }, { requireName: false });
        if (!validation.ok) {
          selectMsg = validation.message;
        } else {
          const conflict = await checkReservationConflict(shop.id, validation.date, validation.time, validation.durationMinutes, old.id);
          if (conflict) {
            selectMsg = `申し訳ございません。${validation.date} ${validation.time}はすでに予約が入っております。他のお時間はいかがでしょうか？`;
          } else {
            selectMsg = `以下の内容で予約を変更してよろしいですか？\n\n変更前：${old.date}（${getDayJa(old.date)}） ${String(old.time).slice(0, 5)}\n変更後：${validation.date}（${getDayJa(validation.date)}） ${validation.time}\n✂️ ${validation.service || old.service || '-'}\n\n「はい」または「お願いします」と送信してください。`;
            const saveContent = `${selectMsg}\n[CHANGE_PENDING]${JSON.stringify({
              old,
              next: { ...next, date: validation.date, time: validation.time, service: validation.service || old.service || '予約' },
            })}[/CHANGE_PENDING]`;
            await saveConversation(lineUserId, shop.id, 'user', userMessage);
            await saveConversation(lineUserId, shop.id, 'assistant', saveContent);
            await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: selectMsg }] });
            return;
          }
        }
      } catch (e) {
        console.error('予約変更選択エラー:', e);
        await logOpsEvent('warn', 'reservation_change_failed', e.message, { lineUserId }, shop.id);
        selectMsg = '申し訳ございません。予約変更の確認中にエラーが発生しました。もう一度お試しください。';
      }
      await saveConversation(lineUserId, shop.id, 'user', userMessage);
      await saveConversation(lineUserId, shop.id, 'assistant', selectMsg);
      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: selectMsg }] });
      return;
    }
  }

  // ✅ Feature 1: 취소 대기 단건 확인
  if (latestPending?.type === 'cancel' && isConfirmationMessage(userMessage)) {
    const { id, name, date, time, service } = latestPending.payload;
    const dayJa = DAY_NAMES[new Date(date + 'T00:00:00+09:00').getDay()];
    const t = String(time).slice(0, 5);
    const { data: canceled, error: cancelError } = await supabase.from('reservations')
      .update({ status: 'canceled' }).eq('id', id).eq('shop_id', shop.id).eq('status', 'confirmed')
      .select('id').single();
    if (cancelError || !canceled) {
      const notFoundMsg = '申し訳ございません。キャンセル対象のご予約が見つかりませんでした。';
      await saveConversation(lineUserId, shop.id, 'user', userMessage);
      await saveConversation(lineUserId, shop.id, 'assistant', notFoundMsg);
      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: notFoundMsg }] });
      return;
    }
    const cancelMsg = `ご予約をキャンセルいたしました。\n\n📅 ${date}（${dayJa}） ${t}\n✂️ ${service || '-'}\n\nまたのご利用をお待ちしております。`;
    await saveConversation(lineUserId, shop.id, 'user', userMessage);
    await saveConversation(lineUserId, shop.id, 'assistant', cancelMsg);
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: cancelMsg }] });
    sendEmailNotification(
      shop.owner_email,
      `【キャンセル】${name}様 ${date} ${t}`,
      buildCancelEmailHtml(shop.shop_name, name, date, dayJa, t, service)
    ).catch(() => {});
    return;
  }

  // ✅ Feature 1: 취소 대기 복수 선택
  if (latestPending?.type === 'cancel_multi') {
    const num = parseInt(userMessage.trim(), 10);
    const list = latestPending.payload.reservations || [];
    if (!isNaN(num) && num >= 1 && num <= list.length) {
      const p = list[num - 1];
      const dayJa = DAY_NAMES[new Date(p.date + 'T00:00:00+09:00').getDay()];
      const t = String(p.time).slice(0, 5);
      const { data: canceled, error: cancelError } = await supabase.from('reservations')
        .update({ status: 'canceled' }).eq('id', p.id).eq('shop_id', shop.id).eq('status', 'confirmed')
        .select('id').single();
      if (cancelError || !canceled) {
        const notFoundMsg = '申し訳ございません。キャンセル対象のご予約が見つかりませんでした。';
        await saveConversation(lineUserId, shop.id, 'user', userMessage);
        await saveConversation(lineUserId, shop.id, 'assistant', notFoundMsg);
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: notFoundMsg }] });
        return;
      }
      const cancelMsg = `ご予約をキャンセルいたしました。\n\n📅 ${p.date}（${dayJa}） ${t}\n✂️ ${p.service || '-'}\n\nまたのご利用をお待ちしております。`;
      await saveConversation(lineUserId, shop.id, 'user', userMessage);
      await saveConversation(lineUserId, shop.id, 'assistant', cancelMsg);
      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: cancelMsg }] });
      sendEmailNotification(
        shop.owner_email,
        `【キャンセル】${p.name}様 ${p.date} ${t}`,
        buildCancelEmailHtml(shop.shop_name, p.name, p.date, dayJa, t, p.service)
      ).catch(() => {});
      return;
    }
  }

  const history = await getConversationHistory(lineUserId, shop.id);
  const extraInfo = await getShopExtraInfo(shop.id);

  // ✅ Feature 3: 과거 예약 기억
  const lastRes = await getLastReservation(lineUserId, shop.id);
  const memoryContext = lastRes
    ? `\n以前のご利用：${lastRes.reservation_date} ${lastRes.service_type}（${lastRes.customer_name}様）`
    : '';

  // ✅ Feature 4: 마음을 담은 예약 응대 시스템 프롬프트
  // ✅ VIP 판정 (방문 10회 이상 OR 누적 매출 10만엔 이상)
  const { data: carte } = await supabase
    .from('customer_cartes')
    .select('visit_count')
    .eq('shop_id', shop.id)
    .eq('line_user_id', lineUserId)
    .single();

  const { data: allReservations } = await supabase
    .from('reservations')
    .select('service_type')
    .eq('shop_id', shop.id)
    .eq('line_user_id', lineUserId)
    .eq('status', 'confirmed');

  const menuPriceMap = {};
  (shop.menu_items || []).forEach(m => { menuPriceMap[m.name] = m.price || 0; });
  const totalSpent = (allReservations || []).reduce((sum, r) => sum + (menuPriceMap[r.service_type] || 0), 0);
  const visitCount = carte?.visit_count || 0;
  const isVip = visitCount >= 10 || totalSpent >= 100000;

  const vipGreeting = isVip
    ? `このお客様は${visitCount}回ご来店のVIP顧客です。特別に丁寧で温かみのある対応をしてください。名前で呼びかけ、いつもの感謝を自然に伝えてください。`
    : '';
  const basePrompt = template?.system_prompt || `あなたは${shop.shop_name}の親切な予約アシスタントです。`;
  const fullBasePrompt = basePrompt + (vipGreeting ? `\n\n${vipGreeting}` : '');
  const fullSystemPrompt = `${fullBasePrompt}
今日の日付は${today}です。${extraInfo}${memoryContext}

あなたは親身になって接客する予約専門スタッフです。お客様の気持ちに寄り添い、丁寧で温かみのある対応をしてください。

予約・メニュー・料金・営業時間以外の質問には「申し訳ございませんが、予約に関するご質問のみお答えできます」と答えてください。

	【予約する場合】
	必ず返答の最後に以下のJSON形式を追加してください：
	[RESERVATION]{"name":"お客様名","service":"サービス内容","date":"YYYY-MM-DD","time":"HH:MM"}[/RESERVATION]
	・nameには必ずお客様の実際のお名前を入れてください
	・dateは必ず今日以降の日付にしてください
	・予約タグは、お名前・メニュー・日付・時間がすべて明確で、お客様が予約確定を希望している場合だけ付けてください
	・「空いていますか」「午後」「来週あたり」など未確定の相談では予約タグを付けず、必要な情報を質問してください
	予約情報が不明な場合は[RESERVATION]タグは不要です。

	【キャンセルの場合】
	お客様がキャンセルを希望する場合、返答の最後に以下を追加してください：
	[CANCEL_SEARCH]{"line_user_id":"${lineUserId}"}[/CANCEL_SEARCH]

	【予約変更の場合】
	お客様が既存予約の日時変更を希望し、変更後の日付と時間が分かる場合は返答の最後に以下を追加してください：
	[CHANGE_RESERVATION]{"date":"YYYY-MM-DD","time":"HH:MM","service":"サービス内容"}[/CHANGE_RESERVATION]
	変更後の日付または時間が不明な場合は、必要な情報を質問してください。

【空き状況確認の場合】
特定の日の空き状況を確認したい場合は返答の最後に以下を追加してください：
[AVAIL_CHECK]{"date":"YYYY-MM-DD"}[/AVAIL_CHECK]

マークダウン記号（**など）は使わないでください。`;

  let replyText = '';
  try {
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: fullSystemPrompt,
      messages: [...history, { role: 'user', content: userMessage }],
    });
    replyText = aiResponse.content[0].text;
  } catch (aiError) {
    console.error('응답 처리 오류:', aiError);
    await logOpsEvent('error', 'auto_response_failed', aiError.message, { lineUserId }, shop.id);
    replyText = '申し訳ございません。一時的にサービスが混み合っています。しばらくしてからもう一度お試しください。';
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: replyText }] });
    return;
  }

  await saveConversation(lineUserId, shop.id, 'user', userMessage);

  const changeMatch = replyText.match(/\[CHANGE_RESERVATION\](.*?)\[\/CHANGE_RESERVATION\]/s);
  if (changeMatch) {
    try {
      const changeData = JSON.parse(changeMatch[1]);
      const normalizedTime = normalizeTime(changeData.time);
      const serviceType = String(changeData.service || '').slice(0, 100);
      const cleanReply = replyText.replace(/\[CHANGE_RESERVATION\].*?\[\/CHANGE_RESERVATION\]/gs, '').trim();
      if (!isValidDateString(changeData.date) || !normalizedTime) {
        const askMsg = cleanReply || '変更後の日付と時間を教えてください。（例：2026-05-10 14:00）';
        await saveConversation(lineUserId, shop.id, 'assistant', askMsg);
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: askMsg }] });
        return;
      }

      const { data: found } = await supabase.from('reservations')
        .select('id, customer_name, reservation_date, reservation_time, service_type')
        .eq('shop_id', shop.id).eq('line_user_id', lineUserId).eq('status', 'confirmed')
        .order('reservation_date', { ascending: true });

      if (!found || found.length === 0) {
        const noResMsg = cleanReply || '変更可能なご予約が見つかりませんでした。';
        await saveConversation(lineUserId, shop.id, 'assistant', noResMsg);
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: noResMsg }] });
        return;
      }
      if (found.length > 1) {
        const listText = found.map((r, i) =>
          `${i + 1}. ${r.reservation_date}（${getDayJa(r.reservation_date)}） ${String(r.reservation_time).slice(0, 5)} ${r.service_type || ''}`
        ).join('\n');
        const multiMsg = `変更したいご予約が複数あります。まず変更前のご予約を番号で教えてください：\n\n${listText}`;
        const pendingList = found.map(r => ({ id: r.id, name: r.customer_name, date: r.reservation_date, time: r.reservation_time, service: r.service_type }));
        const saveContent = `${multiMsg}\n[CHANGE_PENDING_MULTI]${JSON.stringify({
          reservations: pendingList,
          next: { date: changeData.date, time: normalizedTime, service: serviceType || '予約' },
        })}[/CHANGE_PENDING_MULTI]`;
        await saveConversation(lineUserId, shop.id, 'assistant', saveContent);
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: multiMsg }] });
        return;
      }

      const old = found[0];
      const next = {
        date: changeData.date,
        time: normalizedTime,
        service: serviceType || old.service_type || '予約',
      };
      const validation = validateReservationFields(shop, {
        name: old.customer_name || 'お客様',
        service: next.service,
        date: next.date,
        time: next.time,
      }, { requireName: false });
      if (!validation.ok) {
        await saveConversation(lineUserId, shop.id, 'assistant', validation.message);
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: validation.message }] });
        return;
      }
      const conflict = await checkReservationConflict(shop.id, validation.date, validation.time, validation.durationMinutes, old.id);
      if (conflict) {
        const conflictMsg = `申し訳ございません。${validation.date} ${validation.time}はすでに予約が入っております。他のお時間はいかがでしょうか？`;
        await saveConversation(lineUserId, shop.id, 'assistant', conflictMsg);
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: conflictMsg }] });
        return;
      }

      const confirmMsg = `以下の内容で予約を変更してよろしいですか？\n\n変更前：${old.reservation_date}（${getDayJa(old.reservation_date)}） ${String(old.reservation_time).slice(0, 5)}\n変更後：${validation.date}（${getDayJa(validation.date)}） ${validation.time}\n✂️ ${validation.service}\n\n「はい」または「お願いします」と送信してください。`;
      const saveContent = `${confirmMsg}\n[CHANGE_PENDING]${JSON.stringify({
        old: { id: old.id, name: old.customer_name, date: old.reservation_date, time: old.reservation_time, service: old.service_type },
        next: { date: validation.date, time: validation.time, service: validation.service },
      })}[/CHANGE_PENDING]`;
      await saveConversation(lineUserId, shop.id, 'assistant', saveContent);
      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: confirmMsg }] });
      return;
    } catch (e) {
      console.error('予約変更準備エラー:', e);
      await logOpsEvent('warn', 'auto_parse_failed', e.message, { tag: 'CHANGE_RESERVATION', lineUserId }, shop.id);
    }
  }

  // ✅ Feature 1: 취소 검색 처리
  const cancelSearchMatch = replyText.match(/\[CANCEL_SEARCH\](.*?)\[\/CANCEL_SEARCH\]/s);
  if (cancelSearchMatch) {
    try {
      const cleanReply = replyText.replace(/\[CANCEL_SEARCH\].*?\[\/CANCEL_SEARCH\]/gs, '').trim();
      const { data: found } = await supabase.from('reservations')
        .select('id, customer_name, reservation_date, reservation_time, service_type')
        .eq('shop_id', shop.id).eq('line_user_id', lineUserId).eq('status', 'confirmed')
        .order('reservation_date', { ascending: true });

      if (!found || found.length === 0) {
        const noResMsg = cleanReply || 'キャンセル可能なご予約が見つかりませんでした。';
        await saveConversation(lineUserId, shop.id, 'assistant', noResMsg);
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: noResMsg }] });
        return;
      }

      if (found.length === 1) {
        const r = found[0];
        const dayJa = DAY_NAMES[new Date(r.reservation_date + 'T00:00:00+09:00').getDay()];
        const confirmMsg = `以下のご予約のキャンセルでよろしいですか？\n\n📅 ${r.reservation_date}（${dayJa}） ${String(r.reservation_time).slice(0,5)}\n✂️ ${r.service_type || '-'}\n\n「はい」または「キャンセルします」と送信してください。`;
        const saveContent = `${confirmMsg}\n[CANCEL_PENDING]${JSON.stringify({ id: r.id, name: r.customer_name, date: r.reservation_date, time: r.reservation_time, service: r.service_type })}[/CANCEL_PENDING]`;
        await saveConversation(lineUserId, shop.id, 'assistant', saveContent);
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: confirmMsg }] });
      } else {
        const listText = found.map((r, i) => {
          const dayJa = DAY_NAMES[new Date(r.reservation_date + 'T00:00:00+09:00').getDay()];
          return `${i+1}. ${r.reservation_date}（${dayJa}） ${String(r.reservation_time).slice(0,5)} ${r.service_type || ''}`;
        }).join('\n');
        const multiMsg = `キャンセルするご予約の番号を入力してください：\n\n${listText}`;
        const pendingList = found.map(r => ({ id: r.id, name: r.customer_name, date: r.reservation_date, time: r.reservation_time, service: r.service_type }));
        const saveContent = `${multiMsg}\n[CANCEL_PENDING_MULTI]${JSON.stringify(pendingList)}[/CANCEL_PENDING_MULTI]`;
        await saveConversation(lineUserId, shop.id, 'assistant', saveContent);
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: multiMsg }] });
      }
      return;
	    } catch (e) {
	      console.error('キャンセル検索エラー:', e);
	      await logOpsEvent('warn', 'auto_parse_failed', e.message, { tag: 'CANCEL_SEARCH', lineUserId }, shop.id);
	    }
	  }

  // ✅ Feature 2: 공석 확인 처리
  let finalReply = replyText
    .replace(/\[CANCEL_SEARCH\].*?\[\/CANCEL_SEARCH\]/gs, '')
    .replace(/\[CHANGE_RESERVATION\].*?\[\/CHANGE_RESERVATION\]/gs, '')
    .replace(/\[AVAIL_CHECK\].*?\[\/AVAIL_CHECK\]/gs, '')
    .replace(/\[RESERVATION\].*?\[\/RESERVATION\]/gs, '')
    .trim();

  const availCheckMatch = replyText.match(/\[AVAIL_CHECK\](.*?)\[\/AVAIL_CHECK\]/s);
  if (availCheckMatch) {
    try {
      const { date } = JSON.parse(availCheckMatch[1]);
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const slots = await getAvailableSlots(shop.id, date);
        const dayJa = DAY_NAMES[new Date(date + 'T00:00:00+09:00').getDay()];
        if (!slots) {
          finalReply += `\n\n${date}（${dayJa}）の空き状況を確認できませんでした。`;
        } else if (slots.closed) {
          finalReply += `\n\n${date}（${dayJa}）は定休日となっております。`;
        } else if (slots.available.length === 0) {
          finalReply += `\n\n${date}（${dayJa}）は満席です。他の日程はいかがでしょうか？`;
        } else {
          finalReply += `\n\n${date}（${dayJa}）の空き時間帯：\n${slots.available.join('、')}`;
        }
      }
	    } catch (e) {
	      console.error('空き確認エラー:', e);
	      await logOpsEvent('warn', 'auto_parse_failed', e.message, { tag: 'AVAIL_CHECK', lineUserId }, shop.id);
	    }
	  }

  // ✅ Feature 1/7: 예약 처리 + 이메일 알림 + 리피트 메시지
  const reservationMatch = replyText.match(/\[RESERVATION\](.*?)\[\/RESERVATION\]/s);
  if (reservationMatch) {
    try {
      const reservationData = JSON.parse(reservationMatch[1]);
      const validation = validateReservationFields(shop, {
        name: reservationData.name,
        service: reservationData.service,
        date: reservationData.date,
        time: reservationData.time,
      });

      if (!validation.ok) {
        finalReply = validation.message;
      } else {
        await withReservationLock(`${shop.id}:${validation.date}`, async () => {
          const customerName = validation.name;
          const serviceType  = validation.service;
          const conflict = await checkReservationConflict(shop.id, validation.date, validation.time, validation.durationMinutes);
          if (conflict) {
            finalReply = `申し訳ございません。${validation.date} ${validation.time}はすでに予約が入っております。他のお時間はいかがでしょうか？`;
            return;
          }

          const { error } = await supabase.from('reservations').insert({
            line_user_id: lineUserId, shop_id: shop.id,
            customer_name: customerName, service_type: serviceType,
            reservation_date: validation.date, reservation_time: validation.time,
            duration_minutes: validation.durationMinutes,
            status: 'confirmed', reminder_sent: false,
          });
          if (error) {
            if (error.code === '23505') {
              finalReply = `申し訳ございません。${validation.date} ${validation.time}はすでに予約が入っております。他のお時間はいかがでしょうか？`;
              return;
            }
            throw error;
          }
          const dayJaConfirm = DAY_NAMES[new Date(validation.date + 'T00:00:00+09:00').getDay()];
          const timeShort = validation.time.slice(0, 5);
          const revisitWeeks = REVISIT_WEEKS[shop.business_type] || 4;

          const confirmBase = `ご予約を承りました✅\n\n📅 ${validation.date}（${dayJaConfirm}） ${timeShort}\n✂️ ${serviceType}\n\nご来店をお待ちしております😊`;
          const confirmSeed = `\n\n──────────────\n⏰ 当日のご案内\nもし予定が変わった場合は、お早めに「キャンセル」とお送りください。\n前日までのご連絡で、他のお客様にご案内できます🙏\n\n💡 次回の目安は約${revisitWeeks}週間後です\n次回ご希望の際は「予約」とお送りください\n──────────────`;

          finalReply = finalReply || (confirmBase + confirmSeed);

          // ✅ Feature 7: 신규 예약 이메일 알림
          const dayJa = DAY_NAMES[new Date(validation.date + 'T00:00:00+09:00').getDay()];
          sendEmailNotification(
            shop.owner_email,
            `【新規予約】${customerName}様 ${validation.date} ${validation.time}`,
            buildNewResEmailHtml(shop.shop_name, customerName, validation.date, dayJa, validation.time, serviceType)
          ).catch(() => {});

          updateCustomerCarte(shop.id, lineUserId, customerName, validation.date).catch(() => {});

          if (shop.review_request_enabled && shop.google_review_url) {
            finalReply += `\n\n⭐ よろしければ口コミをお願いします！\n${String(shop.google_review_url).replace(/[\n\r]/g, '')}`;
          }

          // ✅ Feature 5/6: 리피트 메시지 (repeat_message_enabled !== false 이면 전송)
          if (shop.repeat_message_enabled !== false) {
            finalReply += `\n\n${getReturnVisitMessage(shop.business_type)}`;
          }
        });
      }
	    } catch (e) {
	      console.error('予約処理エラー:', e);
	      await logOpsEvent('error', 'reservation_processing_failed', e.message, { lineUserId }, shop.id);
	    }
	  }

  if (!finalReply || finalReply.trim() === '') {
    finalReply = 'ご用件をお聞かせください。予約のご希望やご質問にお答えします。';
  }

  await saveConversation(lineUserId, shop.id, 'assistant', finalReply);
  await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: finalReply }] });
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
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
  sanitizeClosedDays,
};
