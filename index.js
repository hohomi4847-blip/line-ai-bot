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
const ical = require('ical-generator').default;
const cron = require('node-cron');
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

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

const JWT_SECRET = process.env.SESSION_SECRET; // fallback 없음 — 위 REQUIRED_ENV 검증으로 보장
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
// query string 지원 제거 — 서버 로그에 패스워드 평문 노출 방지
function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!pw || pw !== process.env.ADMIN_PASSWORD) {
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

// ✅ iCal 텍스트 정제 (HTML 이스케이프 금지 — iCal은 평문, 라이브러리가 자체 처리)
function sanitizeIcalText(str) {
  if (!str) return '';
  return String(str).replace(/[\r\n\t]/g, ' ').slice(0, 200);
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

// ✅ 기억하는 AI — 마지막 예약 조회
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

// ✅ 확인 메시지 판정
function isConfirmationMessage(msg) {
  const t = msg.trim().toLowerCase();
  return ['はい', 'yes', 'ok', 'ｏｋ', 'お願いします', 'おねがいします', 'キャンセルします', 'キャンセルして'].some(
    w => t === w || t === w + '!' || t === w + '！'
  );
}

// ✅ 이메일 HTML 빌더 (캔슬)
function buildCancelEmailHtml(shopName, name, date, dayJa, time, service) {
  const t = String(time || '').slice(0, 5);
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <h2 style="color:#DC2626;">【キャンセル通知】</h2>
    <p style="color:#555;margin-bottom:16px;">店舗：${shopName}</p>
    <table style="width:100%;border-collapse:collapse;">
      <tr><th style="background:#fef2f2;padding:10px;border:1px solid #dde;text-align:left;width:35%;">お客様名</th><td style="padding:10px;border:1px solid #dde;">${name||'-'}</td></tr>
      <tr><th style="background:#fef2f2;padding:10px;border:1px solid #dde;text-align:left;">予約日時</th><td style="padding:10px;border:1px solid #dde;">${date}（${dayJa}）${t}</td></tr>
      <tr><th style="background:#fef2f2;padding:10px;border:1px solid #dde;text-align:left;">メニュー</th><td style="padding:10px;border:1px solid #dde;">${service||'-'}</td></tr>
    </table>
    <p style="margin-top:20px;"><a href="https://line-ai-bot-production-2d6d.up.railway.app/shop-dashboard.html" style="color:#06C755;font-weight:bold;">ダッシュボードで確認 →</a></p>
  </div>`;
}

// ✅ 이메일 HTML 빌더 (신규 예약)
function buildNewResEmailHtml(shopName, name, date, dayJa, time, service) {
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <h2 style="color:#06C755;">【新規予約通知】</h2>
    <p style="color:#555;margin-bottom:16px;">店舗：${shopName}</p>
    <table style="width:100%;border-collapse:collapse;">
      <tr><th style="background:#f0f9f4;padding:10px;border:1px solid #dde;text-align:left;width:35%;">お客様名</th><td style="padding:10px;border:1px solid #dde;">${name}</td></tr>
      <tr><th style="background:#f0f9f4;padding:10px;border:1px solid #dde;text-align:left;">予約日時</th><td style="padding:10px;border:1px solid #dde;">${date}（${dayJa}）${time}</td></tr>
      <tr><th style="background:#f0f9f4;padding:10px;border:1px solid #dde;text-align:left;">メニュー</th><td style="padding:10px;border:1px solid #dde;">${service}</td></tr>
    </table>
    <p style="margin-top:20px;"><a href="https://line-ai-bot-production-2d6d.up.railway.app/shop-dashboard.html" style="color:#06C755;font-weight:bold;">ダッシュボードで確認する →</a></p>
  </div>`;
}

// ✅ Resend 이메일 알림 (실패해도 예약/취소에 영향 없음)
async function sendEmailNotification(ownerEmail, subject, bodyHtml) {
  if (!resend || !ownerEmail) return;
  try {
    await resend.emails.send({
      from: 'LINE AI予約ボット <onboarding@resend.dev>',
      to: ownerEmail,
      subject,
      html: bodyHtml,
    });
    console.log(`✅ メール送信: ${subject}`);
  } catch (e) {
    console.error('メール送信失敗:', e.message);
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
          if (error) console.error('shop 활성화 실패:', error);
          else console.log(`✅ shop 활성화 완료`);
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
app.post('/api/admin/activate-shop', adminLimiter, adminAuth, async (req, res) => {
  const { shopId, activate } = req.body;
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
  if (!shopId) return res.status(400).json({ error: 'shopId required' });
  try {
    const { data } = await supabase.from('shops')
      .select('shop_description, business_hours, menu_items, closed_days, reservation_interval, repeat_message_enabled, owner_email')
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
    const allowedFields = ['shop_description', 'business_hours', 'menu_items', 'closed_days', 'reservation_interval', 'repeat_message_enabled'];
    const safeUpdate = {};
    allowedFields.forEach(f => { if (updateData[f] !== undefined) safeUpdate[f] = updateData[f]; });
    // ✅ shop_description 길이 제한 — AI 시스템 프롬프트 토큰 폭증 방지
    if (typeof safeUpdate.shop_description === 'string' && safeUpdate.shop_description.length > 500) {
      return res.status(400).json({ success: false, reason: 'description_too_long' });
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
    const calendar = ical({ name: 'LINE AI予約ボット - 全予約', timezone: 'Asia/Tokyo' });
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
  const DAY_NAMES = ['日','月','火','水','木','金','土'];

  // ✅ 메시지 길이 제한 — AI 비용 폭증 방지
  if (userMessage.length > 2000) {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'メッセージが長すぎます。2000文字以内でお願いします。' }],
    });
    return;
  }

  // ✅ Feature 1: 취소 대기 단건 확인
  const pendingCancel = await checkPendingCancelInHistory(lineUserId, shop.id);
  if (pendingCancel && isConfirmationMessage(userMessage)) {
    const { id, name, date, time, service } = pendingCancel;
    const dayJa = DAY_NAMES[new Date(date + 'T00:00:00+09:00').getDay()];
    const t = String(time).slice(0, 5);
    await supabase.from('reservations').update({ status: 'canceled' }).eq('id', id);
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
  const pendingMulti = await checkPendingMultiCancelInHistory(lineUserId, shop.id);
  if (pendingMulti) {
    const num = parseInt(userMessage.trim(), 10);
    const list = pendingMulti.reservations;
    if (!isNaN(num) && num >= 1 && num <= list.length) {
      const p = list[num - 1];
      const dayJa = DAY_NAMES[new Date(p.date + 'T00:00:00+09:00').getDay()];
      const t = String(p.time).slice(0, 5);
      await supabase.from('reservations').update({ status: 'canceled' }).eq('id', p.id);
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

  // ✅ Feature 3: 기억하는 AI — 과거 예약 기억
  const lastRes = await getLastReservation(lineUserId, shop.id);
  const memoryContext = lastRes
    ? `\n以前のご利用：${lastRes.reservation_date} ${lastRes.service_type}（${lastRes.customer_name}様）`
    : '';

  // ✅ Feature 4: 마음을 담은 컨설턴트 AI 시스템 프롬프트
  const basePrompt = template?.system_prompt || `あなたは${shop.shop_name}の親切なAI予約アシスタントです。`;
  const fullSystemPrompt = `${basePrompt}
今日の日付は${today}です。${extraInfo}${memoryContext}

あなたは親身になって接客する予約専門AIです。お客様の気持ちに寄り添い、丁寧で温かみのある対応をしてください。

予約・メニュー・料金・営業時間以外の質問には「申し訳ございませんが、予約に関するご質問のみお答えできます」と答えてください。

【予約する場合】
必ず返答の最後に以下のJSON形式を追加してください：
[RESERVATION]{"name":"お客様名","service":"サービス内容","date":"YYYY-MM-DD","time":"HH:MM"}[/RESERVATION]
・nameには必ずお客様の実際のお名前を入れてください
・dateは必ず今日以降の日付にしてください
予約情報が不明な場合は[RESERVATION]タグは不要です。

【キャンセル・変更の場合】
お客様がキャンセルや変更を希望する場合、返答の最後に以下を追加してください：
[CANCEL_SEARCH]{"line_user_id":"${lineUserId}"}[/CANCEL_SEARCH]

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
    console.error('AI 오류:', aiError);
    replyText = '申し訳ございません。一時的にサービスが混み合っています。しばらくしてからもう一度お試しください。';
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: replyText }] });
    return;
  }

  await saveConversation(lineUserId, shop.id, 'user', userMessage);

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
    }
  }

  // ✅ Feature 2: 공석 확인 처리
  let finalReply = replyText
    .replace(/\[CANCEL_SEARCH\].*?\[\/CANCEL_SEARCH\]/gs, '')
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
    }
  }

  // ✅ Feature 1/7: 예약 처리 + 이메일 알림 + 리피트 메시지
  const reservationMatch = replyText.match(/\[RESERVATION\](.*?)\[\/RESERVATION\]/s);
  if (reservationMatch) {
    try {
      const reservationData = JSON.parse(reservationMatch[1]);
      const normalizedTime = normalizeTime(reservationData.time);
      const invalidNames = ['お客様名', 'お客様', '名前', 'name'];

      if (!reservationData.name || invalidNames.includes(reservationData.name)) {
        finalReply = finalReply || 'ご予約のお名前を教えていただけますか？';
      } else if (!normalizedTime) {
        finalReply = finalReply || 'ご予約の時間を正しくお知らせください。（例：14:00）';
      } else if (!reservationData.date || !/^\d{4}-\d{2}-\d{2}$/.test(reservationData.date)) {
        finalReply = finalReply || 'ご予約の日付を正しくお知らせください。（例：2026-05-01）';
      } else if (isPastDate(reservationData.date, normalizedTime)) {
        finalReply = '申し訳ございません。過去の日時は予約できません。改めてご希望の日時をお聞かせください。';
      } else {
        const conflict = await checkReservationConflict(shop.id, reservationData.date, normalizedTime);
        if (conflict) {
          finalReply = `申し訳ございません。${reservationData.date} ${normalizedTime}はすでに予約が入っております。他のお時間はいかがでしょうか？`;
        } else {
          const customerName = String(reservationData.name).slice(0, 100);
          const serviceType  = String(reservationData.service || '予約').slice(0, 100);
          await supabase.from('reservations').insert({
            line_user_id: lineUserId, shop_id: shop.id,
            customer_name: customerName, service_type: serviceType,
            reservation_date: reservationData.date, reservation_time: normalizedTime,
            status: 'confirmed', reminder_sent: false,
          });
          finalReply = finalReply || `ご予約を承りました！\n📅 ${reservationData.date} ${normalizedTime}\n✂️ ${serviceType}\nお待ちしております。`;

          // ✅ Feature 7: 신규 예약 이메일 알림
          const dayJa = DAY_NAMES[new Date(reservationData.date + 'T00:00:00+09:00').getDay()];
          sendEmailNotification(
            shop.owner_email,
            `【新規予約】${customerName}様 ${reservationData.date} ${normalizedTime}`,
            buildNewResEmailHtml(shop.shop_name, customerName, reservationData.date, dayJa, normalizedTime, serviceType)
          ).catch(() => {});

          // ✅ Feature 5/6: 리피트 메시지 (repeat_message_enabled !== false 이면 전송)
          if (shop.repeat_message_enabled !== false) {
            finalReply += `\n\n${getReturnVisitMessage(shop.business_type)}`;
          }
        }
      }
    } catch (e) {
      console.error('予約処理エラー:', e);
    }
  }

  if (!finalReply || finalReply.trim() === '') {
    finalReply = 'ご用件をお聞かせください。予約のご希望やご質問にお答えします。';
  }

  await saveConversation(lineUserId, shop.id, 'assistant', finalReply);
  await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: finalReply }] });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
});