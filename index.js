require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const anthropic = new Anthropic();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(200).json({ status: 'error' });
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userMessage = event.message.text;
  const lineUserId = event.source.userId;

  const aiResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: `あなたは日本の美容室の親切なAI予約アシスタントです。
日本語で返答してください。
予約を取る場合は、必ず以下のJSON形式を返答の最後に追加してください：
[RESERVATION]{"name":"お客様名","service":"サービス内容","date":"YYYY-MM-DD","time":"HH:MM"}[/RESERVATION]
予約情報が不明な場合は[RESERVATION]タグは不要です。
マークダウン記号（**など）は使わないでください。`,
    messages: [{ role: 'user', content: userMessage }],
  });

  let replyText = aiResponse.content[0].text;

  // 예약 정보 추출 및 저장
  const reservationMatch = replyText.match(/\[RESERVATION\](.*?)\[\/RESERVATION\]/s);
  if (reservationMatch) {
    try {
      const reservationData = JSON.parse(reservationMatch[1]);
      await supabase.from('reservations').insert({
        line_user_id: lineUserId,
        customer_name: reservationData.name,
        service_type: reservationData.service,
        reservation_date: reservationData.date,
        reservation_time: reservationData.time,
        status: 'confirmed',
      });
      replyText = replyText.replace(/\[RESERVATION\].*?\[\/RESERVATION\]/s, '').trim();
    } catch (e) {
      console.error('예약 저장 오류:', e);
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