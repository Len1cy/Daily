/* 日常 · 个人版（网页）—— 行情 + 生日（含农历） */
'use strict';

/* ================= 常量 ================= */
const API = {
  quote: 'https://push2.eastmoney.com/api/qt/stock/get?secid=122.XAU&fields=f43,f44,f45,f46,f57,f58,f59,f60,f86,f170',
  kline: (klt, lmt) => `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=122.XAU&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=${klt}&fqt=1&lmt=${lmt}&end=20500101`,
  txQuote: 'https://qt.gtimg.cn/q=hf_XAU',
  txFx: 'https://qt.gtimg.cn/q=whUSDCNY',
};
const OZ = 31.1034768;
const DAY_MIN = 1380;
const LS = { set: 'daily.set.v1', gold: 'daily.gold.v1', births: 'daily.births.v1' };
const RELS = ['家人', '朋友', '同事', '其他'];
const LEADS = [0, 1, 3, 7, 14, 30];
const leadText = d => d === 0 ? '当天' : d + ' 天';
const VERSION = '1.0';

/* ================= 状态 ================= */
const S = {
  settings: { interval: 30, period: 'minute', defaultLead: 3 },
  quote: null,
  fx: 0,
  minute: [],
  h4: [],
  day: [],
  sessionStart: 0,
  births: [],
  tab: 'gold',
  cross: null,          // {mode, t|i}
  zoom: { h4: { count: 120, start: null }, day: { count: 120, start: null } },
  locked: false,
  lastFetch: 0,
  failed: false,
  editing: null,
};

/* ================= 工具 ================= */
const $ = s => document.querySelector(s);
const pad2 = n => String(n).padStart(2, '0');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function dayKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function hhmm(ts) { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function hhmmss(ts) { const d = new Date(ts); return hhmm(ts) + ':' + pad2(d.getSeconds()); }

/* ================= 农历 ================= */
const lunarFmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { year: 'numeric', month: 'long', day: 'numeric' });
const MONTH_MAP = {
  '正月': 1, '一月': 1, '二月': 2, '三月': 3, '四月': 4, '五月': 5, '六月': 6,
  '七月': 7, '八月': 8, '九月': 9, '十月': 10, '十一月': 11, '冬月': 11, '十二月': 12, '腊月': 12
};
const _lunarCache = new Map();

function lunarOf(date) {
  const key = dayKey(date);
  const hit = _lunarCache.get(key);
  if (hit) return hit;
  let year = 0, month = 0, day = 1, leap = false;
  try {
    for (const p of lunarFmt.formatToParts(date)) {
      if (p.type === 'relatedYear') year = +p.value;
      else if (p.type === 'month') {
        let s = p.value;
        if (s.startsWith('闰')) { leap = true; s = s.slice(1); }
        month = MONTH_MAP[s] || 0;
      } else if (p.type === 'day') day = +p.value;
    }
  } catch (e) { }
  const v = { year, month, day, leap };
  _lunarCache.set(key, v);
  return v;
}

/** 下一次农历生日（今天或之后） */
function lunarNext(month, dayNum, preferLeap, from) {
  const start = startOfToday();
  let fallback = null;
  for (let i = 0; i < 400; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const L = lunarOf(d);
    if (L.month !== month || L.day !== dayNum) continue;
    if (L.leap) {
      if (preferLeap) return d;
      continue;
    }
    if (!preferLeap) return d;
    if (!fallback) fallback = d;
  }
  return fallback;
}

function lunarMonthName(m) {
  const n = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
  if (m < 1 || m > 12) return m + '月';
  return m === 12 ? '腊月' : n[m - 1] + '月';
}
function lunarDayName(d) {
  const pre = ['初', '十', '廿', '三'];
  const unit = ['十', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (d === 10) return '初十';
  if (d === 20) return '二十';
  if (d === 30) return '三十';
  if (d < 1 || d > 30) return d + '日';
  return pre[Math.floor(d / 10)] + unit[d % 10];
}
function lunarLabel(m, d, leap) {
  return (leap ? '闰' : '') + lunarMonthName(m) + lunarDayName(d);
}

/* ================= 生日 ================= */
function loadBirths() {
  try {
    const raw = localStorage.getItem(LS.births);
    S.births = raw ? JSON.parse(raw) : [];
  } catch (e) { S.births = []; }
}
function saveBirths() {
  try { localStorage.setItem(LS.births, JSON.stringify(S.births)); } catch (e) { }
}

function nextBirthday(b) {
  const today = startOfToday();
  let d;
  if (b.lunar) {
    d = lunarNext(b.m, b.d, b.leap, today);
    if (!d) d = new Date(today.getFullYear(), b.m - 1, b.d);
  } else {
    d = new Date(today.getFullYear(), b.m - 1, b.d);
    if (b.m === 2 && b.d === 29 && !isLeapYear(today.getFullYear())) d = new Date(today.getFullYear(), 1, 28);
    if (d < today) {
      const y = today.getFullYear() + 1;
      d = new Date(y, b.m - 1, b.d);
      if (b.m === 2 && b.d === 29 && !isLeapYear(y)) d = new Date(y, 1, 28);
    }
  }
  const days = Math.round((d - today) / 86400000);
  return { date: d, days };
}

function ageOf(b, date, days) {
  if (!b.y) return '';
  const age = date.getFullYear() - b.y;
  if (!(age > 0 && age < 130)) return '';
  return (days === 0 ? '满 ' : '将满 ') + age + ' 岁';
}

function birthDateText(b) {
  if (b.lunar) return lunarLabel(b.m, b.d, b.leap);
  return b.m + ' 月 ' + b.d + ' 日';
}

function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h},42%,64%)`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderBirths() {
  const today = startOfToday();
  const list = S.births.map(b => ({ b, ...nextBirthday(b) })).sort((x, y) => x.days - y.days);

  if (!list.length) {
    $('#birthList').innerHTML = `
      <div class="card empty">
        <div class="ic">🎂</div>
        <div class="t">还没有记录生日</div>
        <div class="s">点右下角 ＋，记下第一个人的生日</div>
      </div>`;
    $('#birthCount').textContent = '0 人';
    return;
  }

  const next = list[0];
  let html = `
    <div class="card summary">
      <div class="cap">下一位</div>
      <div class="row">
        <div>
          <div class="name">${esc(next.b.name)}</div>
          <div class="date">${birthDateText(next.b)}${next.b.lunar ? '（农历）' : ''}</div>
        </div>
        <div>
          <div class="days">${next.days === 0 ? '今天' : next.days}</div>
          <div class="unit">${next.days === 0 ? '生日' : '天后'}</div>
        </div>
      </div>
    </div>`;

  const groups = [
    ['今天', x => x.days === 0],
    ['最近 7 天', x => x.days > 0 && x.days <= 7],
    ['最近 30 天', x => x.days > 7 && x.days <= 30],
    ['以后', x => x.days > 30],
  ];
  for (const [title, test] of groups) {
    const g = list.filter(test);
    if (!g.length) continue;
    html += `<div class="gtitle"><span>${title}</span><i></i><em>${g.length}</em></div>`;
    html += g.map(({ b, days, date }) => itemHTML(b, days, date)).join('');
  }

  $('#birthList').innerHTML = html;
  $('#birthCount').textContent = S.births.length + ' 人';

  document.querySelectorAll('.item').forEach(el => {
    el.addEventListener('click', () => openSheet(el.dataset.id));
  });
}

function itemHTML(b, days, date) {
  const age = ageOf(b, date, days);
  const bits = [];
  if (age) bits.push(age);
  bits.push('提前 ' + leadText(b.lead) + '提醒');
  if (b.note) bits.push(b.note);
  const dcls = days === 0 ? 'today' : (days <= 7 ? 'soon' : '');
  return `
    <div class="item" data-id="${b.id}">
      <div class="avatar" style="background:${avatarColor(b.name)}">${esc(b.name.slice(0, 1))}</div>
      <div class="mid">
        <div class="name">${esc(b.name)}
          ${b.lunar ? '<span class="tag lunar">农历</span>' : ''}
          ${b.rel ? `<span class="tag">${esc(b.rel)}</span>` : ''}
        </div>
        <div class="meta">${esc(bits.join(' · '))}</div>
      </div>
      <div class="right">
        <div class="d ${dcls}">${days === 0 ? '今天' : days + ' 天'}</div>
        <div class="dt">${birthDateText(b)}</div>
      </div>
    </div>`;
}

/* ---------- 编辑 ---------- */
function buildChips() {
  $('#fRel').innerHTML = RELS.map(r => `<button type="button" class="chip" data-v="${r}">${r}</button>`).join('');
  $('#fLead').innerHTML = LEADS.map(d => `<button type="button" class="chip" data-v="${d}">${leadText(d)}</button>`).join('');
  $('#setLead').innerHTML = LEADS.map(d => `<button type="button" class="chip" data-v="${d}">${leadText(d)}</button>`).join('');
  $('#setInterval').innerHTML = [15, 30, 60].map(s => `<button type="button" class="chip" data-v="${s}">${s}s</button>`).join('');
}

function syncChips(sel, val) {
  document.querySelectorAll(sel + ' .chip').forEach(c => {
    c.classList.toggle('on', String(c.dataset.v) === String(val));
  });
}

let draft = null;

function openSheet(id) {
  const b = id ? S.births.find(x => x.id === id) : null;
  S.editing = id || null;
  draft = b ? { ...b } : {
    id: '', name: '', y: '', m: '', d: '', lunar: false, leap: false,
    rel: '朋友', lead: S.settings.defaultLead, note: ''
  };

  $('#sheetTitle').textContent = b ? '编辑生日' : '添加生日';
  $('#fName').value = draft.name || '';
  $('#fYear').value = draft.y || '';
  $('#fMonth').value = draft.m || '';
  $('#fDay').value = draft.d || '';
  $('#fLunar').checked = !!draft.lunar;
  $('#fNote').value = draft.note || '';
  syncChips('#fRel', draft.rel);
  syncChips('#fLead', draft.lead);
  $('#fDelete').hidden = !b;
  $('#sheet').hidden = false;
}

function closeSheet() {
  $('#sheet').hidden = true;
  S.editing = null;
  draft = null;
}

function saveSheet() {
  const name = $('#fName').value.trim();
  const m = +$('#fMonth').value;
  const d = +$('#fDay').value;
  const yRaw = $('#fYear').value.trim();
  const lunar = $('#fLunar').checked;

  if (!name) { $('#fName').focus(); alert('先填个名字吧'); return; }
  if (!(m >= 1 && m <= 12)) { alert('月份填 1–12'); return; }
  const maxDay = lunar ? 30 : 31;
  if (!(d >= 1 && d <= maxDay)) { alert('日期填 1–' + maxDay); return; }
  let y = 0;
  if (yRaw) {
    y = +yRaw;
    if (!(y >= 1900 && y <= 2100)) { alert('出生年填 1900–2100，或者留空'); return; }
  }

  const obj = {
    id: S.editing || ('b' + Date.now().toString(36)),
    name, y, m, d, lunar, leap: false,
    rel: document.querySelector('#fRel .chip.on')?.dataset.v || '朋友',
    lead: +(document.querySelector('#fLead .chip.on')?.dataset.v ?? S.settings.defaultLead),
    note: $('#fNote').value.trim()
  };

  if (S.editing) {
    const i = S.births.findIndex(x => x.id === S.editing);
    S.births[i] = obj;
  } else {
    S.births.push(obj);
  }
  saveBirths();
  closeSheet();
  renderBirths();
}

function deleteBirth() {
  if (!S.editing) return;
  const b = S.births.find(x => x.id === S.editing);
  if (!b) return;
  if (!confirm('删除「' + b.name + '」的生日记录？')) return;
  S.births = S.births.filter(x => x.id !== S.editing);
  saveBirths();
  closeSheet();
  renderBirths();
}

/* ================= 行情数据 ================= */
async function getJSON(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function getText(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchQuote() {
  try {
    const j = await getJSON(API.quote);
    const d = j && j.data;
    if (!d || d.f43 == null) throw new Error('empty');
    const k = Math.pow(10, d.f59 == null ? 2 : d.f59);
    return {
      price: d.f43 / k, prev: d.f60 / k, high: d.f44 / k,
      low: d.f45 / k, open: d.f46 / k,
      ts: d.f86 ? d.f86 * 1000 : Date.now(), source: 'eastmoney'
    };
  } catch (e) {
    const txt = await getText(API.txQuote);
    const m = /="([^"]*)"/.exec(txt);
    if (!m) throw e;
    const a = m[1].split(',');
    if (!a[0]) throw e;
    return { price: +a[0], prev: +a[7], high: +a[4], low: +a[5], open: +a[8], ts: Date.now(), source: 'tencent' };
  }
}

async function fetchFx() {
  const txt = await getText(API.txFx);
  const m = /="([^"]*)"/.exec(txt);
  if (!m) throw new Error('fx');
  const rate = +m[1].split('~')[3];
  if (!(rate > 0)) throw new Error('fx');
  return rate;
}

function sessionStartOf(date) {
  const s = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 7, 0, 0, 0);
  if (date < s) s.setDate(s.getDate() - 1);
  return s;
}

async function fetchMinute() {
  const j = await getJSON(API.kline(1, 1200));
  const arr = (j.data && j.data.klines) || [];
  const today = sessionStartOf(new Date()).getTime();
  const pts = [];
  for (const s of arr) {
    const p = s.split(',');
    const dt = new Date(p[0].replace(' ', 'T') + ':00');
    const st = sessionStartOf(dt);
    if (st.getTime() !== today) continue;
    const t = Math.round((dt - st) / 60000);
    if (t < 0 || t > DAY_MIN) continue;
    pts.push({ t, p: +p[2] });
  }
  S.sessionStart = today;
  S.minute = pts.sort((a, b) => a.t - b.t);
}

async function fetchCandles(mode) {
  if (mode === 'day') {
    const j = await getJSON(API.kline(101, 300));
    S.day = (j.data.klines || []).map(s => {
      const p = s.split(',');
      return { o: +p[1], c: +p[2], h: +p[3], l: +p[4], label: p[0].slice(5) };
    });
    return;
  }
  const j = await getJSON(API.kline(60, 400));
  const groups = new Map();
  const order = [];
  for (const s of j.data.klines || []) {
    const p = s.split(',');
    const dt = new Date(p[0].replace(' ', 'T') + ':00');
    const st = sessionStartOf(dt);
    const t = Math.round((dt - st) / 60000);
    const key = st.getTime() + '#' + Math.floor(t / 240);
    const g = groups.get(key);
    if (!g) {
      const hh = 7 + Math.floor(t / 240) * 4;
      groups.set(key, {
        o: +p[1], c: +p[2], h: +p[3], l: +p[4],
        label: pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()) + ' ' + pad2(hh % 24) + ':00'
      });
      order.push(key);
    } else {
      g.h = Math.max(g.h, +p[3]);
      g.l = Math.min(g.l, +p[4]);
      g.c = +p[2];
    }
  }
  S.h4 = order.map(k => groups.get(k));
}

/* ================= 行情渲染 ================= */
function changeInfo() {
  const q = S.quote;
  if (!q || !(q.prev > 0)) return null;
  const diff = q.price - q.prev;
  return { diff, pct: diff / q.prev * 100 };
}

function renderGold() {
  const q = S.quote;
  const ci = changeInfo();
  if (!q) {
    $('#price').textContent = '—';
    return;
  }
  $('#price').textContent = num(q.price);
  $('#price').className = 'price' + (ci && ci.diff < 0 ? ' down' : '');

  if (ci) {
    const up = ci.diff >= 0;
    const el = $('#chg');
    el.className = 'chg' + (ci.diff === 0 ? ' flat' : up ? '' : ' down');
    el.textContent = (up ? '▲ +' : '▼ −') + num(Math.abs(ci.diff)) + '    ' +
      (up ? '+' : '−') + Math.abs(ci.pct).toFixed(2) + '%';
  }

  $('#dayHigh').textContent = num(q.high);
  $('#dayLow').textContent = num(q.low);
  $('#dayOpen').textContent = num(q.open);

  const gram = S.fx > 0 ? q.price / OZ * S.fx : 0;
  $('#cny').innerHTML = gram > 0
    ? `≈ <b>${gram.toFixed(1)}</b> 元/克　·　汇率 ${S.fx.toFixed(4)}`
    : '≈ — 元/克';

  renderGoldStatus();
}

function renderGoldStatus() {
  const q = S.quote;
  const el = $('#goldStatus');
  if (!q) {
    el.className = 'status error';
    el.innerHTML = '<i></i><span>连接失败</span>';
    return;
  }
  const fresh = S.lastFetch && (Date.now() - S.lastFetch) < 90000;
  const feedAge = Date.now() - q.ts;

  if (!fresh) {
    el.className = 'status stale';
    el.innerHTML = '<i></i><span>已过期 ' + hhmm(q.ts) + '</span>';
    $('#goldBanner').hidden = false;
    $('#goldBanner').textContent = '⚠ 数据已过期，显示的是 ' + hhmmss(q.ts) + ' 的价格，正在重试…';
  } else if (feedAge > 4 * 60000) {
    el.className = 'status closed';
    el.innerHTML = '<i></i><span>休市 ' + hhmm(q.ts) + '</span>';
    $('#goldBanner').hidden = true;
  } else {
    el.className = 'status';
    el.innerHTML = '<i></i><span>' + hhmmss(q.ts) + ' 更新</span>';
    $('#goldBanner').hidden = true;
  }
}

/* ================= 图表 ================= */
const chartEl = $('#chart');
const crossEl = $('#cross');
const bubbleEl = $('#bubble');

function chartSize() {
  const box = $('#chartBox');
  return { w: box.clientWidth, h: box.clientHeight };
}

function currentList() {
  return S.settings.period === 'h4' ? S.h4 : S.day;
}

/** 当前可见窗口：{start, count}；start 为 null 表示贴着最右边 */
function visibleWindow(mode, list) {
  const z = S.zoom[mode] || { count: 120, start: null };
  const total = list.length;
  const minCount = Math.min(6, total);
  const count = clamp(Math.round(z.count || 120), minCount, total);
  const maxStart = Math.max(0, total - count);
  const start = (z.start == null) ? maxStart : clamp(Math.round(z.start), 0, maxStart);
  return { start, count };
}

function renderChart() {
  const { w, h } = chartSize();
  if (w < 20 || h < 20) return;
  chartEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  crossEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  crossEl.innerHTML = '';

  if (S.settings.period === 'minute') drawMinute(w, h);
  else drawCandles(w, h, S.settings.period === 'h4' ? S.h4 : S.day, S.settings.period);

  if (S.locked) drawCross();
}

function minutePoints() {
  const pts = S.minute.slice();
  const q = S.quote;
  if (!q || !(q.price > 0)) return pts;
  if (!S.sessionStart) return pts;
  if (Date.now() - q.ts > 4 * 60000) return pts;
  const now = new Date();
  const t = Math.round((now - new Date(S.sessionStart)) / 60000);
  if (t < 0 || t > DAY_MIN) return pts;
  const i = pts.findIndex(p => p.t === t);
  if (i >= 0) pts[i] = { t, p: q.price };
  else pts.push({ t, p: q.price });
  return pts;
}

function drawMinute(w, h) {
  const padL = 60, padR = 12, padT = 14, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const pts = minutePoints();
  const prev = S.quote ? S.quote.prev : (pts[0] ? pts[0].p : 0);

  if (pts.length < 2 || !(prev > 0)) {
    chartEl.innerHTML = `<text x="${w / 2}" y="${h / 2}" font-size="11" fill="#a4a9b2" text-anchor="middle">正在获取今日分时…</text>`;
    return;
  }

  let hi = prev, lo = prev;
  for (const p of pts) { if (p.p > hi) hi = p.p; if (p.p < lo) lo = p.p; }
  const dev = Math.max(hi - prev, prev - lo) * 1.15 || 1;
  const top = prev + dev, bot = prev - dev;
  const y = v => padT + (top - v) / (top - bot) * plotH;
  const x = t => padL + t / DAY_MIN * plotW;

  const last = pts[pts.length - 1];
  const rising = last.p >= prev;
  const main = rising ? '#e02b2b' : '#0b9d5a';

  let svg = `<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${main}" stop-opacity="0.20"/>
    <stop offset="1" stop-color="${main}" stop-opacity="0"/>
  </linearGradient></defs>`;

  const priceTicks = [
    { v: top, label: Math.round(top).toLocaleString(), strong: false },
    { v: prev, label: prev.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), strong: true },
    { v: bot, label: Math.round(bot).toLocaleString(), strong: false },
  ];
  for (const t of priceTicks) {
    const yy = y(t.v);
    svg += `<line x1="${padL}" x2="${w - padR}" y1="${yy}" y2="${yy}" stroke="${t.strong ? '#d6d9de' : '#f2f3f6'}" stroke-dasharray="${t.strong ? '4 3' : '2 4'}"/>`;
    svg += `<text x="${padL - 6}" y="${yy + 3.5}" font-size="9.5" fill="#a4a9b2" text-anchor="end">${t.label}</text>`;
  }

  const ticks = [[0, '07:00'], [300, '12:00'], [600, '17:00'], [900, '22:00'], [1200, ''], [1380, '06:00']];
  for (const [m, lab] of ticks) {
    svg += `<line x1="${x(m)}" x2="${x(m)}" y1="${padT}" y2="${h - padB}" stroke="#f2f3f6" stroke-dasharray="2 4"/>`;
    if (lab) {
      const anchor = m === 0 ? 'start' : m === DAY_MIN ? 'end' : 'middle';
      svg += `<text x="${m === DAY_MIN ? x(m) - 1 : x(m)}" y="${h - 6}" font-size="9.5" fill="#a4a9b2" text-anchor="${anchor}">${lab}</text>`;
    }
  }

  const line = pts.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.p).toFixed(1)).join('');
  svg += `<path d="${line}L${x(last.t).toFixed(1)} ${h - padB}L${x(pts[0].t).toFixed(1)} ${h - padB}Z" fill="url(#ga)"/>`;

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const col = ((a.p + b.p) / 2) >= prev ? '#e02b2b' : '#0b9d5a';
    svg += `<line x1="${x(a.t).toFixed(1)}" y1="${y(a.p).toFixed(1)}" x2="${x(b.t).toFixed(1)}" y2="${y(b.p).toFixed(1)}" stroke="${col}" stroke-width="1.9" stroke-linecap="round"/>`;
  }

  svg += `<line x1="${x(last.t)}" x2="${x(last.t)}" y1="${padT}" y2="${h - padB}" stroke="#c8ccd3" stroke-width="1" stroke-dasharray="2 3"/>`;
  svg += `<circle cx="${x(last.t)}" cy="${y(last.p)}" r="3" fill="#fff" stroke="${main}" stroke-width="1.8"/>`;

  chartEl.innerHTML = svg;
}

function drawCandles(w, h, list, mode) {
  const padL = 10, padR = 50, padT = 12, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  if (!list || list.length < 2) {
    chartEl.innerHTML = `<text x="${w / 2}" y="${h / 2}" font-size="11" fill="#a4a9b2" text-anchor="middle">正在获取 K 线…</text>`;
    return;
  }

  const win = visibleWindow(mode, list);
  const view = list.slice(win.start, win.start + win.count);

  let hi = -Infinity, lo = Infinity;
  for (const k of view) { if (k.h > hi) hi = k.h; if (k.l < lo) lo = k.l; }
  const span = (hi - lo) || 1;
  const y = v => padT + (hi - v) / span * plotH;
  const step = plotW / view.length;
  const bw = clamp(step * 0.62, 1.2, 14);

  let svg = '';
  for (let i = 0; i <= 3; i++) {
    const gy = padT + i * plotH / 3;
    svg += `<line x1="${padL}" x2="${w - padR}" y1="${gy}" y2="${gy}" stroke="rgba(120,132,160,.16)" stroke-dasharray="3 4"/>`;
    svg += `<text x="${w - padR + 6}" y="${gy + 3.5}" font-size="9.5" fill="#8e96a5">${Math.round(hi - i * span / 3).toLocaleString()}</text>`;
  }

  view.forEach((k, i) => {
    const cx = padL + step * i + step / 2;
    const up = k.c >= k.o;
    const col = up ? '#e02b2b' : '#0b9d5a';
    svg += `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y(k.h).toFixed(1)}" y2="${y(k.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const yTop = y(Math.max(k.o, k.c)), yBot = y(Math.min(k.o, k.c));
    svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, yBot - yTop).toFixed(1)}" fill="${col}" rx="${Math.min(2, bw / 3).toFixed(1)}"/>`;
  });

  const lastK = view[view.length - 1];
  svg += `<line x1="${padL}" x2="${w - padR}" y1="${y(lastK.c)}" y2="${y(lastK.c)}" stroke="#e02b2b" stroke-width="0.9" stroke-dasharray="2 3" opacity="0.4"/>`;

  svg += `<text x="${padL}" y="${h - 6}" font-size="9.5" fill="#8e96a5">${view[0].label}</text>`;
  svg += `<text x="${w - padR}" y="${h - 6}" font-size="9.5" fill="#8e96a5" text-anchor="end">${lastK.label}</text>`;

  chartEl.innerHTML = svg;
}

/* ---------- 十字线 ---------- */
function drawCross() {
  const { w, h } = chartSize();
  const c = S.cross;
  if (!c || w < 20) return;

  let px = 0, py = 0, html = '';

  if (c.mode === 'minute') {
    const pts = minutePoints();
    const padL = 60, padR = 12, padT = 14, padB = 22;
    if (pts.length < 2) return;
    const prev = S.quote ? S.quote.prev : pts[0].p;
    let hi = prev, lo = prev;
    for (const p of pts) { if (p.p > hi) hi = p.p; if (p.p < lo) lo = p.p; }
    const dev = Math.max(hi - prev, prev - lo) * 1.15 || 1;
    const top = prev + dev, bot = prev - dev;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const pt = pts.reduce((a, b) => Math.abs(b.t - c.t) < Math.abs(a.t - c.t) ? b : a, pts[0]);
    px = padL + pt.t / DAY_MIN * plotW;
    py = padT + (top - pt.p) / (top - bot) * plotH;
    const pct = (pt.p - prev) / prev * 100;

    crossEl.innerHTML =
      `<line x1="${px}" x2="${px}" y1="${padT}" y2="${h - padB}" stroke="#5b616b" stroke-dasharray="3 3"/>` +
      `<line x1="${padL}" x2="${px}" y1="${py}" y2="${py}" stroke="#5b616b" stroke-dasharray="3 3"/>` +
      `<circle cx="${px}" cy="${py}" r="4.5" fill="#fff" stroke="#14171c" stroke-width="1.5"/>`;

    const total = (7 * 60 + pt.t) % 1440;
    html = `<div class="t">${pad2(Math.floor(total / 60))}:${pad2(total % 60)} · 今日</div>
      <div class="p">${num(pt.p)}<span class="u ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span></div>`;
  } else {
    const list = c.mode === 'h4' ? S.h4 : S.day;
    if (!list || list.length < 2) return;
    const padL = 10, padR = 50, padT = 12, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const win = visibleWindow(c.mode, list);
    const view = list.slice(win.start, win.start + win.count);
    if (!view.length) return;
    const local = clamp(Math.round(c.i) - win.start, 0, view.length - 1);
    let hi = -Infinity, lo = Infinity;
    for (const kk of view) { if (kk.h > hi) hi = kk.h; if (kk.l < lo) lo = kk.l; }
    const span = (hi - lo) || 1;
    const step = plotW / view.length;
    const k = view[local];
    px = padL + step * local + step / 2;
    py = padT + (hi - k.c) / span * plotH;
    const pct = (k.c - k.o) / k.o * 100;

    crossEl.innerHTML =
      `<line x1="${px}" x2="${px}" y1="${padT}" y2="${h - padB}" stroke="#5b616b" stroke-dasharray="3 3"/>` +
      `<line x1="${padL}" x2="${px}" y1="${py}" y2="${py}" stroke="#5b616b" stroke-dasharray="3 3"/>` +
      `<circle cx="${px}" cy="${py}" r="4.5" fill="#fff" stroke="#14171c" stroke-width="1.5"/>`;

    html = `<div class="t">${k.label}</div>
      <div class="p">${num(k.c)}<span class="u ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span></div>
      <div class="oh"><span>开 <b>${num(k.o)}</b></span><span>高 <b>${num(k.h)}</b></span></div>
      <div class="oh"><span>低 <b>${num(k.l)}</b></span><span>收 <b>${num(k.c)}</b></span></div>`;
  }

  bubbleEl.innerHTML = html;
  bubbleEl.hidden = false;
  const bw = bubbleEl.offsetWidth, bh = bubbleEl.offsetHeight;
  const left = clamp(px, bw / 2 + 4, w - bw / 2 - 4);
  let top = py - 12;
  let below = false;
  if (top - bh < 4) { top = py + 14; below = true; }
  bubbleEl.style.left = left + 'px';
  bubbleEl.style.top = top + 'px';
  bubbleEl.style.transform = below ? 'translate(-50%,0)' : 'translate(-50%,-100%)';
}

function hideCross() {
  S.cross = null;
  S.locked = false;
  crossEl.innerHTML = '';
  bubbleEl.hidden = true;
  updateHint();
}

function updateHint() {
  const base = S.settings.period === 'minute' ? '按住图表看任意时刻的价格' : '按住看单根 · 双指缩放时间 · 双击复位';
  $('#chartHint').textContent = S.locked ? '已暂停 · 轻点图表回到实时' : base;
}

/* ---------- 手势 ---------- */
let dragging = false, downX = 0, downY = 0, moved = false, wasLocked = false;

function chartPoint(e) {
  const r = $('#chartBox').getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function pickPoint(x) {
  const { w } = chartSize();
  if (S.settings.period === 'minute') {
    const padL = 60, padR = 12;
    const t = clamp((x - padL) / (w - padL - padR) * DAY_MIN, 0, DAY_MIN);
    S.cross = { mode: 'minute', t };
  } else {
    const list = S.settings.period === 'h4' ? S.h4 : S.day;
    if (!list || list.length < 2) return;
    const padL = 10, padR = 50;
    const win = visibleWindow(S.settings.period, list);
    const step = (w - padL - padR) / win.count;
    const local = clamp(Math.floor((x - padL) / step), 0, win.count - 1);
    S.cross = { mode: S.settings.period, i: win.start + local };
  }
  drawCross();
}

const pointers = new Map();
let pinch = null;
let lastTapAt = 0, lastTapX = 0, lastTapY = 0;

function startPinch() {
  const vals = [...pointers.values()];
  if (vals.length < 2) return;
  const a = vals[0], b = vals[1];
  const mode = S.settings.period;
  if (mode === 'minute') { pinch = null; return; }

  const list = currentList();
  if (!list || list.length < 2) { pinch = null; return; }
  const { w } = chartSize();
  const padL = 10, padR = 50;
  const win = visibleWindow(mode, list);
  const barW = (w - padL - padR) / win.count;
  const mid = (a.x + b.x) / 2;

  pinch = {
    mode,
    d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    start0: win.start,
    count0: win.count,
    idxAtMid: win.start + (mid - padL) / barW,
    total: list.length
  };
  S.locked = false;
  dragging = false;   // 双指手势不触发「松手停住」
  moved = true;
  hideCross();
}

function movePinch() {
  if (!pinch) return;
  const vals = [...pointers.values()];
  if (vals.length < 2) return;
  const a = vals[0], b = vals[1];
  const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  const scale = d / pinch.d0;
  const total = pinch.total;
  const count = clamp(Math.round(pinch.count0 / scale), Math.min(8, total), total);

  const { w } = chartSize();
  const padL = 10, padR = 50;
  const barW = (w - padL - padR) / count;
  const mid = (a.x + b.x) / 2;
  let start = Math.round(pinch.idxAtMid - (mid - padL) / barW);
  start = clamp(start, 0, Math.max(0, total - count));

  S.zoom[pinch.mode] = { count, start };
  renderChart();
}

function resetZoom() {
  const mode = S.settings.period;
  if (mode === 'minute') return;
  S.zoom[mode] = { count: 120, start: null };
  renderChart();
  toast('已恢复默认区间');
}

function initGestures() {
  const box = $('#chartBox');

  box.addEventListener('pointerdown', e => {
    try { box.setPointerCapture(e.pointerId); } catch (err) { }
    const p = chartPoint(e);
    pointers.set(e.pointerId, p);

    if (pointers.size === 2) { startPinch(); e.preventDefault(); return; }
    if (pointers.size > 2) return;

    downX = p.x; downY = p.y; moved = false;
    wasLocked = S.locked;
    dragging = true;
    pickPoint(p.x);
    e.preventDefault();
  });

  box.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const p = chartPoint(e);
    pointers.set(e.pointerId, p);

    if (pointers.size >= 2) {
      if (pinch) movePinch();
      e.preventDefault();
      return;
    }
    if (!dragging) return;
    if (Math.abs(p.x - downX) > 6 || Math.abs(p.y - downY) > 6) moved = true;
    pickPoint(p.x);
    e.preventDefault();
  });

  function end(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size > 0) return;
    if (!dragging) return;
    dragging = false;

    // 双击：恢复默认时间区间
    const now = Date.now();
    if (!moved && now - lastTapAt < 320 && Math.abs(downX - lastTapX) < 24 && Math.abs(downY - lastTapY) < 24) {
      lastTapAt = 0;
      resetZoom();
      hideCross();
      if (e && e.preventDefault) e.preventDefault();
      return;
    }
    lastTapAt = now; lastTapX = downX; lastTapY = downY;

    if (!moved && wasLocked) {
      hideCross();
    } else {
      S.locked = true;
      updateHint();
    }
    if (e && e.preventDefault) e.preventDefault();
  }

  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

/* ================= 启动与刷新 ================= */
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS.set);
    if (raw) Object.assign(S.settings, JSON.parse(raw));
  } catch (e) { }
}
function saveSettings() {
  try { localStorage.setItem(LS.set, JSON.stringify(S.settings)); } catch (e) { }
}

async function refreshGold(force) {
  try {
    const q = await fetchQuote();
    S.quote = q;
    S.lastFetch = Date.now();
    S.failed = false;
  } catch (e) {
    S.failed = true;
  }
  try { S.fx = await fetchFx(); } catch (e) { }
  try {
    if (!S.minute.length || (S.quote && Date.now() - S.quote.ts < 4 * 60000)) await fetchMinute();
  } catch (e) { }

  renderGold();
  if (S.settings.period === 'minute') renderChart();
  if (force) toast('已刷新');
}

async function loadPeriod(mode) {
  S.settings.period = mode;
  saveSettings();
  document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b.dataset.p === mode));
  updateHint();
  hideCross();

  if (mode === 'minute') {
    try { if (!S.minute.length) await fetchMinute(); } catch (e) { }
    renderChart();
  } else {
    const target = mode === 'h4' ? S.h4 : S.day;
    if (!target.length) {
      chartEl.innerHTML = `<text x="50%" y="50%" font-size="11" fill="#a4a9b2" text-anchor="middle">正在获取…</text>`;
      try { await fetchCandles(mode); } catch (e) { }
    }
    renderChart();
  }
}

/* ================= 设置 ================= */
function renderSettings() {
  syncChips('#setLead', S.settings.defaultLead);
  syncChips('#setInterval', S.settings.interval);
  $('#birthCount').textContent = S.births.length + ' 人';
  $('#verText').textContent = VERSION;
  const btn = $('#btnNotify');
  if (!('Notification' in window)) {
    btn.textContent = '不支持';
  } else if (Notification.permission === 'granted') {
    btn.textContent = '已开启';
  } else if (Notification.permission === 'denied') {
    btn.textContent = '被拒绝';
  } else {
    btn.textContent = '开启';
  }
}

async function enableNotify() {
  if (!('Notification' in window)) { alert('这个浏览器不支持通知，可以用日历导出'); return; }
  let p = Notification.permission;
  if (p === 'default') { try { p = await Notification.requestPermission(); } catch (e) { p = 'denied'; } }
  if (p === 'granted') {
    $('#notifyCap').textContent = '已开启。App 打开或切回前台时会弹一次；锁屏提醒用下面的日历导出';
    try { new Notification('通知已开启', { body: '有生日临近时提醒你' }); } catch (e) { }
  } else {
    $('#notifyCap').textContent = '被系统拒绝了，可以在手机设置里打开，或者直接用日历导出';
  }
  renderSettings();
}

/* ---------- 日历导出 ---------- */
function icsEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function exportICS() {
  if (!S.births.length) { alert('还没有记录，先加一个人'); return; }
  const now = new Date();
  const stamp = now.getUTCFullYear() + pad2(now.getUTCMonth() + 1) + pad2(now.getUTCDate()) +
    'T' + pad2(now.getUTCHours()) + pad2(now.getUTCMinutes()) + pad2(now.getUTCSeconds()) + 'Z';

  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Daily App//CN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:生日提醒'];

  for (const b of S.births) {
    let y = b.y || now.getFullYear();
    let m = b.m, d = b.d;
    if (b.lunar) {
      const nb = nextBirthday(b);
      y = nb.date.getFullYear();
      m = nb.date.getMonth() + 1;
      d = nb.date.getDate();
    }
    L.push('BEGIN:VEVENT');
    L.push('UID:bd-' + b.id + '@daily.local');
    L.push('DTSTAMP:' + stamp);
    L.push('DTSTART;VALUE=DATE:' + y + pad2(m) + pad2(d));
    L.push('SUMMARY:' + icsEscape(b.name) + ' 生日');
    L.push('RRULE:FREQ=YEARLY');
    if (b.note) L.push('DESCRIPTION:' + icsEscape(b.note));
    L.push('BEGIN:VALARM');
    L.push('TRIGGER:-PT' + (b.lead * 24) + 'H');
    L.push('ACTION:DISPLAY');
    L.push('DESCRIPTION:' + icsEscape(b.name) + ' 生日（提前 ' + b.lead + ' 天）');
    L.push('END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');

  const blob = new Blob([L.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '生日提醒.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- 通知 ---------- */
function checkNotify() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const today = dayKey(new Date());
  for (const b of S.births) {
    const { days } = nextBirthday(b);
    if (!(days === 0 || days === b.lead)) continue;
    const key = 'noti_' + b.id;
    if (localStorage.getItem(key) === today) continue;
    try {
      new Notification(days === 0 ? b.name + ' 今天生日' : b.name + ' 的生日还有 ' + days + ' 天', {
        body: birthDateText(b), tag: 'bd-' + b.id, icon: 'icons/icon-192.png'
      });
      localStorage.setItem(key, today);
    } catch (e) { }
  }
}

/* ================= 导航 ================= */
function setTab(name) {
  S.tab = name;
  $('#viewGold').hidden = name !== 'gold';
  $('#viewBirth').hidden = name !== 'birth';
  $('#viewSettings').hidden = name !== 'settings';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));

  const meta = {
    gold: ['行情', '伦敦金现货 · 实时'],
    birth: ['生日', '记下重要的人'],
    settings: ['设置', '偏好与数据'],
  }[name];
  $('#pageTitle').textContent = meta[0];
  $('#pageSub').textContent = meta[1];
  $('#btnRefresh').hidden = name !== 'gold';
  $('#fab').hidden = name !== 'birth';

  if (name === 'gold') setTimeout(renderChart, 30);
  if (name === 'birth') renderBirths();
  if (name === 'settings') renderSettings();
}

function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:rgba(20,22,27,.9);color:#fff;padding:9px 15px;border-radius:12px;font-size:12.5px;z-index:99';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1600);
}

/* ================= 启动 ================= */
function boot() {
  loadSettings();
  loadBirths();
  buildChips();

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  document.querySelectorAll('#seg button').forEach(b => b.addEventListener('click', () => loadPeriod(b.dataset.p)));
  document.querySelectorAll('#setLead .chip').forEach(c => c.addEventListener('click', () => {
    S.settings.defaultLead = +c.dataset.v;
    saveSettings();
    syncChips('#setLead', S.settings.defaultLead);
  }));
  document.querySelectorAll('#setInterval .chip').forEach(c => c.addEventListener('click', () => {
    S.settings.interval = +c.dataset.v;
    saveSettings();
    syncChips('#setInterval', S.settings.interval);
    scheduleRefresh();
  }));

  $('#fab').addEventListener('click', () => openSheet(null));
  $('#sheetCancel').addEventListener('click', closeSheet);
  $('#mask').addEventListener('click', closeSheet);
  $('#fSave').addEventListener('click', saveSheet);
  $('#fDelete').addEventListener('click', deleteBirth);
  $('#fRel').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    draft.rel = c.dataset.v; syncChips('#fRel', draft.rel);
  });
  $('#fLead').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    draft.lead = +c.dataset.v; syncChips('#fLead', draft.lead);
  });
  $('#btnNotify').addEventListener('click', enableNotify);
  $('#btnIcs').addEventListener('click', exportICS);
  $('#btnClear').addEventListener('click', () => {
    if (!S.births.length) { alert('本来就没有记录'); return; }
    if (!confirm('清空全部 ' + S.births.length + ' 条生日记录？')) return;
    S.births = [];
    saveBirths();
    renderBirths();
    renderSettings();
  });
  $('#btnRefresh').addEventListener('click', () => refreshGold(true));

  initGestures();
  setTab('gold');
  loadPeriod(S.settings.period);
  refreshGold(false);
  renderBirths();
  renderSettings();
  scheduleRefresh();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refreshGold(false); renderBirths(); checkNotify(); }
  });
  window.addEventListener('resize', () => renderChart());
  window.addEventListener('orientationchange', () => setTimeout(renderChart, 250));

  setTimeout(checkNotify, 800);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }
}

let timer = null;
function scheduleRefresh() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!document.hidden) refreshGold(false);
  }, S.settings.interval * 1000);
}

boot();
