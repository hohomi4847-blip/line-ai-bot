require('dotenv').config();
const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const ical = require('ical-generator').default;
const cron = require('node-cron');

const app = express();

// ✅ Paddle webhook은 raw body 필요 - 반드시 먼저
app.use('/paddle/webhook', express.raw({ type: 'application/json' }));

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const JWT_SECRET = process.env.SESSION_SECRET || 'fallback-secret';
const JWT_EXPIRES = '7d';

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
function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.adminPassword;
  if (pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: '認証が必要です' });
  }
  next();
}

// ✅ 입력값 검증
function validateRegisterInput({ email, shopName, businessType, channelSecret, channelToken }) {
  if (!email || !shopName || !businessType || !channelSecret || !channelToken) return false;
  if (typeof email !== 'string' || !email.includes('@')) return false;
  if (shopName.length > 100) return false;
  return true;
}

// ✅ XSS 방지
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ✅ 시간 정규화
function normalizeTime(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
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
  await supabase.from('conversations').insert({
    line_user_id: lineUserId,
    shop_id: shopId,
    role,
    content,
  });
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

async function checkReservationConflict(shopId, date, time, durationMinutes = 60) {
  const { data } = await supabase
    .from('reservations')
    .select('reservation_time, duration_minutes')
    .eq('shop_id', shopId)
    .eq('reservation_date', date)
    .eq('status', 'confirmed');

  if (!data || data.length === 0) return false;
  const newStart = timeToMinutes(time);
  const newEnd = newStart + durationMinutes;
  return data.some(r => {
    const existStart = timeToMinutes(r.reservation_time);
    const existEnd = existStart + (r.duration_minutes || 60);
    return newStart < existEnd && newEnd > existStart;
  });
}

async function sendReminders() {
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
      }
    }
  } catch (e) {
    console.error('리마인더 오류:', e);
  }
}

cron.schedule('0 0 * * *', sendReminders, { timezone: 'UTC' });
cron.schedule('0 1 * * 1', cleanOldConversations, { timezone: 'UTC' });
console.log('⏰ 스케줄러 시작');

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
    return res.status(401).json({ error: 'Server misconfiguration' });
  }

  const sig     = req.headers['paddle-signature'];
  const rawBody = req.body.toString();

  if (!verifyPaddleSignature(rawBody, sig, webhookSecret)) {
    console.warn(`⚠️ [Paddle] 서명 검증 실패 | IP=${req.ip} | Paddle-Signature: ${sig || '(없음)'}`);
    return res.status(401).json({ error: 'Invalid signature' });
  }
  console.log(`✅ [Paddle] 서명 검증 성공 | IP=${req.ip}`);

  // ── 2단계: 비즈니스 로직 — Paddle 재시도 방지를 위해 항상 200 반환 ──
  try {
    const body = JSON.parse(rawBody);
    const eventType = body.event_type;

    // Paddle v2 webhook: customData は custom_data (snake_case) で届く
    // camelCase フォールバックも念のため確認
    const shopId = body.data?.custom_data?.shopId
                || body.data?.customData?.shopId
                || null;
    const customerEmail = body.data?.customer?.email || null;

    console.log(`📦 Paddle webhook: ${eventType} | shopId=${shopId} | email=${customerEmail}`);

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

    if (eventType === 'transaction.completed' || eventType === 'subscription.created') {
      if (!shopId && !customerEmail) {
        console.warn('⚠️ shopId も email もなし — スキップ');
      } else {
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 30);
        const q = buildQuery('shops', {
          is_paid: true,
          plan_status: 'active',
          paddle_subscription_id: body.data?.subscription_id || body.data?.id || null,
          trial_started_at: new Date().toISOString(),
          subscription_end_date: trialEnd.toISOString(),
        });
        if (q) {
          const { error } = await q;
          if (error) console.error('shop 활성화 실패:', error);
          else console.log(`✅ shop 활성화 완료`);
        }
      }
    }

    if (eventType === 'subscription.canceled') {
      if (!shopId && !customerEmail) {
        console.warn('⚠️ shopId も email もなし — スキップ');
      } else {
        const q = buildQuery('shops', {
          plan_status: 'canceled',
          subscription_end_date: body.data?.canceled_at || new Date().toISOString(),
        });
        if (q) {
          const { error } = await q;
          if (error) console.error('subscription.canceled 업데이트 실패:', error);
          else console.log(`🚫 구독 취소 완료`);
        }
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
          if (error) console.error('transaction.refunded 업데이트 실패:', error);
          else console.log(`💰 환불 완료`);
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (e) {
    console.error('Paddle webhook 오류:', e);
    res.status(200).json({ received: true });
  }
});

// ============================
// API
// ============================
app.get('/api/shop-login', async (req, res) => {
  const { email } = req.query;
  if (!email || !email.includes('@')) return res.json({ success: false });
  try {
    const { data: shop } = await supabase.from('shops').select('*').eq('owner_email', email).single();
    if (!shop) return res.json({ success: false });
    if (shop.subscription_end_date && new Date(shop.subscription_end_date) < new Date()) {
      await supabase.from('shops').update({ is_paid: false, plan_status: 'expired' }).eq('id', shop.id);
      shop.is_paid = false;
    }
    const { line_channel_secret, line_channel_access_token, ...safeShop } = shop;
    res.json({ success: true, shop: safeShop });
  } catch (e) {
    res.json({ success: false });
  }
});

app.post('/api/admin/activate-shop', adminAuth, async (req, res) => {
  const { shopId, activate } = req.body;
  try {
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
  if (!shopId) return res.status(400).json({ error: 'shopId required' });
  try {
    const { data } = await supabase.from('shops')
      .select('shop_description, business_hours, menu_items, closed_days, reservation_interval, owner_email')
      .eq('id', shopId).single();
    if (!data || data.owner_email !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    const { owner_email, ...safeData } = data;
    res.json(safeData);
  } catch (e) {
    res.status(500).json({});
  }
});

app.get('/api/shop-reservations', requireJWT, async (req, res) => {
  const { shopId } = req.query;
  if (!shopId) return res.status(400).json({ error: 'shopId required' });
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
  if (!reservationId || !shopId) return res.status(400).json({ success: false });
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
  if (!shopId) return res.status(400).json({ success: false });
  try {
    const { data: shop } = await supabase.from('shops').select('id')
      .eq('id', shopId).eq('owner_email', req.user.email).single();
    if (!shop) return res.status(403).json({ success: false });
    const allowedFields = ['shop_description', 'business_hours', 'menu_items', 'closed_days', 'reservation_interval'];
    const safeUpdate = {};
    allowedFields.forEach(f => { if (updateData[f] !== undefined) safeUpdate[f] = updateData[f]; });
    const { error } = await supabase.from('shops').update(safeUpdate).eq('id', shopId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/dashboard', adminAuth, async (req, res) => {
  try {
    const jstToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { data: reservations } = await supabase.from('reservations').select('*').order('created_at', { ascending: false });
    const { data: shops } = await supabase.from('shops')
      .select('id, shop_name, business_type, owner_email, is_paid, plan_status, created_at')
      .order('created_at', { ascending: false });
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

app.post('/api/register', requireJWT, async (req, res) => {
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
    const { token } = req.query;
    const { data: shop } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (!shop) return res.status(404).send('Not found');
    if (token !== shop.owner_email.slice(0, 4)) return res.status(403).send('Forbidden');
    const { data: reservations } = await supabase.from('reservations').select('*')
      .eq('shop_id', shopId).eq('status', 'confirmed').order('reservation_date', { ascending: true });
    const calendar = ical({ name: shop.shop_name, timezone: 'Asia/Tokyo' });
    (reservations || []).forEach(r => {
      if (!r.reservation_date || !r.reservation_time) return;
      const startDate = new Date(`${r.reservation_date}T${r.reservation_time}+09:00`);
      const endDate = new Date(startDate.getTime() + (r.duration_minutes || 60) * 60 * 1000);
      calendar.createEvent({
        start: startDate, end: endDate, timezone: 'Asia/Tokyo',
        summary: `${escapeHtml(r.customer_name) || 'お客様'} - ${escapeHtml(r.service_type) || '予約'}`,
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
    const calendar = ical({ name: 'LINE AI予約ボット - 全予約', timezone: 'Asia/Tokyo' });
    (reservations || []).forEach(r => {
      if (!r.reservation_date || !r.reservation_time) return;
      const startDate = new Date(`${r.reservation_date}T${r.reservation_time}+09:00`);
      const endDate = new Date(startDate.getTime() + (r.duration_minutes || 60) * 60 * 1000);
      calendar.createEvent({ start: startDate, end: endDate, timezone: 'Asia/Tokyo',
        summary: `${r.customer_name || 'お客様'} - ${r.service_type || '予約'}` });
    });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.send(calendar.toString());
  } catch (e) {
    res.status(500).send('Error');
  }
});

// ============================
// LINE Webhook
// ============================
app.post('/webhook/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { data: shop } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (!shop) return res.status(200).json({ status: 'shop_not_found' });
    if (!shop.is_paid) return res.status(200).json({ status: 'not_paid' });
    if (shop.subscription_end_date && new Date(shop.subscription_end_date) < new Date()) {
      await supabase.from('shops').update({ is_paid: false, plan_status: 'expired' }).eq('id', shopId);
      return res.status(200).json({ status: 'expired' });
    }
    const { data: template } = await supabase.from('templates').select('*').eq('business_type', shop.business_type).single();
    line.middleware({ channelSecret: shop.line_channel_secret, channelAccessToken: shop.line_channel_access_token })(req, res, async () => {
      const events = req.body.events || [];
      await Promise.all(events.map(event => handleEvent(event, shop, template)));
      res.status(200).json({ status: 'ok' });
    });
  } catch (err) {
    console.error(err);
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
  const history = await getConversationHistory(lineUserId, shop.id);
  const extraInfo = await getShopExtraInfo(shop.id);
  const systemPrompt = template?.system_prompt || `あなたは${shop.shop_name}の親切なAI予約アシスタントです。`;

  let replyText = '';
  try {
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `${systemPrompt}\n今日の日付は${today}です。${extraInfo}\n予約・メニュー・料金・営業時間以外の質問には「申し訳ございませんが、予約に関するご質問のみお答えできます」と答えてください。\n予約を取る場合は、必ず以下のJSON形式を返答の最後に追加してください：\n[RESERVATION]{"name":"お客様名","service":"サービス内容","date":"YYYY-MM-DD","time":"HH:MM"}[/RESERVATION]\n・nameには必ずお客様の実際のお名前を入れてください\n・dateは必ず今日以降の日付にしてください\n予約情報が不明な場合は[RESERVATION]タグは不要です。\nマークダウン記号（**など）は使わないでください。`,
      messages: [...history, { role: 'user', content: userMessage }],
    });
    replyText = aiResponse.content[0].text;
  } catch (aiError) {
    console.error('AI 오류:', aiError);
    replyText = '申し訳ございません。一時的にサービスが混み合っています。しばらくしてからもう一度お試しください。';
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: replyText }] });
    return;
  }

  await saveConversation(lineUserId, shop.id, 'user', userMessage);
  const cleanReply = replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/gs, '').trim();
  await saveConversation(lineUserId, shop.id, 'assistant', cleanReply);

  const reservationMatch = replyText.match(/\[RESERVATION\](.*?)\[\/RESERVATION\]/s);
  if (reservationMatch) {
    try {
      const reservationData = JSON.parse(reservationMatch[1]);
      const normalizedTime = normalizeTime(reservationData.time);
      const invalidNames = ['お客様名', 'お客様', '名前', 'name'];
      if (!reservationData.name || invalidNames.includes(reservationData.name)) {
        replyText = cleanReply || 'ご予約のお名前を教えていただけますか？';
      } else if (isPastDate(reservationData.date, normalizedTime)) {
        replyText = '申し訳ございません。過去の日時は予約できません。改めてご希望の日時をお聞かせください。';
      } else {
        const conflict = await checkReservationConflict(shop.id, reservationData.date, normalizedTime);
        if (conflict) {
          replyText = `申し訳ございません。${reservationData.date} ${normalizedTime}はすでに予約が入っております。他のお時間はいかがでしょうか？`;
        } else {
          await supabase.from('reservations').insert({
            line_user_id: lineUserId, shop_id: shop.id,
            customer_name: reservationData.name, service_type: reservationData.service,
            reservation_date: reservationData.date, reservation_time: normalizedTime,
            status: 'confirmed', reminder_sent: false,
          });
          replyText = cleanReply || `ご予約を承りました！\n📅 ${reservationData.date} ${normalizedTime}\n✂️ ${reservationData.service}\nお待ちしております。`;
        }
      }
    } catch (e) {
      replyText = cleanReply;
    }
  } else {
    replyText = cleanReply;
  }

  if (!replyText || replyText.trim() === '') {
    replyText = 'ご用件をお聞かせください。予約のご希望やご質問にお答えします。';
  }

  await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: replyText }] });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
});