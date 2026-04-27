require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 대시보드 API
app.get('/api/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: reservations } = await supabase
      .from('reservations')
      .select('*')
      .order('created_at', { ascending: false });

    const { data: shops } = await supabase
      .from('shops')
      .select('*')
      .order('created_at', { ascending: false });

    const todayReservations = reservations.filter(r => r.reservation_date === today).length;

    res.json({
      totalReservations: reservations.length,
      todayReservations,
      totalShops: shops.length,
      reservations,
      shops,
    });
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
      owner_email: email,
      shop_name: shopName,
      business_type: businessType,
      line_channel_secret: channelSecret,
      line_channel_access_token: channelToken,
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false });
  }
});

// LINE Webhook - 가게별 동적 처리
app.post('/webhook/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;

    const { data: shop } = await supabase
      .from('shops')
      .select('*')
      .eq('id', shopId)
      .single();

    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const { data: template } = await supabase
      .from('templates')
      .select('*')
      .eq('business_type', shop.business_type)
      .single();

    const lineConfig = {
      channelSecret: shop.line_channel_secret,
      channelAccessToken: shop.line_channel_access_token,
    };

    const lineMiddleware = line.middleware(lineConfig);

    lineMiddleware(req, res, async () => {
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
        const aiResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: `あなたは日本の美容室の親切なAI予約アシスタントです。
今日の日付は${today}です。
日本語で返答してください。
予約を取る場合は、必ず以下のJSON形式を返答の最後に追加してください：
[RESERVATION]{"name":"お客様名","service":"サービス内容","date":"YYYY-MM-DD","time":"HH:MM"}[/RESERVATION]
予約情報が不明な場合は[RESERVATION]タグは不要です。
マークダウン記号（**など）は使わないでください。`,
          messages: [{ role: 'user', content: event.message.text }],
        });

        let replyText = aiResponse.content[0].text;
        const reservationMatch = replyText.match(/\[RESERVATION\](.*?)\[\/RESERVATION\]/s);
        if (reservationMatch) {
          try {
            const reservationData = JSON.parse(reservationMatch[1]);
            await supabase.from('reservations').insert({
              line_user_id: event.source.userId,
              customer_name: reservationData.name,
              service_type: reservationData.service,
              reservation_date: reservationData.date,
              reservation_time: reservationData.time,
              status: 'confirmed',
            });
            replyText = replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/s, '').trim();
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

  const aiResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: `${template.system_prompt}
今日の日付は${today}です。
予約を取る場合は、必ず以下のJSON形式を返答の最後に追加してください：
[RESERVATION]{"name":"お客様名","service":"サービス内容","date":"YYYY-MM-DD","time":"HH:MM"}[/RESERVATION]
予約情報が不明な場合は[RESERVATION]タグは不要です。
マークダウン記号（**など）は使わないでください。`,
    messages: [{ role: 'user', content: event.message.text }],
  });

  let replyText = aiResponse.content[0].text;

  const reservationMatch = replyText.match(/\[RESERVATION\](.*?)\[\/RESERVATION\]/s);
  if (reservationMatch) {
    try {
      const reservationData = JSON.parse(reservationMatch[1]);
      await supabase.from('reservations').insert({
        line_user_id: event.source.userId,
        customer_name: reservationData.name,
        service_type: reservationData.service,
        reservation_date: reservationData.date,
        reservation_time: reservationData.time,
        status: 'confirmed',
      });
      replyText = replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/s, '').trim();
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