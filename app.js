// 体験ページ。会話の中身は、Workerと同じ core.js をそのまま使う。
import { handleEvent, openDates, ymd, localNow, dateLabel, findMenu, freeTimes, slotsFor } from './core.js';

const store = await (await fetch('./store.json')).json();
const recorded = await (await fetch('./ai_answers.json')).json();
const USER = 'Udemo';
const $ = id => document.getElementById(id);
document.title = `予約LINEの体験ページ（${store.name}）`;
$('shop').textContent = store.name;

let mem;
function resetMemory() {
  mem = { sessions: new Map(), res: [], locks: new Map(), notes: [] };
  // 他のお客さまの予約を少し入れておく（空き枠の変化が見えるように）
  const now = new Date();
  const days = openDates(store, now).filter(d => d !== ymd(localNow(store, now))).slice(0, 3);
  const fill = [[0, 'cut', 1], [0, 'color', 4], [1, 'spa', 2], [2, 'cut', 0]];
  let n = 1;
  for (const [di, menuId, ti] of fill) {
    const d = days[di]; if (!d) continue;
    const menu = findMenu(store, menuId);
    const times = freeTimes(store, menu, d, new Set([...mem.locks.keys()].filter(k => k.startsWith(d)).map(k => k.slice(11))), now);
    const t = times[ti]; if (!t) continue;
    const id = `RDEMO${n++}`;
    slotsFor(store, t, menu.slots).forEach(s => mem.locks.set(`${d} ${s}`, id));
    mem.res.push({ id, user_id: 'Uother', name: '他のお客さま', menu: menuId, date: d, time: t, status: 'active' });
  }
}

const db = {
  async getSession(u) { return mem.sessions.get(u) || null; },
  async setSession(u, data) { data ? mem.sessions.set(u, data) : mem.sessions.delete(u); },
  async takenTimes(date) { return new Set([...mem.locks.keys()].filter(k => k.startsWith(`${date} `)).map(k => k.slice(11))); },
  async reserve(r) {
    const keys = r.slots.map(t => `${r.date} ${t}`);
    if (keys.some(k => mem.locks.has(k))) return { ok: false };
    keys.forEach(k => mem.locks.set(k, r.id));
    mem.res.push({ id: r.id, user_id: r.userId, name: r.name, menu: r.menu, date: r.date, time: r.time, status: 'active' });
    return { ok: true };
  },
  async myReservations(u, today) {
    return mem.res.filter(r => r.user_id === u && r.status === 'active' && r.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).slice(0, 5);
  },
  async getReservation(id, u) { return mem.res.find(r => r.id === id && r.user_id === u) || null; },
  async cancel(id, u) {
    const r = mem.res.find(x => x.id === id && x.user_id === u && x.status === 'active');
    if (!r) return false;
    r.status = 'canceled';
    for (const [k, v] of [...mem.locks]) if (v === id) mem.locks.delete(k);
    return true;
  },
  async logAi() {},
};
const ai = async q => {
  const hit = recorded.questions.find(x => x.q === q.trim());
  return hit ? { answer: hit.answer, handoff: hit.handoff, ms: 0 } : { answer: '', handoff: true, ms: 0 };
};
const newId = () => 'R' + Array.from(crypto.getRandomValues(new Uint8Array(4)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

function bubble(side, text) {
  const row = document.createElement('div');
  row.className = `row ${side}`;
  const b = document.createElement('div');
  b.className = 'b';
  b.textContent = text;
  row.appendChild(b);
  $('log').appendChild(row);
  $('log').scrollTop = $('log').scrollHeight;
}
function renderQuick(msg) {
  $('quick').innerHTML = '';
  for (const it of (msg && msg.quickReply && msg.quickReply.items) || []) {
    const btn = document.createElement('button');
    btn.textContent = it.action.label;
    btn.onclick = () => send({ type: 'postback', postback: { data: it.action.data } }, it.action.displayText);
    $('quick').appendChild(btn);
  }
}
function renderStore() {
  const today = ymd(localNow(store));
  const rows = mem.res.filter(r => r.status === 'active' && r.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  $('table').innerHTML = '<tr><th>日時</th><th>メニュー</th><th>お名前</th></tr>' +
    rows.map(r => `<tr><td>${dateLabel(r.date)} ${r.time}</td><td>${findMenu(store, r.menu).label}</td><td></td></tr>`).join('');
  [...$('table').querySelectorAll('tr')].slice(1).forEach((tr, i) => { tr.lastChild.textContent = rows[i].user_id === 'Uother' ? '（ほかの予約）' : `${rows[i].name} 様`; });
  $('notes').innerHTML = mem.notes.length ? '' : '<p>まだありません</p>';
  for (const n of mem.notes.slice().reverse()) {
    const div = document.createElement('div');
    div.textContent = n;
    $('notes').appendChild(div);
  }
}
async function send(partial, shown) {
  if (shown) bubble('me', shown);
  $('quick').innerHTML = '';
  const ev = { ...partial, source: { type: 'user', userId: USER }, replyToken: 'demo', timestamp: Date.now() };
  const out = await handleEvent(ev, { store, now: new Date(), db, ai, newId });
  await new Promise(r => setTimeout(r, 350));
  for (const m of out.messages) bubble('bot', m.text);
  renderQuick(out.messages[out.messages.length - 1]);
  mem.notes.push(...out.notify);
  renderStore();
}

$('form').onsubmit = e => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  send({ type: 'message', message: { type: 'text', text } }, text);
};
for (const item of recorded.questions) {
  const btn = document.createElement('button');
  btn.textContent = item.q;
  btn.onclick = () => send({ type: 'message', message: { type: 'text', text: item.q } }, item.q);
  $('samples').appendChild(btn);
}
function start() {
  resetMemory();
  $('log').innerHTML = '';
  renderStore();
  send({ type: 'follow', follow: { isUnblocked: false } });
}
$('reset').onclick = start;
start();
