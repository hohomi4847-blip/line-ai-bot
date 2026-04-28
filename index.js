require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const ical = require('ical-generator').default;
const cron = require('node-cron');

const app = express();

// ✅ Paddle webhook은 raw body 필요 - 반드시 express.json() 보다 먼저
app.use('/paddle/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ✅ 서버에서는 service_role key 사용 (RLS 우회, 보안 강화)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ✅ 운영자 비밀번호 미들웨어
function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.adminPassword;
  if (pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: '認証が必要です' });
  }
  next();
}

// ✅ 입력값 검증 헬퍼
function validateRegisterInput({ email, shopName, businessType, channelSecret, channelToken }) {
  if (!email || !shopName || !businessType || !channelSecret || !channelToken) return false;
  if (typeof email !== 'string' || !email.includes('@')) return false;
  if (shopName.length > 100) return false;
  return true;
}

// ✅ XSS 방지 - HTML 이스케이프
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ✅ 시간 형식 정규화 (9:00 → 09:00)
function normalizeTime(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const hour = parts[0].padStart(2, '0');
  const minute = parts[1].padStart(2, '0');
  return `${hour}:${minute}`;
}

// ✅ 과거 날짜 체크
function isPastDate(date, time) {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr = jstNow.toISOString().split('T')[0];
  if (date < todayStr) return true;
  if (date === todayStr) {
    const currentTime = jstNow.toISOString().split('T')[1].slice(0, 5);
    if (time <= currentTime) return true;
  }
  return false;
}

// 대화 기록 불러오기
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

// 대화 기록 저장
async function saveConversation(lineUserId, shopId, role, content) {
  await supabase.from('conversations').insert({
    line_user_id: lineUserId,
    shop_id: shopId,
    role,
    content,
  });
}

// ✅ 오래된 대화 기록 정리 (30일 이상)
async function cleanOldConversations() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('conversations')
    .delete()
    .lt('created_at', cutoff);
  if (error) console.error('대화 정리 오류:', error);
  else console.log('✅ 오래된 대화 기록 정리 완료');
}

// 가게 추가 정보 불러오기
async function getShopExtraInfo(shopId) {
  const { data: shopSettings } = await supabase
    .from('shops')
    .select('shop_description, business_hours, menu_items')
    .eq('id', shopId)
    .single();

  let extraInfo = '';
  if (shopSettings?.shop_description) {
    extraInfo += `\n店舗情報: ${shopSettings.shop_description}`;
  }
  if (shopSettings?.business_hours) {
    const hours = shopSettings.business_hours;
    const dayNames = { mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日' };
    const hoursText = Object.entries(hours).map(([day, h]) =>
      h.closed ? `${dayNames[day]}:定休日` : `${dayNames[day]}:${h.open}〜${h.close}`
    ).join(', ');
    extraInfo += `\n営業時間: ${hoursText}`;
  }
  if (shopSettings?.menu_items && shopSettings.menu_items.length > 0) {
    const menuText = shopSettings.menu_items.map(m =>
      `${m.name}(${m.price}円・${m.duration}分)`
    ).join(', ');
    extraInfo += `\nメニュー: ${menuText}`;
  }
  return extraInfo;
}

// ✅ 예약 중복 확인 (서비스 시간 기반)
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

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// ✅ 리마인더 발송 함수 (중복 발송 방지 포함)
async function sendReminders() {
  try {
    // JST 기준 내일 날짜
    const now = new Date();
    const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const tomorrow = new Date(jstNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    console.log(`📅 리마인더 발송 시작: ${tomorrowStr}`);

    const { data: reservations } = await supabase
      .from('reservations')
      .select('*, shops(shop_name, line_channel_access_token, is_paid)')
      .eq('reservation_date', tomorrowStr)
      .eq('status', 'confirmed')
      .eq('reminder_sent', false); // ✅ 중복 발송 방지

    if (!reservations || reservations.length === 0) {
      console.log('내일 예약 없음');
      return;
    }

    for (const reservation of reservations) {
      try {
        if (!reservation.shops?.line_channel_access_token) continue;
        if (!reservation.shops?.is_paid) continue; // ✅ 결제된 가게만

        const client = new line.messagingApi.MessagingApiClient({
          channelAccessToken: reservation.shops.line_channel_access_token,
        });

        const message = `【予約リマインダー】
明日のご予約のご確認です。

📅 日時：${reservation.reservation_date} ${reservation.reservation_time ? reservation.reservation_time.slice(0, 5) : ''}
✂️ メニュー：${reservation.service_type || '-'}
🏪 店舗：${reservation.shops.shop_name}

当日のご来店をお待ちしております。
キャンセル・変更は直接ご連絡ください。`;

        await client.pushMessage({
          to: reservation.line_user_id,
          messages: [{ type: 'text', text: message }],
        });

        // ✅ 발송 완료 표시
        await supabase
          .from('reservations')
          .update({ reminder_sent: true })
          .eq('id', reservation.id);

        console.log(`✅ 리마인더 발송 완료: ${reservation.customer_name}`);
      } catch (e) {
        console.error(`❌ 리마인더 발송 실패: ${reservation.customer_name}`, e);
      }
    }
  } catch (e) {
    console.error('리마인더 오류:', e);
  }
}

// ✅ 매일 JST 오전 9시 (UTC 00:00) 리마인더 + 매주 월요일 대화 정리
cron.schedule('0 0 * * *', sendReminders, { timezone: 'UTC' });
cron.schedule('0 1 * * 1', cleanOldConversations, { timezone: 'UTC' });
console.log('⏰ 스케줄러 시작');

// ============================
// ✅ Paddle Webhook
// ============================
app.post('/paddle/webhook', async (req, res) => {
  try {
    const rawBody = req.body.toString();
    const body = JSON.parse(rawBody);
    const eventType = body.event_type;

    console.log('📦 Paddle webhook:', eventType);

    // 결제 완료 또는 구독 생성
    if (eventType === 'transaction.completed' || eventType === 'subscription.created') {
      const customerEmail = body.data?.customer?.email;
      if (customerEmail) {
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 30);

        await supabase.from('shops').update({
          is_paid: true,
          plan_status: 'active',
          paddle_subscription_id: body.data?.subscription_id || body.data?.id || null,
          trial_started_at: new Date().toISOString(),
          subscription_end_date: trialEnd.toISOString(),
        }).eq('owner_email', customerEmail);

        console.log(`✅ shop 활성화: ${customerEmail}`);
      }
    }

    // ✅ 구독 취소 - 즉시 차단 아닌 만료일까지 유지
    if (eventType === 'subscription.canceled') {
      const customerEmail = body.data?.customer?.email;
      const canceledAt = body.data?.canceled_at || new Date().toISOString();
      if (customerEmail) {
        await supabase.from('shops').update({
          plan_status: 'canceled',
          subscription_end_date: canceledAt,
        }).eq('owner_email', customerEmail);
        console.log(`⛔ 구독 취소 (만료일까지 유지): ${customerEmail}`);
      }
    }

    // ✅ 환불 처리
    if (eventType === 'transaction.refunded') {
      const customerEmail = body.data?.customer?.email;
      if (customerEmail) {
        await supabase.from('shops').update({
          is_paid: false,
          plan_status: 'refunded',
        }).eq('owner_email', customerEmail);
        console.log(`💸 환불 처리: ${customerEmail}`);
      }
    }

    res.status(200).json({ received: true });
  } catch (e) {
    console.error('Paddle webhook 오류:', e);
    res.status(200).json({ received: true });
  }
});

// ============================
// API - 가게 로그인
// ============================
app.get('/api/shop-login', async (req, res) => {
  const { email } = req.query;
  if (!email || !email.includes('@')) {
    return res.json({ success: false });
  }
  try {
    const { data: shop } = await supabase
      .from('shops').select('*').eq('owner_email', email).single();
    if (!shop) return res.json({ success: false });

    // ✅ 구독 만료 체크
    if (shop.subscription_end_date) {
      const endDate = new Date(shop.subscription_end_date);
      if (endDate < new Date()) {
        await supabase.from('shops')
          .update({ is_paid: false, plan_status: 'expired' })
          .eq('id', shop.id);
        shop.is_paid = false;
        shop.plan_status = 'expired';
      }
    }

    // LINE 키 등 민감 정보 제외하고 반환
    const { line_channel_secret, line_channel_access_token, ...safeShop } = shop;
    res.json({ success: true, shop: safeShop });
  } catch (e) {
    res.json({ success: false });
  }
});

// ✅ 가게 수동 활성화 API (운영자용)
app.post('/api/admin/activate-shop', adminAuth, async (req, res) => {
  const { shopId, activate } = req.body;
  try {
    const { error } = await supabase
      .from('shops')
      .update({
        is_paid: activate,
        plan_status: activate ? 'active' : 'suspended',
      })
      .eq('id', shopId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// 가게 설정 불러오기
app.get('/api/shop-settings', async (req, res) => {
  const { shopId } = req.query;
  if (!shopId) return res.json({});
  try {
    const { data: shop } = await supabase
      .from('shops')
      .select('shop_description, business_hours, menu_items, closed_days, reservation_interval')
      .eq('id', shopId).single();
    res.json(shop || {});
  } catch (e) {
    res.json({});
  }
});

// 가게 예약 불러오기
app.get('/api/shop-reservations', async (req, res) => {
  const { shopId } = req.query;
  if (!shopId) return res.json({ reservations: [] });
  try {
    const { data: reservations } = await supabase
      .from('reservations').select('*')
      .eq('shop_id', shopId)
      .order('reservation_date', { ascending: true });
    res.json({ reservations: reservations || [] });
  } catch (e) {
    res.json({ reservations: [] });
  }
});

// ✅ 예약 취소 API (가게 오너용)
app.post('/api/cancel-reservation', async (req, res) => {
  const { reservationId, shopId } = req.body;
  if (!reservationId || !shopId) return res.json({ success: false });
  try {
    const { error } = await supabase
      .from('reservations')
      .update({ status: 'canceled' })
      .eq('id', reservationId)
      .eq('shop_id', shopId); // shopId 일치 확인으로 타인 예약 취소 방지
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// ✅ 가게 설정 업데이트 (shopId 소유권 확인)
app.post('/api/shop-update', async (req, res) => {
  const { shopId, ownerEmail, ...updateData } = req.body;
  if (!shopId || !ownerEmail) return res.json({ success: false });

  try {
    // ✅ shopId와 ownerEmail 일치 확인 (타인 수정 방지)
    const { data: shop } = await supabase
      .from('shops').select('id').eq('id', shopId).eq('owner_email', ownerEmail).single();
    if (!shop) return res.status(403).json({ success: false, error: '権限がありません' });

    // 허용된 필드만 업데이트
    const allowedFields = ['shop_description', 'business_hours', 'menu_items', 'closed_days', 'reservation_interval'];
    const safeUpdate = {};
    allowedFields.forEach(f => { if (updateData[f] !== undefined) safeUpdate[f] = updateData[f]; });

    const { error } = await supabase.from('shops').update(safeUpdate).eq('id', shopId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ✅ 운영자 대시보드 API (인증 필요)
app.get('/api/dashboard', adminAuth, async (req, res) => {
  try {
    const today = new Date();
    const jstToday = new Date(today.getTime() + 9 * 60 * 60 * 1000);
    const todayStr = jstToday.toISOString().split('T')[0];

    const { data: reservations } = await supabase
      .from('reservations').select('*').order('created_at', { ascending: false });
    const { data: shops } = await supabase
      .from('shops').select('id, shop_name, business_type, owner_email, is_paid, plan_status, created_at')
      .order('created_at', { ascending: false });

    const safeReservations = reservations || [];
    const safeShops = shops || [];
    const todayReservations = safeReservations.filter(r => r.reservation_date === todayStr).length;

    res.json({
      totalReservations: safeReservations.length,
      todayReservations,
      totalShops: safeShops.length,
      reservations: safeReservations,
      shops: safeShops,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'error' });
  }
});

// ✅ 가입 API - 중복 체크 + 입력값 검증 + shopId 반환
app.post('/api/register', async (req, res) => {
  const { email, shopName, businessType, channelSecret, channelToken } = req.body;

  if (!validateRegisterInput({ email, shopName, businessType, channelSecret, channelToken })) {
    return res.json({ success: false, reason: 'invalid_input' });
  }

  try {
    const { data: existing } = await supabase
      .from('shops').select('id, is_paid').eq('owner_email', email).single();

    if (existing) {
      return res.json({
        success: false,
        reason: 'already_registered',
        isPaid: existing.is_paid,
        shopId: existing.id,
      });
    }

    const { data: newShop, error } = await supabase
      .from('shops')
      .insert({
        owner_email: email,
        shop_name: shopName,
        business_type: businessType,
        line_channel_secret: channelSecret,
        line_channel_access_token: channelToken,
        is_paid: false,
        plan_status: 'pending',
        trial_started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, shopId: newShop.id });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ✅ iCalendar - 토큰 인증 추가
app.get('/api/calendar/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { token } = req.query;

    const { data: shop } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (!shop) return res.status(404).send('Shop not found');

    // ✅ 간단한 토큰 검증 (shopId + 이메일 앞 4자리)
    const expectedToken = shop.owner_email.slice(0, 4);
    if (token !== expectedToken) return res.status(403).send('Forbidden');

    const { data: reservations } = await supabase
      .from('reservations').select('*').eq('shop_id', shopId)
      .eq('status', 'confirmed')
      .order('reservation_date', { ascending: true });

    const calendar = ical({ name: shop.shop_name, timezone: 'Asia/Tokyo' });
    (reservations || []).forEach(r => {
      if (!r.reservation_date || !r.reservation_time) return;
      // ✅ 타임존 JST 적용
      const startDate = new Date(`${r.reservation_date}T${r.reservation_time}+09:00`);
      const duration = r.duration_minutes || 60;
      const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
      calendar.createEvent({
        start: startDate,
        end: endDate,
        timezone: 'Asia/Tokyo',
        summary: `${escapeHtml(r.customer_name) || 'お客様'} - ${escapeHtml(r.service_type) || '予約'}`,
        description: `サービス: ${r.service_type || '-'}\nステータス: ${r.status}`,
      });
    });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.send(calendar.toString());
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// ✅ 운영자용 전체 캘린더 (인증 필요)
app.get('/api/calendar', adminAuth, async (req, res) => {
  try {
    const { data: reservations } = await supabase
      .from('reservations').select('*').order('reservation_date', { ascending: true });
    const calendar = ical({ name: 'LINE AI予約ボット - 全予約', timezone: 'Asia/Tokyo' });
    (reservations || []).forEach(r => {
      if (!r.reservation_date || !r.reservation_time) return;
      const startDate = new Date(`${r.reservation_date}T${r.reservation_time}+09:00`);
      const duration = r.duration_minutes || 60;
      const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
      calendar.createEvent({
        start: startDate,
        end: endDate,
        timezone: 'Asia/Tokyo',
        summary: `${r.customer_name || 'お客様'} - ${r.service_type || '予約'}`,
        description: `サービス: ${r.service_type || '-'}\nステータス: ${r.status}`,
      });
    });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.send(calendar.toString());
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// ============================
// LINE Webhook - 가게별
// ============================
app.post('/webhook/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { data: shop } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (!shop) return res.status(200).json({ status: 'shop_not_found' });

    // ✅ 결제 여부 + 만료일 체크
    if (!shop.is_paid) {
      console.log(`⛔ 미결제 가게: ${shop.shop_name}`);
      return res.status(200).json({ status: 'not_paid' });
    }
    if (shop.subscription_end_date && new Date(shop.subscription_end_date) < new Date()) {
      await supabase.from('shops').update({ is_paid: false, plan_status: 'expired' }).eq('id', shopId);
      return res.status(200).json({ status: 'expired' });
    }

    // ✅ 템플릿 없어도 기본값으로 동작
    const { data: template } = await supabase
      .from('templates').select('*').eq('business_type', shop.business_type).single();

    const lineConfig = {
      channelSecret: shop.line_channel_secret,
      channelAccessToken: shop.line_channel_access_token,
    };

    line.middleware(lineConfig)(req, res, async () => {
      const events = req.body.events || [];
      await Promise.all(events.map(event => handleEvent(event, shop, template)));
      res.status(200).json({ status: 'ok' });
    });
  } catch (err) {
    console.error(err);
    res.status(200).json({ status: 'error' });
  }
});

// ============================
// 이벤트 처리
// ============================
async function handleEvent(event, shop, template) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: shop.line_channel_access_token,
  });

  // ✅ JST 기준 오늘 날짜
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = jstNow.toISOString().split('T')[0];

  const lineUserId = event.source.userId;
  const userMessage = event.message.text;

  const history = await getConversationHistory(lineUserId, shop.id);
  const extraInfo = await getShopExtraInfo(shop.id);

  // ✅ 템플릿 없을 때 기본 프롬프트 사용
  const systemPrompt = template?.system_prompt ||
    `あなたは${shop.shop_name}の親切なAI予約アシスタントです。`;

  let replyText = '';

  try {
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `${systemPrompt}
今日の日付は${today}です。${extraInfo}
予約・メニュー・料金・営業時間以外の質問には「申し訳ございませんが、予約に関するご質問のみお答えできます」と答えてください。
予約を取る場合は、必ず以下のJSON形式を返答の最後に追加してください：
[RESERVATION]{"name":"お客様名","service":"サービス内容","date":"YYYY-MM-DD","time":"HH:MM"}[/RESERVATION]
・nameには必ずお客様の実際のお名前を入れてください（「お客様名」という文字列は使わないでください）
・dateは必ず今日以降の日付にしてください
・過去の日付は絶対に使わないでください
予約情報が不明な場合は[RESERVATION]タグは不要です。
マークダウン記号（**など）は使わないでください。`,
      messages: [...history, { role: 'user', content: userMessage }],
    });

    replyText = aiResponse.content[0].text;
  } catch (aiError) {
    // ✅ AI 오류 시 사용자에게 안내 메시지
    console.error('AI 오류:', aiError);
    replyText = '申し訳ございません。一時的にサービスが混み合っています。しばらくしてからもう一度お試しください。';
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: replyText }],
    });
    return;
  }

  // 대화 저장
  await saveConversation(lineUserId, shop.id, 'user', userMessage);

  const cleanReply = replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/gs, '').trim();
  await saveConversation(lineUserId, shop.id, 'assistant', cleanReply);

  // 예약 처리
  const reservationMatch = replyText.match(/\[RESERVATION\](.*?)\[\/RESERVATION\]/s);
  if (reservationMatch) {
    try {
      const reservationData = JSON.parse(reservationMatch[1]);

      // ✅ 시간 형식 정규화
      const normalizedTime = normalizeTime(reservationData.time);

      // ✅ 이름이 플레이스홀더인지 체크
      const invalidNames = ['お客様名', 'お客様', '名前', 'name'];
      if (!reservationData.name || invalidNames.includes(reservationData.name)) {
        replyText = cleanReply || 'ご予約のお名前を教えていただけますか？';
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: replyText }],
        });
        return;
      }

      // ✅ 과거 날짜 체크
      if (isPastDate(reservationData.date, normalizedTime)) {
        replyText = '申し訳ございません。過去の日時は予約できません。改めてご希望の日時をお聞かせください。';
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: replyText }],
        });
        return;
      }

      // ✅ 중복 체크
      const conflict = await checkReservationConflict(shop.id, reservationData.date, normalizedTime);
      if (conflict) {
        replyText = `申し訳ございません。${reservationData.date} ${normalizedTime}はすでに予約が入っております。他のお時間はいかがでしょうか？`;
      } else {
        await supabase.from('reservations').insert({
          line_user_id: lineUserId,
          shop_id: shop.id,
          customer_name: reservationData.name,
          service_type: reservationData.service,
          reservation_date: reservationData.date,
          reservation_time: normalizedTime,
          status: 'confirmed',
          reminder_sent: false,
        });
        replyText = cleanReply || `ご予約を承りました！\n📅 ${reservationData.date} ${normalizedTime}\n✂️ ${reservationData.service}\nお待ちしております。`;
      }
    } catch (e) {
      console.error('예약 처리 오류:', e);
      replyText = cleanReply;
    }
  } else {
    replyText = cleanReply;
  }

  // ✅ 빈 응답 방지
  if (!replyText || replyText.trim() === '') {
    replyText = 'ご用件をお聞かせください。予約のご希望やご質問にお答えします。';
  }

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: replyText }],
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
});