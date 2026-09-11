// 会話の中身。LINEにもCloudflareにもブラウザにも依存しない。
// Worker（本番）とブラウザの体験ページが、同じこのファイルを使う。

export const LABEL_MAX = 20;
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const pad = n => String(n).padStart(2, '0');
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

// 店の現地時刻を UTC の欄に入れた Date を返す（Workerは常にUTCで動くため）
export function localNow(store, now = new Date()) {
  return new Date(now.getTime() + store.timezoneOffsetMinutes * 60000);
}
export const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const weekday = dateStr => { const [y, mo, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); };

export function dateLabel(dateStr) {
  const [, mo, d] = dateStr.split('-').map(Number);
  return `${mo}/${d}(${WEEK[weekday(dateStr)]})`;
}
export function isOpenDate(store, dateStr) {
  return !store.closedWeekdays.includes(weekday(dateStr)) && !store.closedDates.includes(dateStr);
}
export function openDates(store, now) {
  const base = localNow(store, now);
  const out = [];
  for (let i = 0; i <= store.daysAhead && out.length < 13; i++) {
    const s = ymd(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i)));
    if (isOpenDate(store, s)) out.push(s);
  }
  return out;
}
export function allTimes(store) {
  const out = [];
  for (let m = toMin(store.hours.open); m <= toMin(store.hours.lastStart); m += store.slotMinutes) out.push(fromMin(m));
  return out;
}
export function slotsFor(store, time, count) {
  return Array.from({ length: count }, (_, i) => fromMin(toMin(time) + i * store.slotMinutes));
}
// taken: その日に埋まっている時刻の Set
export function freeTimes(store, menu, dateStr, taken, now) {
  const ln = localNow(store, now);
  const nowMin = ln.getUTCHours() * 60 + ln.getUTCMinutes();
  return allTimes(store).filter(t => {
    const need = slotsFor(store, t, menu.slots);
    if (toMin(need[need.length - 1]) > toMin(store.hours.lastStart)) return false; // 閉店をまたぐ
    if (dateStr === ymd(ln) && toMin(t) < nowMin + store.leadMinutes) return false; // 直前すぎる
    return need.every(s => !taken.has(s));
  }).slice(0, 13);
}
export const findMenu = (store, id) => store.menus.find(m => m.id === id);

// ── LINEのメッセージの形 ──
const clip = s => (s.length > LABEL_MAX ? s.slice(0, LABEL_MAX) : s);
const text = t => ({ type: 'text', text: t });
const q = obj => new URLSearchParams(obj).toString();
export function quick(t, items) {
  return {
    type: 'text',
    text: t,
    quickReply: {
      items: items.slice(0, 13).map(i => ({
        type: 'action',
        action: { type: 'postback', label: clip(i.label), data: i.data, displayText: i.label },
      })),
    },
  };
}
const startMenu = t => quick(t, [{ label: '予約する', data: 'a=start' }, { label: '予約を確認', data: 'a=list' }]);
const detail = (store, r) => {
  const m = findMenu(store, r.menu) || { label: r.menu, minutes: '', price: '' };
  return `日時：${dateLabel(r.date)} ${r.time}\nメニュー：${m.label}（${m.minutes}分・${m.price}）\nお名前：${r.name} 様`;
};

// ── 会話の入口 ──
// ctx = { store, now, db, ai, newId }
// 返り値 = { messages: 返信（最大5）, notify: 店に知らせる文 }
export async function handleEvent(event, ctx) {
  const out = { messages: [], notify: [] };
  const userId = event.source && event.source.userId;
  if (!userId) return out;
  if (event.type === 'follow') {
    out.messages.push(startMenu(`友だち追加ありがとうございます。${ctx.store.name}です。\n予約は下のボタンから。質問は、このトークにそのまま書いてください。`));
    return out;
  }
  if (event.type === 'postback') {
    const p = Object.fromEntries(new URLSearchParams(event.postback.data));
    await onPostback(p, userId, ctx, out);
    return out;
  }
  if (event.type === 'message' && event.message.type === 'text') {
    await onText(event.message.text.trim(), userId, ctx, out);
    return out;
  }
  if (event.type === 'message') out.messages.push(startMenu('文字のご質問にお答えしています。予約は下のボタンからどうぞ。'));
  return out;
}

function askMenu(store, out, lead = 'メニューを選んでください。') {
  out.messages.push(quick(lead, store.menus.map(m => ({ label: `${m.label} ${m.minutes}分`, data: q({ a: 'menu', m: m.id }) }))));
}

async function showTimes(p, menu, ctx, out, lead) {
  const { store, db, now } = ctx;
  const taken = await db.takenTimes(p.d);
  const times = freeTimes(store, menu, p.d, taken, now);
  if (!times.length) {
    const dates = openDates(store, now).filter(d => d !== p.d);
    out.messages.push(quick(`${dateLabel(p.d)}は、${menu.label}の空きがありません。別の日を選んでください。`,
      dates.map(d => ({ label: dateLabel(d), data: q({ a: 'date', m: menu.id, d }) }))));
    return;
  }
  out.messages.push(quick(lead || `${dateLabel(p.d)}の空いている時間です（${menu.label}・${menu.minutes}分）。`,
    times.map(t => ({ label: t, data: q({ a: 'time', m: menu.id, d: p.d, t }) }))));
}

async function onPostback(p, userId, ctx, out) {
  const { store, db, now } = ctx;
  const today = ymd(localNow(store, now));
  switch (p.a) {
    case 'start':
      await db.setSession(userId, null);
      return askMenu(store, out);
    case 'menu': {
      const menu = findMenu(store, p.m);
      if (!menu) return askMenu(store, out);
      const dates = openDates(store, now);
      out.messages.push(quick(`${menu.label}ですね。ご希望の日を選んでください。`,
        dates.map(d => ({ label: dateLabel(d), data: q({ a: 'date', m: menu.id, d }) }))));
      return;
    }
    case 'date': {
      const menu = findMenu(store, p.m);
      if (!menu || !openDates(store, now).includes(p.d)) return askMenu(store, out, 'その日は選べなくなりました。もう一度メニューから選んでください。');
      return showTimes(p, menu, ctx, out);
    }
    case 'time': {
      const menu = findMenu(store, p.m);
      if (!menu || !openDates(store, now).includes(p.d)) return askMenu(store, out, 'その日は選べなくなりました。もう一度メニューから選んでください。');
      const taken = await db.takenTimes(p.d);
      if (!freeTimes(store, menu, p.d, taken, now).includes(p.t)) {
        return showTimes(p, menu, ctx, out, `${p.t}は、ちょうど埋まりました。空いている時間から選び直してください。`);
      }
      await db.setSession(userId, { step: 'name', m: menu.id, d: p.d, t: p.t });
      out.messages.push(text(`${dateLabel(p.d)} ${p.t}から、${menu.label}ですね。\nお名前を送ってください（名字だけでも大丈夫です）。\nやめる場合は「やめる」と送ってください。`));
      return;
    }
    case 'confirm': {
      const s = await db.getSession(userId);
      const menu = s && findMenu(store, s.m);
      if (!s || s.step !== 'confirm' || !menu) return askMenu(store, out, '入力の途中の情報が見つかりませんでした。お手数ですが、メニューから選び直してください。');
      const id = ctx.newId();
      const r = { id, userId, name: s.name, menu: menu.id, date: s.d, time: s.t, slots: slotsFor(store, s.t, menu.slots) };
      const result = await db.reserve(r);
      await db.setSession(userId, null);
      if (result.ok) {
        out.messages.push(startMenu(`予約を受け付けました。\n\n予約番号：${id}\n${detail(store, r)}\n\n取り消しは、前日までに「予約を確認」からできます。`));
        out.notify.push(`【新しい予約】\n${detail(store, r)}\n予約番号：${id}`);
      } else {
        out.messages.push(quick('申し訳ありません。ひと足先に、その時間の予約が入りました。別の時間を選んでください。',
          [{ label: '時間を選び直す', data: q({ a: 'date', m: menu.id, d: s.d }) }, { label: '日を選び直す', data: q({ a: 'menu', m: menu.id }) }]));
      }
      return;
    }
    case 'abort':
      await db.setSession(userId, null);
      out.messages.push(startMenu('予約の入力をやめました。'));
      return;
    case 'list': {
      const rs = await db.myReservations(userId, today);
      if (!rs.length) return void out.messages.push(startMenu('いま入っている予約はありません。'));
      const lines = rs.map(r => `・${dateLabel(r.date)} ${r.time} ${(findMenu(store, r.menu) || {}).label || r.menu}（${r.id}）`).join('\n');
      out.messages.push(quick(`いま入っている予約です。\n${lines}\n\n取り消す場合は、下のボタンを押してください。`,
        rs.map(r => ({ label: `取消 ${dateLabel(r.date)} ${r.time}`, data: q({ a: 'cancel', id: r.id }) }))));
      return;
    }
    case 'cancel': {
      const r = await db.getReservation(p.id, userId);
      if (!r || r.status !== 'active') return void out.messages.push(startMenu('その予約は見つかりませんでした。すでに取り消されている可能性があります。'));
      if (r.date <= today) {
        out.messages.push(startMenu('当日の取り消しは、お店が確認します。お店に知らせましたので、このままお待ちください。'));
        out.notify.push(`【当日の取り消し希望】\n${detail(store, r)}\n予約番号：${r.id}\nお客さまに連絡してください。`);
        return;
      }
      out.messages.push(quick(`この予約を取り消しますか？\n\n${detail(store, r)}`,
        [{ label: '取り消す', data: q({ a: 'cancel_ok', id: r.id }) }, { label: '取り消さない', data: 'a=list' }]));
      return;
    }
    case 'cancel_ok': {
      const r = await db.getReservation(p.id, userId);
      if (!r || r.status !== 'active' || r.date <= today) return void out.messages.push(startMenu('この予約は、ここからは取り消せません。お手数ですが、このトークでお知らせください。'));
      const ok = await db.cancel(r.id, userId);
      if (ok) {
        out.messages.push(startMenu(`予約を取り消しました。\n\n${detail(store, r)}\n\nまたのご予約をお待ちしています。`));
        out.notify.push(`【予約の取り消し】\n${detail(store, r)}\n予約番号：${r.id}`);
      } else {
        out.messages.push(startMenu('取り消しができませんでした。すでに取り消されている可能性があります。'));
      }
      return;
    }
    default:
      out.messages.push(startMenu('ボタンの情報が古くなっていました。もう一度選んでください。'));
  }
}

async function onText(t, userId, ctx, out) {
  const { store, db } = ctx;
  const s = await db.getSession(userId);
  if (s && (s.step === 'name' || s.step === 'confirm')) {
    if (/^(やめる|やめます|中止)$/.test(t)) {
      await db.setSession(userId, null);
      return void out.messages.push(startMenu('予約の入力をやめました。'));
    }
    const name = t.replace(/\s+/g, ' ');
    if (!name || name.length > 20) return void out.messages.push(text('お名前は20文字以内で送ってください。やめる場合は「やめる」と送ってください。'));
    const menu = findMenu(store, s.m);
    await db.setSession(userId, { ...s, step: 'confirm', name });
    out.messages.push(quick(`この内容で予約しますか？\n\n${detail(store, { menu: menu.id, date: s.d, time: s.t, name })}`,
      [{ label: 'この内容で予約する', data: 'a=confirm' }, { label: 'やめる', data: 'a=abort' }]));
    return;
  }
  if (/^予約(する|したい|をしたい|お願いします)?$/.test(t)) return askMenu(store, out);
  if (/^予約を?確認/.test(t)) return onPostback({ a: 'list' }, userId, ctx, out);

  const r = await ctx.ai(t);
  await db.logAi({ userId, question: t, answer: r.answer, handoff: r.handoff, error: r.error, tokensIn: r.tokensIn, tokensOut: r.tokensOut, ms: r.ms });
  if (r.handoff) {
    out.messages.push(text(store.handoffMessage));
    out.notify.push(`【お店に回した質問】\n${t}`);
  } else {
    out.messages.push(startMenu(r.answer));
  }
}

// ── 前日のお知らせ ──
export function reminderText(store, r) {
  return quick(`明日のご予約のお知らせです。${store.name}\n\n${detail(store, r)}\n\n取り消す場合は、今日中に「予約を確認」からお願いします。`,
    [{ label: '予約を確認', data: 'a=list' }]);
}

// ── 月次レポート（店に毎月渡す文面） ──
export function buildReport(store, month, { reservations, aiLog, pushLog, priceIn, priceOut }) {
  const count = (arr, key) => arr.reduce((acc, x) => ((acc[key(x)] = (acc[key(x)] || 0) + 1), acc), {});
  const active = reservations.filter(r => r.status === 'active');
  const canceled = reservations.filter(r => r.status === 'canceled');
  const byMenu = count(active, r => (findMenu(store, r.menu) || {}).label || r.menu);
  const byWeek = count(active, r => WEEK[weekday(r.date)]);
  const byTime = count(active, r => r.time);
  const failed = aiLog.filter(a => a.error);
  const handoffs = aiLog.filter(a => a.handoff && !a.error);
  const tin = aiLog.reduce((n, a) => n + (a.tokens_in || 0), 0);
  const tout = aiLog.reduce((n, a) => n + (a.tokens_out || 0), 0);
  const usd = (tin * priceIn + tout * priceOut) / 1e6;
  const pushOk = pushLog.filter(p => p.ok);
  const pushBy = count(pushOk, p => p.kind);
  const fmt = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}件`).join(' / ') || 'なし';
  const [y, m] = month.split('-');
  return [
    `${store.name}　${Number(y)}年${Number(m)}月のLINE予約レポート`,
    '',
    '■ 予約',
    `LINEから入った予約（来店日がこの月）：${active.length + canceled.length}件`,
    `　うち有効 ${active.length}件 / 取り消し ${canceled.length}件`,
    `メニュー別：${fmt(byMenu)}`,
    `曜日別：${fmt(byWeek)}`,
    `時間帯別：${fmt(byTime)}`,
    '',
    '■ 質問への自動回答',
    `AIが答えた質問：${aiLog.length - handoffs.length - failed.length}件`,
    `お店に回した質問：${handoffs.length}件`,
    ...(failed.length ? [`AIにつながらず、お店に回した質問：${failed.length}件（AIの残高・鍵・モデル名を確認してください）`] : []),
    ...(handoffs.length ? ['お店に回した質問（よくある質問に足す候補）：', ...handoffs.slice(0, 20).map(a => `・${a.question}`)] : []),
    '',
    '■ 送信の数（LINEの無料通数に数えられる分）',
    `合計 ${pushOk.length}通（${fmt(pushBy)}）`,
    '※お客さまへの返信（応答メッセージ）は通数に数えられません。',
    '',
    '■ AIの利用量',
    `入力 ${tin}トークン / 出力 ${tout}トークン（この単価で計算すると 約${usd.toFixed(4)}ドル）`,
  ].join('\n');
}
