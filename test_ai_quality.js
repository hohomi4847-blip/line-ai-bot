'use strict';
// AI応答品質テストスクリプト
// 既存コードは一切変更しない — DB書き込みなし、LINE送信なし
require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const SHOP_ID   = 'faf34bc8-9b00-4d3f-aaca-6641ba97b98a';
const TEST_USER = 'U41218eb5ed6e40b8960cb9de6a11afaf';
const MODEL     = 'claude-sonnet-4-6';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── 15 테스트 시나리오 ────────────────────────────────────────
const SCENARIOS = [
  // ─ 基本予約
  {
    id: 1, category: '基本予約',
    msg: '明日の午後2時にカットをお願いしたいです',
    checks: {
      '予約意図の把握': r => /\[RESERVATION\]/.test(r) || /お名前|ご氏名|どなた様/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
      '予約タグの形式': r => !(/\[RESERVATION\]/.test(r)) || /\{.*"date".*"time".*\}/.test(r),
    },
  },
  {
    id: 2, category: '基本予約',
    msg: '来週の土曜日の午前中は空いていますか？',
    checks: {
      '空き確認意図の把握': r => /\[AVAIL_CHECK\]/.test(r) || /空き|空い|ご確認/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
      '日付JSONの形式': r => !(/\[AVAIL_CHECK\]/.test(r)) || /\{"date":"\d{4}-\d{2}-\d{2}"\}/.test(r),
    },
  },
  {
    id: 3, category: '基本予約',
    msg: '週末に予約したいのですが空いていますか？',
    checks: {
      '予約or空き確認の把握': r => /\[AVAIL_CHECK\]|\[RESERVATION\]|空き|空い|ご希望/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  {
    id: 4, category: '基本予約',
    msg: '予約したいです',
    checks: {
      '情報収集（名前・日時の確認）': r => /お名前|ご氏名|日時|日にち|時間|いつ/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
      'プレースホルダー名で予約しない': r => !/\[RESERVATION\].*"name"\s*:\s*"(お客様名|お客様|名前|name)"/.test(r),
    },
  },
  // ─ キャンセル・変更
  {
    id: 5, category: 'キャンセル・変更',
    msg: '予約をキャンセルしたいです',
    checks: {
      'キャンセル意図の把握': r => /\[CANCEL_SEARCH\]/.test(r),
      'キャンセルタグの形式': r => !(/\[CANCEL_SEARCH\]/.test(r)) || /\{"line_user_id":/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  {
    id: 6, category: 'キャンセル・変更',
    msg: '予約した日を変更したいです',
    checks: {
      '変更意図の把握（キャンセル検索）': r => /\[CANCEL_SEARCH\]/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  // ─ 料金・メニュー
  {
    id: 7, category: '料金・メニュー',
    msg: 'カットはいくらですか？',
    checks: {
      '料金情報の案内': r => /円|料金|価格|お値段|\d+/.test(r) || /メニュー|確認|お知らせ/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  {
    id: 8, category: '料金・メニュー',
    msg: 'メニューを教えてください',
    checks: {
      'メニュー情報の案内': r => /メニュー|カット|カラー|パーマ|円|\d+/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  {
    id: 9, category: '料金・メニュー',
    msg: '所要時間はどのくらいですか？',
    checks: {
      '所要時間の案内': r => /分|時間|\d+/.test(r) || /確認|お知らせ/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  // ─ リピーター記憶
  {
    id: 10, category: 'リピーター記憶',
    msg: 'また予約したいです',
    checks: {
      '再予約への対応': r => /お名前|ご氏名|日時|いつ|ありがとう|\[RESERVATION\]/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  // ─ 空き確認
  {
    id: 11, category: '空き確認',
    msg: '今週の土曜日の午後は空いていますか？',
    checks: {
      '空き確認意図の把握': r => /\[AVAIL_CHECK\]/.test(r) || /空き|空い|ご確認/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  {
    id: 12, category: '空き確認',
    msg: '来週の平日で空いている日はありますか？',
    checks: {
      '空き確認意図の把握': r => /\[AVAIL_CHECK\]/.test(r) || /空き|空い|ご確認|日程/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  // ─ 心配り対応
  {
    id: 13, category: '心配り対応',
    msg: '少し遅れそうなのですが大丈夫ですか？',
    checks: {
      '共感・配慮のある返答': r => /大丈夫|ご連絡|お気をつけ|お待ち|ご遠慮なく/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  {
    id: 14, category: '心配り対応',
    msg: 'カラーとカット両方したいのですが、どちらが先がいいですか？',
    checks: {
      '専門的なアドバイス': r => /カラー|カット|先|順番|おすすめ|一般的/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
    },
  },
  // ─ 不適切質問の拒否
  {
    id: 15, category: '不適切質問の拒否',
    msg: '今日の天気は？',
    checks: {
      '予約外質問の拒否': r => /予約に関するご質問のみ|予約に関する/.test(r),
      '日本語の自然さ': r => /[ぁ-ん]/.test(r) && !/\*\*/.test(r),
      '天気情報を答えない': r => !/晴れ|曇り|雨|気温|℃/.test(r),
    },
  },
];

// ── Supabase からショップ情報構築 (index.js の getShopExtraInfo と同じロジック) ──
async function buildExtraInfo(shopId) {
  const { data } = await supabase
    .from('shops')
    .select('shop_description, business_hours, menu_items')
    .eq('id', shopId)
    .single();

  let extra = '';
  if (!data) return extra;

  if (data.shop_description) extra += `\n店舗情報: ${data.shop_description}`;
  if (data.business_hours) {
    const dayNames = { mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日' };
    const hoursText = Object.entries(data.business_hours)
      .map(([d, h]) => h.closed ? `${dayNames[d]}:定休日` : `${dayNames[d]}:${h.open}〜${h.close}`)
      .join(', ');
    extra += `\n営業時間: ${hoursText}`;
  }
  if (data.menu_items?.length > 0) {
    extra += `\nメニュー: ${data.menu_items.map(m => `${m.name}(${m.price}円・${m.duration}分)`).join(', ')}`;
  }
  return extra;
}

// ── 과거 예약 조회 (index.js の getLastReservation と同じロジック) ──
async function getLastReservation(lineUserId, shopId) {
  const { data } = await supabase.from('reservations')
    .select('customer_name, service_type, reservation_date')
    .eq('line_user_id', lineUserId).eq('shop_id', shopId).eq('status', 'confirmed')
    .order('reservation_date', { ascending: false }).limit(1);
  return data?.[0] || null;
}

// ── 시스템 프롬프트 생성 (index.js の fullSystemPrompt と同じロジック) ──
function buildSystemPrompt(shop, template, extraInfo, lastRes, lineUserId) {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const today  = jstNow.toISOString().split('T')[0];

  const memoryContext = lastRes
    ? `\n以前のご利用：${lastRes.reservation_date} ${lastRes.service_type}（${lastRes.customer_name}様）`
    : '';

  const basePrompt = template?.system_prompt || `あなたは${shop.shop_name}の親切なAI予約アシスタントです。`;

  return `${basePrompt}
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
}

// ── 평가 실행 ──────────────────────────────────────────────────
function runChecks(scenario, response) {
  const results = {};
  for (const [label, fn] of Object.entries(scenario.checks)) {
    results[label] = fn(response);
  }
  return results;
}

// ── 구분선 ─────────────────────────────────────────────────────
const SEP  = '━'.repeat(52);
const SEP2 = '─'.repeat(52);

// ── 메인 ──────────────────────────────────────────────────────
async function main() {
  // 환경변수 체크
  const missing = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`❌ 環境変数未設定: ${missing.join(', ')}`);
    process.exit(1);
  }

  // DB에서 shop/template/기억 로드
  const { data: shop } = await supabase.from('shops').select('*').eq('id', SHOP_ID).single();
  if (!shop) { console.error('❌ 店舗データが見つかりません'); process.exit(1); }

  const { data: template } = await supabase.from('templates')
    .select('*').eq('business_type', shop.business_type).single();

  const extraInfo = await buildExtraInfo(SHOP_ID);
  const lastRes   = await getLastReservation(TEST_USER, SHOP_ID);
  const sysPrompt = buildSystemPrompt(shop, template, extraInfo, lastRes, TEST_USER);

  // 헤더 출력
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const runTime = jstNow.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  console.log(`\n${SEP}`);
  console.log('🤖 LINE AI予約ボット — AI応答品質テスト');
  console.log(SEP);
  console.log(`📋 店舗名  : ${shop.shop_name}`);
  console.log(`🏪 業種    : ${shop.business_type}`);
  console.log(`🧠 前回予約: ${lastRes ? `${lastRes.reservation_date} ${lastRes.service_type}（${lastRes.customer_name}様）` : 'なし（テストユーザーの予約履歴なし）'}`);
  console.log(`⏰ 実施日時: ${runTime}`);
  console.log(`🤖 モデル  : ${MODEL}`);
  console.log(SEP);

  // MD 헤더
  const md = [];
  md.push(`# LINE AI予約ボット — AI応答品質テスト結果\n`);
  md.push(`| 項目 | 値 |`);
  md.push(`|------|-----|`);
  md.push(`| 実施日時 | ${runTime} |`);
  md.push(`| 店舗名 | ${shop.shop_name} |`);
  md.push(`| 業種 | ${shop.business_type} |`);
  md.push(`| モデル | ${MODEL} |`);
  md.push(`| 前回予約 | ${lastRes ? `${lastRes.reservation_date} ${lastRes.service_type}（${lastRes.customer_name}様）` : 'なし'} |`);
  md.push(`\n---\n`);

  let totalPass = 0;
  let totalChecks = 0;
  const summaryRows = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n${SEP}`);
    console.log(`テスト ${String(scenario.id).padStart(2, ' ')}/15  [${scenario.category}]`);
    console.log(`💬 ${scenario.msg}`);
    console.log(SEP);

    let response = '';
    let errorMsg = null;
    const t0 = Date.now();

    try {
      const aiRes = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1000,
        system: sysPrompt,
        messages: [{ role: 'user', content: scenario.msg }],
      });
      response = aiRes.content[0].text;
    } catch (e) {
      errorMsg = e.message;
      response = `[AIエラー] ${e.message}`;
    }

    const elapsed = Date.now() - t0;

    // 응답 출력 (태그 제거하여 보기 좋게)
    const displayResponse = response
      .replace(/\[RESERVATION\].*?\[\/RESERVATION\]/gs, '[RESERVATION ...省略...]')
      .replace(/\[CANCEL_SEARCH\].*?\[\/CANCEL_SEARCH\]/gs, '[CANCEL_SEARCH ...省略...]')
      .replace(/\[AVAIL_CHECK\].*?\[\/AVAIL_CHECK\]/gs, '[AVAIL_CHECK ...省略...]');

    console.log(`\nAI 응답 (${elapsed}ms):`);
    console.log(SEP2);
    console.log(displayResponse);
    console.log(SEP2);

    // 평가
    const checkResults = runChecks(scenario, response);
    const passCount    = Object.values(checkResults).filter(Boolean).length;
    const checkCount   = Object.keys(checkResults).length;
    totalPass   += passCount;
    totalChecks += checkCount;

    console.log('\n評価ポイント:');
    for (const [label, ok] of Object.entries(checkResults)) {
      console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    }

    // 태그 감지 표시
    const tags = [];
    if (response.includes('[RESERVATION]'))   tags.push('[RESERVATION]');
    if (response.includes('[CANCEL_SEARCH]')) tags.push('[CANCEL_SEARCH]');
    if (response.includes('[AVAIL_CHECK]'))   tags.push('[AVAIL_CHECK]');
    if (tags.length > 0) console.log(`  🏷️  検出タグ: ${tags.join(' ')}`);

    summaryRows.push({ id: scenario.id, category: scenario.category, msg: scenario.msg,
      pass: passCount, total: checkCount, tags, elapsed, error: errorMsg });

    // MD 기록
    md.push(`## テスト ${scenario.id}/15 — ${scenario.category}`);
    md.push(`\n**メッセージ**: \`${scenario.msg}\`  **応答時間**: ${elapsed}ms\n`);
    md.push(`**AI 応答:**\n\`\`\`\n${displayResponse}\n\`\`\`\n`);
    md.push(`**評価ポイント:**`);
    for (const [label, ok] of Object.entries(checkResults)) {
      md.push(`- ${ok ? '✅' : '❌'} ${label}`);
    }
    if (tags.length > 0) md.push(`\n**検出タグ**: ${tags.join(' ')}`);
    if (errorMsg) md.push(`\n> ⚠️ エラー: ${errorMsg}`);
    md.push('\n---\n');
  }

  // 최종 집계
  const pct = Math.round((totalPass / totalChecks) * 100);
  const passIcon = pct >= 80 ? '🟢' : pct >= 60 ? '🟡' : '🔴';

  console.log(`\n${SEP}`);
  console.log(`📊 テスト完了`);
  console.log(SEP);
  console.log(`評価通過: ${totalPass}/${totalChecks} 項目  (${pct}%)  ${passIcon}`);
  console.log(`\n個別結果:`);
  for (const r of summaryRows) {
    const icon = r.pass === r.total ? '✅' : r.pass >= r.total / 2 ? '⚠️ ' : '❌';
    const tagStr = r.tags.length > 0 ? ` [${r.tags.join(',')}]` : '';
    console.log(`  ${icon} #${String(r.id).padStart(2,'0')} ${r.pass}/${r.total}  ${r.msg.slice(0,24).padEnd(24)}${tagStr}`);
  }
  console.log(SEP);
  console.log('📄 test_results.md に保存しました');

  // MD 집계 섹션
  md.push(`## 総合結果\n`);
  md.push(`| 指標 | 値 |`);
  md.push(`|------|-----|`);
  md.push(`| 評価通過 | ${totalPass}/${totalChecks} 項目 |`);
  md.push(`| 通過率 | ${pct}% ${passIcon} |`);
  md.push(`\n### 個別サマリー\n`);
  md.push(`| # | カテゴリ | メッセージ | 評価 | タグ | ms |`);
  md.push(`|---|---------|-----------|------|------|-----|`);
  for (const r of summaryRows) {
    const icon = r.pass === r.total ? '✅' : r.pass >= r.total / 2 ? '⚠️' : '❌';
    md.push(`| ${r.id} | ${r.category} | ${r.msg} | ${icon} ${r.pass}/${r.total} | ${r.tags.join(' ') || '-'} | ${r.elapsed} |`);
  }

  fs.writeFileSync('test_results.md', md.join('\n'), 'utf8');
}

main().catch(e => {
  console.error('❌ 致命的エラー:', e.message);
  process.exit(1);
});
