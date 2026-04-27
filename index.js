require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const ical = require('ical-generator').default;
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function getConversationHistory(lineUserId, shopId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('line_user_id', lineUserId)
    .eq('shop_id', shopId || 'default')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(10);
  return data || [];
}

async function saveConversation(lineUserId, shopId, role, content) {
  await supabase.from('conversations').insert({
    line_user_id: lineUserId,
    shop_id: shopId || 'default',
    role,
    content,
  });
}

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

async function checkReservationConflict(shopId, date, time) {
  const { data } = await supabase
    .from('reservations')
    .select('id')
    .eq('shop_id', shopId)
    .eq('reservation_date', date)
    .eq('reservation_time', time)
    .eq('status', 'confirmed');
  return data && data.length > 0;
}

// 리마인더 발송 함수
async function sendReminders() {
  try {
    // 일본 시간 기준 내일 날짜 계산
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    console.log(`📅 리마인더 발송 시작: ${tomorrowStr}`);

    // 내일 예약 목록 불러오기
    const { data: reservations } = await supabase
      .from('reservations')
      .select('*, shops(shop_name, line_channel_access_token)')
      .eq('reservation_date', tomorrowStr)
      .eq('status', 'confirmed');

    if (!reservations || reservations.length === 0) {
      console.log('내일 예약 없음');
      return;
    }

    for (const reservation of reservations) {
      try {
        if (!reservation.shops?.line_channel_access_token) continue;

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

        console.log(`✅ 리마인더 발송 완료: ${reservation.customer_name}`);
      } catch (e) {
        console.error(`❌ 리마인더 발송 실패: ${reservation.customer_name}`, e);
      }
    }
  } catch (e) {
    console.error('리마인더 오류:', e);
  }
}

// 매일 오전 9시 (일본 시간 = UTC 0시) 리마인더 발송
cron.schedule('0 0 * * *', sendReminders);
console.log('⏰ 리마인더 스케줄러 시작');

// 가게 로그인 API
app.get('/api/shop-login', async (req, res) => {
  const { email } = req.query;
  try {
    const { data: shop } = await supabase
      .from('shops').select('*').eq('owner_email', email).single();
    if (!shop) return res.json({ success: false });
    res.json({ success: true, shop });
  } catch (e) {
    res.json({ success: false });
  }
});

// 가게 설정 불러오기 API
app.get('/api/shop-settings', async (req, res) => {
  const { shopId } = req.query;
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

// 가게 예약 불러오기 API
app.get('/api/shop-reservations', async (req, res) => {
  const { shopId } = req.query;
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

// 가게 설정 업데이트 API
app.post('/api/shop-update', async (req, res) => {
  const { shopId, ...updateData } = req.body;
  try {
    const { error } = await supabase
      .from('shops').update(updateData).eq('id', shopId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// 대시보드 API
app.get('/api/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: reservations } = await supabase
      .from('reservations').select('*').order('created_at', { ascending: false });
    const { data: shops } = await supabase
      .from('shops').select('*').order('created_at', { ascending: false });
    const todayReservations = reservations.filter(r => r.reservation_date === today).length;
    res.json({ totalReservations: reservations.length, todayReservations, totalShops: shops.length, reservations, shops });
  } catch (e) {
    console.error(e);
    res.json({ error: 'error' });
  }
});

// 가입 API
app.post('/api/register', async (req, res) => {
  const { email, shopName, businessType, channelSecret, channelToken } = req.body;
  try {
    const { error } = await supabase.from('shops').insert({
      owner_email: email, shop_name: shopName, business_type: businessType,
      line_channel_secret: channelSecret, line_channel_access_token: channelToken,
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// iCalendar 피드 API
app.get('/api/calendar/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { data: shop } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (!shop) return res.status(404).send('Shop not found');
    const { data: reservations } = await supabase
      .from('reservations').select('*').eq('shop_id', shopId).order('created_at', { ascending: false });
    const calendar = ical({ name: shop.shop_name });
    (reservations || []).forEach(r => {
      if (!r.reservation_date || !r.reservation_time) return;
      const startDate = new Date(`${r.reservation_date}T${r.reservation_time}`);
      const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
      calendar.createEvent({
        start: startDate, end: endDate,
        summary: `${r.customer_name || 'お客様'} - ${r.service_type || '予約'}`,
        description: `サービス: ${r.service_type || '-'}\nステータス: ${r.status}`,
      });
    });
    res.set('Content-Type', 'text/calendar');
    res.send(calendar.toString());
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// 전체 예약 캘린더 (운영자용)
app.get('/api/calendar', async (req, res) => {
  try {
    const { data: reservations } = await supabase
      .from('reservations').select('*').order('reservation_date', { ascending: true });
    const calendar = ical({ name: 'LINE AI予約ボット - 全予約' });
    (reservations || []).forEach(r => {
      if (!r.reservation_date || !r.reservation_time) return;
      const startDate = new Date(`${r.reservation_date}T${r.reservation_time}`);
      const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
      calendar.createEvent({
        start: startDate, end: endDate,
        summary: `${r.customer_name || 'お客様'} - ${r.service_type || '予約'}`,
        description: `サービス: ${r.service_type || '-'}\nステータス: ${r.status}`,
      });
    });
    res.set('Content-Type', 'text/calendar');
    res.send(calendar.toString());
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// LINE Webhook - 가게별 동적 처리
app.post('/webhook/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { data: shop } = await supabase.from('shops').select('*').eq('id', shopId).single();
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    const { data: template } = await supabase
      .from('templates').select('*').eq('business_type', shop.business_type).single();
    const lineConfig = {
      channelSecret: shop.line_channel_secret,
      channelAccessToken: shop.line_channel_access_token,
    };
    line.middleware(lineConfig)(req, res, async () => {
      const events = req.body.events;
      await Promise.all(events.map(event => handleEvent(event, shop, template)));
      res.status(200).json({ status: 'ok' });
    });
  } catch (err) {
    console.error(err);
    res.status(200).json({ status: 'error' });
  }
});

// 기존 webhook (테스트용)
app.post('/webhook', async (req, res) => {
  const lineConfig = {
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  };
  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  });
  line.middleware(lineConfig)(req, res, async () => {
    try {
      const events = req.body.events;
      await Promise.all(events.map(async (event) => {
        if (event.type !== 'message' || event.message.type !== 'text') return;
        const today = new Date().toISOString().split('T')[0];
        const lineUserId = event.source.userId;
        const userMessage = event.message.text;

        const { data: testShop } = await supabase
          .from('shops').select('id').eq('owner_email', 'hohomi4847@gmail.com').single();
        const shopId = testShop?.id || 'default';
        const extraInfo = testShop ? await getShopExtraInfo(shopId) : '';
        const history = await getConversationHistory(lineUserId, shopId);

        const aiResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: `あなたは日本の美容室の親切なAI予約アシスタントです。
今日の日付は${today}です。${extraInfo}
予約・メニュー・料金・営業時間以外の質問には「申し訳ございませんが、予約に関するご質問のみお答えできます」と答えてください。
予約を取る場合は、必ず以下のJSON形式を返答の最後に追加してください：
[RESERVATION]{"name":"お客様名","service":"サービス内容","date":"YYYY-MM-DD","time":"HH:MM"}[/RESERVATION]
予約情報が不明な場合は[RESERVATION]タグは不要です。
マークダウン記号（**など）は使わないでください。`,
          messages: [...history, { role: 'user', content: userMessage }],
        });

        let replyText = aiResponse.content[0].text;

        await saveConversation(lineUserId, shopId, 'user', userMessage);
        await saveConversation(lineUserId, shopId, 'assistant', replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/s, '').trim());

        const reservationMatch = replyText.match(/\[RESERVATION\](.*?)\[\/RESERVATION\]/s);
        if (reservationMatch) {
          try {
            const reservationData = JSON.parse(reservationMatch[1]);
            const conflict = await checkReservationConflict(shopId, reservationData.date, reservationData.time);
            if (conflict) {
              replyText = `申し訳ございません。${reservationData.date} ${reservationData.time}はすでに予約が入っております。他のお時間はいかがでしょうか？`;
            } else {
              await supabase.from('reservations').insert({
                line_user_id: lineUserId,
                shop_id: shopId,
                customer_name: reservationData.name,
                service_type: reservationData.service,
                reservation_date: reservationData.date,
                reservation_time: reservationData.time,
                status: 'confirmed',
              });
              replyText = replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/s, '').trim();
            }
          } catch (e) {
            replyText = replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/s, '').trim();
          }
        }

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: replyText }],
        });
      }));
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error(err);
      res.status(200).json({ status: 'error' });
    }
  });
});

async function handleEvent(event, shop, template) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: shop.line_channel_access_token,
  });
  const today = new Date().toISOString().split('T')[0];
  const lineUserId = event.source.userId;
  const userMessage = event.message.text;

  const history = await getConversationHistory(lineUserId, shop.id);
  const extraInfo = await getShopExtraInfo(shop.id);

  const aiResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: `${template.system_prompt}
今日の日付は${today}です。${extraInfo}
予約・メニュー・料金・営業時間以外の質問には「申し訳ございませんが、予約に関するご質問のみお答えできます」と答えてください。
予約を取る場合は、必ず以下のJSON形式を返答の最後に追加してください：
[RESERVATION]{"name":"お客様名","service":"サービス内容","date":"YYYY-MM-DD","time":"HH:MM"}[/RESERVATION]
予約情報が不明な場合は[RESERVATION]タグは不要です。
マークダウン記号（**など）は使わないでください。`,
    messages: [...history, { role: 'user', content: userMessage }],
  });

  let replyText = aiResponse.content[0].text;

  await saveConversation(lineUserId, shop.id, 'user', userMessage);
  await saveConversation(lineUserId, shop.id, 'assistant', replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/s, '').trim());

  const reservationMatch = replyText.match(/\[RESERVATION\](.*?)\[\/RESERVATION\]/s);
  if (reservationMatch) {
    try {
      const reservationData = JSON.parse(reservationMatch[1]);
      const conflict = await checkReservationConflict(shop.id, reservationData.date, reservationData.time);
      if (conflict) {
        replyText = `申し訳ございません。${reservationData.date} ${reservationData.time}はすでに予約が入っております。他のお時間はいかがでしょうか？`;
      } else {
        await supabase.from('reservations').insert({
          line_user_id: lineUserId,
          shop_id: shop.id,
          customer_name: reservationData.name,
          service_type: reservationData.service,
          reservation_date: reservationData.date,
          reservation_time: reservationData.time,
          status: 'confirmed',
        });
        replyText = replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/s, '').trim();
      }
    } catch (e) {
      replyText = replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/s, '').trim();
    }
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