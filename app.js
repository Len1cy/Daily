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
  market: 'gold',
  cross: null,          // {mode, t|i}
  zoom: { h4: { count: 120, start: null }, day: { count: 120, start: null } },
  minuteFail: false,
  logs: [],
  wishes: [],
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
  S.minuteFail = false;
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

  if (typeof renderRange === 'function') renderRange();
  if (typeof renderDash === 'function' && S.tab === 'dash') renderDash();

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
    chartEl.innerHTML = `<text x="${w / 2}" y="${h / 2}" font-size="11" fill="#a4a9b2" text-anchor="middle">${S.minuteFail ? '数据源暂时不可用 · 自动重试中' : '正在获取今日分时…'}</text>`;
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


/* ---------- 分时缓存：接口挂了也能看图 ---------- */
const LS_MIN = 'daily.minute.v1';

function saveMinuteCache() {
  try {
    if (!S.minute.length) return;
    localStorage.setItem(LS_MIN, JSON.stringify({
      day: S.sessionStart,
      t: S.minute.map(p => p.t),
      p: S.minute.map(p => p.p)
    }));
  } catch (e) { }
}

function loadMinuteCache() {
  try {
    const raw = localStorage.getItem(LS_MIN);
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (!o || !o.t || !o.t.length) return false;
    if (o.day && S.sessionStart && o.day !== S.sessionStart) return false;
    S.sessionStart = o.day || 0;
    S.minute = o.t.map((t, i) => ({ t, p: o.p[i] }));
    return true;
  } catch (e) { return false; }
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
    if (!S.minute.length || (S.quote && Date.now() - S.quote.ts < 4 * 60000)) {
      try { await fetchMinute(); saveMinuteCache(); } catch (e) { S.minuteFail = true; }
    }
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
      try {
        await fetchCandles(mode);
      } catch (e) {
        if (mode === 'day') {
          try {
            const alt = await fetchCandlesSina();
            S.day = alt;
            S.candleSource = 'sina';
          } catch (e2) {
            chartEl.innerHTML = `<text x="50%" y="50%" font-size="11" fill="#a4a9b2" text-anchor="middle">日线数据源暂不可用</text>`;
            return;
          }
        } else {
          if (loadH4Cache()) {
            renderChart();
            toast('数据源不可用 · 显示上次的 4 小时线');
            return;
          }
          chartEl.innerHTML = `<text x="50%" y="50%" font-size="11.5" fill="#a4a9b2" text-anchor="middle">4 小时线数据源暂不可用，可先看日线</text>`;
          return;
        }
      }
    }
    renderChart();
  }
}



/* ---------- 4 小时线缓存（源不可用时用上次的） ---------- */
const LS_H4 = 'daily.h4.v1';
function saveH4Cache() {
  try { if (S.h4 && S.h4.length > 2) localStorage.setItem(LS_H4, JSON.stringify(S.h4)); } catch (e) { }
}
function loadH4Cache() {
  try {
    const a = JSON.parse(localStorage.getItem(LS_H4) || '[]');
    if (Array.isArray(a) && a.length > 2) { S.h4 = a; return true; }
  } catch (e) { }
  return false;
}
/* ---------- 日线备用源：新浪 JSONP（东财挂了也能看日线） ---------- */
function fetchCandlesSina() {
  return new Promise((resolve, reject) => {
    const cb = '_sinaK' + Date.now().toString(36);
    const s = document.createElement('script');
    const timer = setTimeout(() => { try { s.remove(); } catch (e) { } reject(new Error('timeout')); }, 12000);
    s.src = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20${cb}=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=XAU`;
    s.onload = () => {
      clearTimeout(timer);
      const raw = window[cb];
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      try { s.remove(); } catch (e) { }
      if (!Array.isArray(raw) || raw.length < 2) return reject(new Error('empty'));
      const out = raw.map(r => {
        const p = String(r.date).split('-');
        return {
          t: +new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1),
          o: +r.open, h: +r.high, l: +r.low, c: +r.close,
          label: p.length === 3 ? p[1] + '-' + p[2] : String(r.date)
        };
      }).filter(k => isFinite(k.o) && k.o > 0);
      out.sort((a, b) => a.t - b.t);
      resolve(out);
    };
    s.onerror = () => { clearTimeout(timer); try { s.remove(); } catch (e) { } reject(new Error('script')); };
    document.head.appendChild(s);
  });
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
  loadMinuteCache();
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
  initCSGestures();
  initSwipeBack();
  document.querySelectorAll('#seg button').forEach(b => b.addEventListener('click', () => loadPeriod(b.dataset.p)));
  document.querySelectorAll('#csSeg button').forEach(b => b.addEventListener('click', () => setCSPeriod(b.dataset.p)));
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


/* ================= CS 大盘（SteamDT 快照） ================= */
const CS = {
  idx: null,
  day: [],
  period: 'rt',
  zoom: { day: { count: 120, start: null } },
  cross: null,
  locked: false
};

function csBox() { return document.getElementById('csBox'); }
function csChartEl() { return document.getElementById('csChart'); }
function csCrossEl() { return document.getElementById('csCross'); }

async function loadCS(force) {
  const bust = '?t=' + Math.floor(Date.now() / 60000);
  try {
    const r = await fetch('./cs/index.json' + bust, { cache: 'no-store' });
    if (r.ok) CS.idx = await r.json();
  } catch (e) { }
  if (!CS.day.length || force) {
    try {
      const r = await fetch('./cs/kline-day.json' + bust, { cache: 'no-store' });
      if (r.ok) CS.day = (await r.json()).data || [];
    } catch (e) { }
  }

  renderCS();
}

function renderCS() {
  const el = document.getElementById('csPrice');
  const st = document.getElementById('csStatus');
  if (!CS.idx || !CS.idx.success) {
    el.textContent = '—';
    st.innerHTML = '<i></i><span>暂无数据</span>';
    return;
  }
  const d = CS.idx.data;
  const v = d.broadMarketIndex;
  const diff = d.diffYesterday;
  const pct = d.diffYesterdayRatio;
  const up = diff >= 0;

  el.textContent = num(v);
  el.className = 'price' + (up ? '' : ' down');
  const chg = document.getElementById('csChg');
  chg.className = 'chg' + (up ? '' : ' down');
  chg.textContent = (up ? '▲ +' : '▼ −') + num(Math.abs(diff)) + '    ' + (up ? '+' : '−') + Math.abs(pct).toFixed(2) + '%';

  const t = new Date(d.updateTime * 1000);
  document.getElementById('csTime').textContent =
    '更新于 ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ' · 每小时一个点';

  st.innerHTML = '<i></i><span>已同步</span>';
  st.className = 'status';
  drawCS();
  if (typeof renderDash === 'function') renderDash();
}

function csVisible(mode, list) {
  const z = CS.zoom[mode] || { count: 120, start: null };
  const total = list.length;
  const minCount = Math.min(8, total);
  const count = clamp(Math.round(z.count || 120), minCount, total);
  const maxStart = Math.max(0, total - count);
  const start = (z.start == null) ? maxStart : clamp(Math.round(z.start), 0, maxStart);
  return { start, count };
}

function drawCS() {
  const box = csBox();
  if (!box) return;
  const w = box.clientWidth, h = box.clientHeight;
  if (w < 20 || h < 20) return;
  csChartEl().setAttribute('viewBox', `0 0 ${w} ${h}`);
  csCrossEl().setAttribute('viewBox', `0 0 ${w} ${h}`);
  csCrossEl().innerHTML = '';

  if (CS.period === 'rt') drawCSLine(w, h);
  else drawCSCandles(w, h, CS.day, 'day');

  if (CS.locked && CS.cross) drawCSCross();
}

function drawCSLine(w, h) {
  const padL = 44, padR = 14, padT = 14, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const raw = (CS.idx && CS.idx.data && CS.idx.data.historyMarketIndexList) || [];
  const pts = raw.map(p => ({ ts: p[0], v: p[1] }));
  if (pts.length < 2) {
    csChartEl().innerHTML = `<text x="${w / 2}" y="${h / 2}" font-size="11" fill="#8e96a5" text-anchor="middle">暂无分时数据</text>`;
    return;
  }
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { if (p.v > hi) hi = p.v; if (p.v < lo) lo = p.v; }
  const pad = (hi - lo) * 0.25 || 1;
  const top = hi + pad, bot = lo - pad;
  const y = v => padT + (top - v) / (top - bot) * plotH;
  const x = i => padL + i / (pts.length - 1) * plotW;

  let svg = `<defs><linearGradient id="csg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#e0503f" stop-opacity="0.20"/><stop offset="1" stop-color="#e0503f" stop-opacity="0"/>
  </linearGradient></defs>`;

  for (let i = 0; i <= 3; i++) {
    const gy = padT + i * plotH / 3;
    svg += `<line x1="${padL}" x2="${w - padR}" y1="${gy}" y2="${gy}" stroke="rgba(120,132,160,.16)" stroke-dasharray="3 4"/>`;
    svg += `<text x="${padL - 6}" y="${gy + 3.5}" font-size="9.5" fill="#8e96a5" text-anchor="end">${Math.round(hi - i * (hi - lo) / 3).toLocaleString()}</text>`;
  }

  const line = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join('');
  svg += `<path d="${line}L${x(pts.length - 1).toFixed(1)} ${h - padB}L${x(0).toFixed(1)} ${h - padB}Z" fill="url(#csg)"/>`;
  svg += `<path d="${line}" fill="none" stroke="#e0503f" stroke-width="2" stroke-linejoin="round"/>`;
  svg += `<circle cx="${x(pts.length - 1)}" cy="${y(pts[pts.length - 1].v)}" r="3" fill="#fff" stroke="#e0503f" stroke-width="1.8"/>`;

  const fmt = ts => { const d = new Date(ts * 1000); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  svg += `<text x="${padL}" y="${h - 6}" font-size="9.5" fill="#8e96a5">${fmt(pts[0].ts)}</text>`;
  svg += `<text x="${w - padR}" y="${h - 6}" font-size="9.5" fill="#8e96a5" text-anchor="end">${fmt(pts[pts.length - 1].ts)}</text>`;

  csChartEl().innerHTML = svg;
}

function drawCSCandles(w, h, list, mode) {
  const padL = 10, padR = 50, padT = 12, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  if (!list || list.length < 2) {
    csChartEl().innerHTML = `<text x="${w / 2}" y="${h / 2}" font-size="11" fill="#8e96a5" text-anchor="middle">正在读取 K 线…</text>`;
    return;
  }

  const win = csVisible(mode, list);
  const view = list.slice(win.start, win.start + win.count);
  let hi = -Infinity, lo = Infinity;
  for (const r of view) { const H = +r[3], L = +r[4]; if (H > hi) hi = H; if (L < lo) lo = L; }
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

  view.forEach((r, i) => {
    const o = +r[1], c = +r[2], gh = +r[3], gl = +r[4];
    const cx = padL + step * i + step / 2;
    const up = c >= o;
    const col = up ? '#e02b2b' : '#0b9d5a';
    svg += `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y(gh).toFixed(1)}" y2="${y(gl).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const yTop = y(Math.max(o, c)), yBot = y(Math.min(o, c));
    svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, yBot - yTop).toFixed(1)}" fill="${col}" rx="${Math.min(2, bw / 3).toFixed(1)}"/>`;
  });

  const fmt = ts => { const d = new Date(ts * 1000); return (d.getMonth() + 1) + '/' + d.getDate(); };
  svg += `<text x="${padL}" y="${h - 6}" font-size="9.5" fill="#8e96a5">${fmt(+view[0][0])}</text>`;
  svg += `<text x="${w - padR}" y="${h - 6}" font-size="9.5" fill="#8e96a5" text-anchor="end">${fmt(+view[view.length - 1][0])}</text>`;

  csChartEl().innerHTML = svg;
}

function drawCSCross() {
  const box = csBox();
  if (!box) return;
  const w = box.clientWidth, h = box.clientHeight;
  const bubble = document.getElementById('csBubble');
  let px = 0, py = 0, html = '';

  if (CS.period === 'rt') {
    const padL = 44, padR = 14, padT = 14, padB = 22;
    const raw = (CS.idx && CS.idx.data && CS.idx.data.historyMarketIndexList) || [];
    if (raw.length < 2) return;
    const pts = raw.map(p => ({ ts: p[0], v: p[1] }));
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { if (p.v > hi) hi = p.v; if (p.v < lo) lo = p.v; }
    const pad = (hi - lo) * 0.25 || 1;
    const top = hi + pad, bot = lo - pad;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const i = clamp(CS.cross.i, 0, pts.length - 1);
    px = padL + i / (pts.length - 1) * plotW;
    py = padT + (top - pts[i].v) / (top - bot) * plotH;
    const d = new Date(pts[i].ts * 1000);
    html = `<div class="t">${pad2(d.getHours())}:${pad2(d.getMinutes())}</div>
      <div class="p">${num(pts[i].v)}</div>`;
  } else {
    const list = CS.day;
    if (!list || list.length < 2) return;
    const padL = 10, padR = 50, padT = 12, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const win = csVisible(CS.period, list);
    const view = list.slice(win.start, win.start + win.count);
    const local = clamp(CS.cross.i - win.start, 0, view.length - 1);
    let hi = -Infinity, lo = Infinity;
    for (const r of view) { if (+r[3] > hi) hi = +r[3]; if (+r[4] < lo) lo = +r[4]; }
    const span = (hi - lo) || 1;
    const step = plotW / view.length;
    const r = view[local];
    px = padL + step * local + step / 2;
    py = padT + (hi - (+r[2])) / span * plotH;
    const pct = ((+r[2]) - (+r[1])) / (+r[1]) * 100;
    const d = new Date(+r[0] * 1000);
    html = `<div class="t">${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}</div>
      <div class="p">${num(+r[2])}<span class="u ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span></div>
      <div class="oh"><span>开 <b>${num(+r[1])}</b></span><span>高 <b>${num(+r[3])}</b></span></div>
      <div class="oh"><span>低 <b>${num(+r[4])}</b></span><span>收 <b>${num(+r[2])}</b></span></div>`;
  }

  csCrossEl().innerHTML =
    `<line x1="${px}" x2="${px}" y1="12" y2="${h - 22}" stroke="#5b616b" stroke-dasharray="3 3"/>` +
    `<line x1="10" x2="${px}" y1="${py}" y2="${py}" stroke="#5b616b" stroke-dasharray="3 3"/>` +
    `<circle cx="${px}" cy="${py}" r="4.5" fill="#fff" stroke="#14171c" stroke-width="1.5"/>`;

  bubble.innerHTML = html;
  bubble.hidden = false;
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  bubble.style.left = clamp(px, bw / 2 + 4, w - bw / 2 - 4) + 'px';
  let top = py - 12, below = false;
  if (top - bh < 4) { top = py + 14; below = true; }
  bubble.style.top = top + 'px';
  bubble.style.transform = below ? 'translate(-50%,0)' : 'translate(-50%,-100%)';
}

function csHideCross() {
  CS.cross = null;
  CS.locked = false;
  csCrossEl().innerHTML = '';
  document.getElementById('csBubble').hidden = true;
  document.getElementById('csHint').textContent = '按住看点位 · 双指缩放时间 · 双击复位';
}

function csPick(x) {
  const box = csBox();
  const w = box.clientWidth;
  if (CS.period === 'rt') {
    const raw = (CS.idx && CS.idx.data && CS.idx.data.historyMarketIndexList) || [];
    if (raw.length < 2) return;
    const padL = 44, padR = 14;
    const i = clamp(Math.round((x - padL) / (w - padL - padR) * (raw.length - 1)), 0, raw.length - 1);
    CS.cross = { i };
  } else {
    const list = CS.day;
    if (!list || list.length < 2) return;
    const padL = 10, padR = 50;
    const win = csVisible(CS.period, list);
    const step = (w - padL - padR) / win.count;
    const local = clamp(Math.floor((x - padL) / step), 0, win.count - 1);
    CS.cross = { i: win.start + local };
  }
  drawCSCross();
}

function initCSGestures() {
  const box = csBox();
  const ptrs = new Map();
  let pinch = null, dragging = false, downX = 0, downY = 0, moved = false, wasLocked = false;
  let lastTapAt = 0, lastTapX = 0;

  function firePinch() {
    const vals = [...ptrs.values()];
    if (vals.length < 2 || CS.period === 'rt') { pinch = null; return; }
    const a = vals[0], b = vals[1];
    const list = CS.day;
    if (!list || list.length < 2) { pinch = null; return; }
    const w = box.clientWidth;
    const padL = 10, padR = 50;
    const win = csVisible(CS.period, list);
    const barW = (w - padL - padR) / win.count;
    const mid = (a.x + b.x) / 2;
    pinch = {
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      count0: win.count,
      idxAtMid: win.start + (mid - padL) / barW,
      total: list.length
    };
    dragging = false;
    moved = true;
    csHideCross();
  }

  box.addEventListener('pointerdown', e => {
    try { box.setPointerCapture(e.pointerId); } catch (err) { }
    const r = box.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    ptrs.set(e.pointerId, p);
    if (ptrs.size === 2) { firePinch(); e.preventDefault(); return; }
    if (ptrs.size > 2) return;
    downX = p.x; downY = p.y; moved = false; wasLocked = CS.locked; dragging = true;
    csPick(p.x);
    e.preventDefault();
  });

  box.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    const r = box.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    ptrs.set(e.pointerId, p);

    if (ptrs.size >= 2) {
      if (pinch && CS.period !== 'rt') {
        const vals = [...ptrs.values()];
        const a = vals[0], b = vals[1];
        const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const list = CS.day;
        const w = box.clientWidth;
        const padL = 10, padR = 50;
        const count = clamp(Math.round(pinch.count0 / (d / pinch.d0)), Math.min(8, pinch.total), pinch.total);
        const barW = (w - padL - padR) / count;
        const mid = (a.x + b.x) / 2;
        let start = Math.round(pinch.idxAtMid - (mid - padL) / barW);
        start = clamp(start, 0, Math.max(0, pinch.total - count));
        CS.zoom[CS.period] = { count, start };
        drawCS();
      }
      e.preventDefault();
      return;
    }
    if (!dragging) return;
    if (Math.abs(p.x - downX) > 6 || Math.abs(p.y - downY) > 6) moved = true;
    csPick(p.x);
    e.preventDefault();
  });

  function end(e) {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (ptrs.size > 0) return;
    if (!dragging) return;
    dragging = false;

    const now = Date.now();
    if (!moved && now - lastTapAt < 320 && Math.abs(downX - lastTapX) < 24) {
      lastTapAt = 0;
      if (CS.period !== 'rt') {
        CS.zoom[CS.period] = { count: 120, start: null };
        drawCS();
        toast('已恢复默认区间');
      }
      csHideCross();
      e.preventDefault();
      return;
    }
    lastTapAt = now; lastTapX = downX;

    if (!moved && wasLocked) csHideCross();
    else { CS.locked = true; }
    e.preventDefault();
  }

  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

function setMarket(m) {
  S.market = m;
  document.querySelectorAll('#marketSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  document.getElementById('goldBlock').hidden = m !== 'gold';
  document.getElementById('csBlock').hidden = m !== 'cs';
  document.getElementById('pageSub').textContent = m === 'gold' ? '伦敦金现货 · 实时' : 'CS2 大盘 · SteamDT';
  if (m === 'cs') { loadCS(false); setTimeout(drawCS, 30); }
  else setTimeout(renderChart, 30);
}

function setCSPeriod(p) {
  CS.period = p;
  document.querySelectorAll('#csSeg button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  csHideCross();
  drawCS();
}

/* =====================================================================
   v2.0 外壳：Bento 首页 + 模块库 + 二级抽屉
   ===================================================================== */

const MODULES = [
  { id: 'gold',      name: '伦敦金现货', sub: '实时价 · 分时 / 4小时 / 日线', icon: '🥇', accent: '#F59E0B', size: 'span-2', cat: '金融盯盘' },
  { id: 'cs2',       name: 'CS2 大盘',   sub: 'SteamDT 指数 · 实时 / 日K',     icon: '📈', accent: '#3B82F6', size: 'span-1', cat: '金融盯盘' },
  { id: 'important', name: '重要日子',   sub: '生日 · 纪念日 · 倒数日',         icon: '🎂', accent: '#F43F5E', size: 'span-1', cat: '生活记录' },
  { id: 'assets',    name: '资产',       sub: '买的物件 · 日均成本',            icon: '📦', accent: '#22C55E', size: 'span-2', cat: '生活记录' },
  { id: 'log',       name: '今天干了什么', sub: '每天记一笔 · 回头看得见',        icon: '📝', accent: '#8B5CF6', size: 'span-1', cat: '生活记录' },
  { id: 'wish',      name: '心愿单',     sub: '想买的东西 · 攒钱目标',          icon: '✨', accent: '#EC4899', size: 'span-1', cat: '生活记录' },
];

const BLOCK_OF = { gold: '#goldBlock', cs2: '#csBlock', important: '#birthBlock', assets: '#assetBlock', log: '#logBlock', wish: '#wishBlock' };

/* ---------- 资产 ---------- */
const LS_ASSETS = 'daily.assets.v1';
const ASSET_EMOJIS = ['📦', '⌚', '🎧', '📷', '💻', '⌨️', '🎮', '📱', '🛴', '🎸', '☕', '🖨️'];

function loadAssets() {
  try { S.assets = JSON.parse(localStorage.getItem(LS_ASSETS) || '[]') || []; }
  catch (e) { S.assets = []; }
}
function saveAssets() {
  try { localStorage.setItem(LS_ASSETS, JSON.stringify(S.assets)); } catch (e) { }
}
function assetDays(a) {
  const p = String(a.buy || '').split('-');
  const d = new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1);
  const days = Math.round((startOfToday() - d) / 86400000) + 1;
  return Math.max(1, isFinite(days) ? days : 1);
}
function assetStats() {
  let total = 0, active = 0, retired = 0, sold = 0, perDay = 0;
  for (const a of S.assets) {
    if (a.status === 'sold') { sold++; continue; }
    total += a.price;
    if (a.status === 'retired') retired++;
    else { active++; perDay += a.price / assetDays(a); }
  }
  return { total, active, retired, sold, perDay, count: S.assets.length };
}
function money(n) { return '¥' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }); }

/* ---------- 重要日子 ---------- */
function dayInfo(b) {
  if (b.type === 'countdown') {
    const d = new Date(b.y || 2000, (b.m || 1) - 1, b.d || 1);
    const days = Math.round((d - startOfToday()) / 86400000);
    return { date: d, days, past: days < 0 };
  }
  const n = nextBirthday(b);
  return { date: n.date, days: n.days, past: false };
}

function importantSorted() {
  return S.births.map(b => ({ b, info: dayInfo(b) }))
    .sort((x, y) => Math.abs(x.info.days) - Math.abs(y.info.days));
}

/* ---------- 区间条 ---------- */
function renderRange() {
  const q = S.quote;
  const bar = document.getElementById('rangeBar');
  if (!bar) return;
  if (!q || !(q.high > q.low)) {
    document.getElementById('rangeText').textContent = '—';
    return;
  }
  const lo = q.low, hi = q.high, cur = q.price;
  const pct = clamp((cur - lo) / (hi - lo) * 100, 0, 100);
  document.getElementById('rangeDot').style.left = pct.toFixed(1) + '%';
  document.getElementById('rangeFill').style.width = pct.toFixed(1) + '%';
  document.getElementById('rangeText').textContent = '当前价处于今日 ' + pct.toFixed(0) + '% 位置';
  document.getElementById('rangeLow').textContent = '今低 ' + num(lo);
  document.getElementById('rangeMid').textContent = '开盘 ' + num(q.open);
  document.getElementById('rangeHigh').textContent = '今高 ' + num(hi);
}

/* ---------- 今日 Bento ---------- */
function renderDash() {
  const bento = document.getElementById('bento');
  if (!bento) return;
  const hidden = S.settings.hidden || {};
  let html = '';

  // 黄金
  if (!hidden.gold) {
    const q = S.quote;
    let price = '—', meta = '连接中…', cls = '';
    if (q) {
      const up = q.price >= q.prev;
      price = num(q.price);
      const diff = q.price - q.prev;
      const pct = q.prev ? diff / q.prev * 100 : 0;
      meta = (up ? '▲ +' : '▼ −') + num(Math.abs(diff)) + '  ' + (up ? '+' : '−') + Math.abs(pct).toFixed(2) + '% · ' + (S.fx > 0 ? (q.price / OZ * S.fx).toFixed(1) + ' 元/克' : '');
      cls = up ? '' : ' down';
    }
    html += `<article class="bento-card span-2" data-module="gold" data-open="gold">
      <div class="bc-top"><span class="bc-label">🥇 伦敦金现货</span><span class="bc-badge">${q ? hhmm(q.ts) + ' 更新' : '读取中'}</span></div>
      <div class="bc-value${cls}" style="color:${q && q.price < q.prev ? '#0b9d5a' : '#e02b2b'}">${price}</div>
      <div class="bc-meta">${meta}</div>
    </article>`;
  }

  // CS2
  if (!hidden.cs2) {
    const d = (typeof CS !== 'undefined' && CS.idx) ? CS.idx.data : null;
    let v = '—', m = '尚未同步';
    if (d) {
      v = num(d.broadMarketIndex);
      m = (d.diffYesterday >= 0 ? '▲ +' : '▼ −') + num(Math.abs(d.diffYesterday)) + '  ' + (d.diffYesterday >= 0 ? '+' : '−') + Math.abs(d.diffYesterdayRatio).toFixed(2) + '%';
    }
    html += `<article class="bento-card span-1" data-module="cs2" data-open="cs2">
      <div class="bc-top"><span class="bc-label">📈 CS2 大盘</span></div>
      <div class="bc-value sm" style="color:${d && d.diffYesterday < 0 ? '#0b9d5a' : '#e0503f'}">${v}</div>
      <div class="bc-meta">${m}</div>
    </article>`;
  }

  // 重要日子
  if (!hidden.important) {
    const list = importantSorted();
    const next = list[0];
    let v = '—', m = '还没有记录';
    if (next) {
      const inf = next.info;
      v = inf.past ? Math.abs(inf.days) + ' 天' : (inf.days === 0 ? '今天' : inf.days + ' 天');
      m = next.b.name + ' · ' + (inf.past ? '已经 ' + Math.abs(inf.days) + ' 天' : (inf.days === 0 ? '就是今天' : '还有 ' + inf.days + ' 天'));
    }
    html += `<article class="bento-card span-1" data-module="important" data-open="important">
      <div class="bc-top"><span class="bc-label">🎂 重要日子</span></div>
      <div class="bc-value sm">${v}</div>
      <div class="bc-meta">${m}</div>
    </article>`;
  }

  // 资产
  if (!hidden.assets) {
    const st = assetStats();
    html += `<article class="bento-card span-2" data-module="assets" data-open="assets">
      <div class="bc-top"><span class="bc-label">📦 资产总额</span><span class="bc-badge">${st.count} 件</span></div>
      <div class="bc-value">${money(st.total)}</div>
      <div class="bc-meta">日均成本 ${money(st.perDay)} · 服役 ${st.active} / 退役 ${st.retired} / 卖出 ${st.sold}</div>
    </article>`;
  }

  // 今天干了什么
  if (!hidden.log) {
    const today = dayKey(new Date());
    const todays = S.logs.filter(l => l.date === today);
    const last = todays.slice().sort((a, b) => (b.time || '').localeCompare(a.time || ''))[0];
    html += `<article class="bento-card span-1" data-module="log" data-open="log">
      <div class="bc-top"><span class="bc-label">📝 今天干了什么</span></div>
      <div class="bc-value sm">${todays.length} 条</div>
      <div class="bc-meta">${last ? esc(last.text.slice(0, 14)) : '还没记，写一条吧'}</div>
    </article>`;
  }

  // 心愿单
  if (!hidden.wish) {
    const st = wishStats();
    html += `<article class="bento-card span-1" data-module="wish" data-open="wish">
      <div class="bc-top"><span class="bc-label">✨ 心愿单</span></div>
      <div class="bc-value sm">${st.left} 件</div>
      <div class="bc-meta">${st.total > 0 ? money(st.total) : '还没有心愿'}</div>
    </article>`;
  }

  bento.innerHTML = html;
  bento.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', () => openModule(el.dataset.open));
  });
}

/* ---------- 模块库 ---------- */
function renderHub() {
  const box = document.getElementById('hubList');
  if (!box) return;
  let html = '';
  let lastCat = '';
  for (const m of MODULES) {
    if (m.cat !== lastCat) {
      html += `<div class="gtitle"><span>${m.cat}</span><i></i></div>`;
      lastCat = m.cat;
    }
    html += `<div class="card rows" style="margin-bottom:10px">
      <div class="hub-item" data-open-module="${m.id}">
        <div class="hub-ic" style="color:${m.accent};background:linear-gradient(180deg,rgba(255,255,255,.9),rgba(255,255,255,.6))">${m.icon}</div>
        <div class="hub-name">${m.name}<small>${m.sub}</small></div>
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#b6bcc7" stroke-width="2" stroke-linecap="round"><path d="M7 4l6 6-6 6"/></svg>
      </div>
    </div>`;
  }
  html += `<div class="srcline">模块开关在「设置 → 模块」里调</div>`;
  box.innerHTML = html;
  box.querySelectorAll('[data-open-module]').forEach(el => {
    el.addEventListener('click', () => openModule(el.dataset.openModule));
  });
}

/* ---------- 二级抽屉 ---------- */
let currentModule = null;

function openModule(id) {
  const sel = BLOCK_OF[id];
  const el = sel && document.querySelector(sel);
  if (!el) return;
  const m = MODULES.find(x => x.id === id);
  currentModule = id;

  document.getElementById('sheetBody').appendChild(el);
  el.hidden = false;
  document.getElementById('sheetTitle').textContent = m ? m.name : '详情';
  document.getElementById('sheetView').hidden = false;

  const action = document.getElementById('sheetAction');
  action.hidden = !(id === 'important' || id === 'assets' || id === 'log' || id === 'wish');
  action.onclick = () => {
    if (id === 'important') openEditor('day', null);
    if (id === 'assets') openEditor('asset', null);
    if (id === 'log') openEditor('log', null);
    if (id === 'wish') openEditor('wish', null);
  };

  if (id === 'gold') {
    renderGold(); renderRange();
    setTimeout(() => { loadPeriod(S.settings.period); renderChart(); }, 40);
    requestAnimationFrame(() => requestAnimationFrame(() => { renderChart(); renderGold(); }));
  }
  if (id === 'cs2') {
    loadCS(false);
    setTimeout(drawCS, 60);
    requestAnimationFrame(() => requestAnimationFrame(drawCS));
  }
  if (id === 'important') renderBirths();
  if (id === 'assets') renderAssets();
  if (id === 'log') renderLogs();
  if (id === 'wish') renderWishes();
}

function closeModule() {
  if (!currentModule) return;
  const sel = BLOCK_OF[currentModule];
  const el = sel && document.querySelector(sel);
  if (el) { el.hidden = true; document.getElementById('pool').appendChild(el); }
  document.getElementById('sheetView').hidden = true;
  currentModule = null;
  renderDash();
}

/* ---------- 主 Tab ---------- */
function goTab(name) {
  S.tab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  document.getElementById('viewDash').hidden = name !== 'dash';
  document.getElementById('viewHub').hidden = name !== 'hub';
  document.getElementById('viewSettings').hidden = name !== 'settings';
  document.getElementById('btnRefresh').hidden = name !== 'dash';

  const meta = {
    dash: ['今日', '实时行情与日程摘要'],
    hub: ['模块', '全部功能 · 点开使用'],
    settings: ['设置', '提醒、刷新与数据'],
  }[name];
  document.getElementById('pageTitle').textContent = meta[0];
  document.getElementById('pageSub').textContent = meta[1];

  if (name === 'dash') renderDash();
  if (name === 'hub') renderHub();
  if (name === 'settings') renderSettings();
}

/* ---------- 资产列表 ---------- */
function renderAssets() {
  const box = document.getElementById('assetList');
  if (!box) return;
  const st = assetStats();
  const f = S.assetFilter || 'all';
  const filters = [['all', '全部'], ['active', '服役中'], ['retired', '已退役'], ['sold', '已卖出']];

  let html = `
    <section class="card asset-sum">
      <div class="bc-label" style="font-size:11px;color:var(--muted);font-weight:600">总资产</div>
      <div class="big">${money(st.total)}</div>
      <div class="bc-meta" style="margin-top:6px">日均成本 ${money(st.perDay)} · 共 ${st.count} 件</div>
      <div class="split">
        <div><b>${st.active}</b><span>服役中</span></div>
        <div><b>${st.retired}</b><span>已退役</span></div>
        <div><b>${st.sold}</b><span>已卖出</span></div>
      </div>
    </section>
    <div class="asset-filters">${filters.map(([k, n]) =>
      `<button type="button" class="chip ${f === k ? 'on' : ''}" data-f="${k}">${n}</button>`).join('')}
    </div>
    <div class="asset-grid">`;

  const list = S.assets.filter(a => f === 'all' || a.status === f);
  if (!list.length) {
    html += `<div class="empty" style="grid-column:span 2;padding:30px 10px">
      <div class="ic">📦</div><div class="s">点右上角 ＋ 记一件买过的东西</div></div>`;
  } else {
    for (const a of list) {
      const days = assetDays(a);
      const per = a.price / days;
      const stCls = a.status === 'retired' ? 'retired' : (a.status === 'sold' ? 'sold' : '');
      const stName = a.status === 'retired' ? '已退役' : (a.status === 'sold' ? '已卖出' : '服役中');
      html += `<div class="asset-card" data-asset="${a.id}">
        <span class="st ${stCls}">${stName}</span>
        <div class="emoji">${a.emoji || '📦'}</div>
        <div class="nm">${esc(a.name)}</div>
        <div class="sub">${money(a.price)} · ${days} 天</div>
        <div class="per">${money(per)}<small>/天</small></div>
      </div>`;
    }
  }
  html += `</div>`;
  box.innerHTML = html;

  box.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => {
    S.assetFilter = b.dataset.f;
    renderAssets();
  }));
  box.querySelectorAll('[data-asset]').forEach(c => c.addEventListener('click', () => {
    openAssetItem(c.dataset.asset);
  }));
}
/* ---------- 重要日子列表（v2） ---------- */
function renderBirths() {
  const box = document.getElementById('birthList');
  if (!box) return;
  const list = importantSorted();
  const cnt = document.getElementById('birthCount');
  if (cnt) cnt.textContent = S.births.length + ' 条';

  if (!list.length) {
    box.innerHTML = `<div class="card empty"><div class="ic">🎂</div><div class="t">还没有记录</div>
      <div class="s">点右上角 ＋ 添加第一条</div></div>`;
    return;
  }

  let html = '';
  for (const item of list) {
    const b = item.b, info = item.info;
    const isBday = (b.type || 'birthday') !== 'countdown';
    const big = info.days === 0 ? '今天' : Math.abs(info.days);
    const small = info.days === 0 ? '就是今天' : (info.past ? '天前' : '天后');
    const dateTxt = isBday
      ? (b.lunar ? lunarLabel(b.m, b.d, b.leap) : (b.m + ' 月 ' + b.d + ' 日'))
      : (info.date.getMonth() + 1) + ' 月 ' + info.date.getDate() + ' 日';
    const tag = isBday ? (b.lunar ? '农历' : '生日') : '纪念日';
    const color = info.past ? '#5b616b' : (info.days <= 7 ? '#e0503f' : '#8e949e');

    html += `<div class="card day-card" data-day="${b.id}">
      <div class="day-main">
        <div class="avatar" style="background:${avatarColor(b.name)}">${esc((b.name || '?').slice(0, 1))}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:650;display:flex;align-items:center;gap:6px">
            ${esc(b.name)}
            <span class="tag ${b.lunar ? 'lunar' : ''}">${tag}</span>
            ${b.rel ? `<span class="tag">${esc(b.rel)}</span>` : ''}
          </div>
          <div style="font-size:11.5px;color:#8e949e;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${dateTxt}${b.note ? ' · ' + esc(b.note) : ''}
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:19px;font-weight:700;color:${color};font-variant-numeric:tabular-nums">${big}</div>
          <div style="font-size:10.5px;color:#8e949e;margin-top:4px">${small}</div>
        </div>
      </div>
      <div class="day-more">
        ${b.note ? '📝 ' + esc(b.note) : '还没有备注，点「编辑」可以写礼物灵感'}
        <div class="acts">
          <button type="button" data-edit="${b.id}">编辑</button>
          <button type="button" class="danger" data-del="${b.id}">删除</button>
        </div>
      </div>
    </div>`;
  }
  box.innerHTML = html;

  box.querySelectorAll('.day-card').forEach(card => {
    card.querySelector('.day-main').addEventListener('click', () => card.classList.toggle('open'));
  });
  box.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation(); openEditor('day', el.dataset.edit);
  }));
  box.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation(); deleteEditor('day', el.dataset.del);
  }));
}

/* ---------- 通用编辑器 ---------- */
let editorKind = null, editorId = null, editDraft = null;

function closeEditor() {
  document.getElementById('sheet').hidden = true;
  editorKind = null; editorId = null; editDraft = null;
}

function chipRow(id, items, cur) {
  return `<div class="chips" id="${id}">${items.map(([v, l]) =>
    `<button type="button" class="chip ${String(v) === String(cur) ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>`;
}

function bindChips(sel, cb) {
  document.querySelectorAll(sel + ' .chip').forEach(c => c.addEventListener('click', () => {
    document.querySelectorAll(sel + ' .chip').forEach(x => x.classList.toggle('on', x === c));
    cb(c.dataset.v);
  }));
}

function openEditor(kind, id) {
  editorKind = kind; editorId = id || null;
  const form = document.getElementById('sheetForm');
  const delBtn = document.getElementById('fDelete');
  delBtn.hidden = !id;
  delBtn.onclick = () => deleteEditor(kind, id);

  if (kind === 'day') {
    const b = id ? S.births.find(x => x.id === id) : null;
    editDraft = b ? Object.assign({}, b) : { type: 'birthday', name: '', y: '', m: '', d: '', lunar: false, rel: '朋友', lead: S.settings.defaultLead, note: '' };
    document.getElementById('sheetHeadTitle').textContent = b ? '编辑日子' : '添加日子';
    form.innerHTML =
      `<div class="field"><span>类型</span>${chipRow('eType', [['birthday', '生日（每年循环）'], ['countdown', '纪念日 / 倒数日']], editDraft.type || 'birthday')}</div>
       <label class="field"><span>名称</span><input id="eName" type="text" maxlength="16" placeholder="妈妈 / 在一起 / 买相机" value="${esc(editDraft.name || '')}"></label>
       <div class="field"><span>日期 · 月 / 日（生日年份可不填）</span>
         <div class="dateRow">
           <input id="eY" type="number" inputmode="numeric" placeholder="年" value="${editDraft.y || ''}">
           <input id="eM" type="number" inputmode="numeric" placeholder="月" value="${editDraft.m || ''}">
           <input id="eD" type="number" inputmode="numeric" placeholder="日" value="${editDraft.d || ''}">
         </div>
       </div>
       <label class="switchRow" id="lunarRow"><span>农历生日</span><input type="checkbox" id="eLunar" ${editDraft.lunar ? 'checked' : ''}><i></i></label>
       <div class="field"><span>关系</span>${chipRow('eRel', RELS.map(r => [r, r]), editDraft.rel)}</div>
       <div class="field"><span>提前提醒</span>${chipRow('eLead', LEADS.map(d => [d, leadText(d)]), editDraft.lead)}</div>
       <label class="field"><span>备注 / 礼物灵感</span><input id="eNote" type="text" maxlength="40" placeholder="喜欢什么口味、今年送什么…" value="${esc(editDraft.note || '')}"></label>`;

    bindChips('#eType', v => {
      editDraft.type = v;
      const lr = document.getElementById('lunarRow');
      if (lr) lr.style.display = v === 'birthday' ? '' : 'none';
    });
    bindChips('#eRel', v => editDraft.rel = v);
    bindChips('#eLead', v => editDraft.lead = +v);
    const lr = document.getElementById('lunarRow');
    if (lr) lr.style.display = (editDraft.type || 'birthday') === 'birthday' ? '' : 'none';
  } else if (kind === 'log') {
    const lg = id ? S.logs.find(x => x.id === id) : null;
    const now = new Date();
    editDraft = lg ? Object.assign({}, lg) : { date: dayKey(now), time: pad2(now.getHours()) + ':' + pad2(now.getMinutes()), text: '' };
    document.getElementById('sheetHeadTitle').textContent = lg ? '编辑记录' : '记一笔';
    form.innerHTML =
      `<label class="field"><span>干了什么</span><input id="lText" type="text" maxlength="60" placeholder="修好了键盘 / 跑了 5 公里 / 看完一本书" value="${esc(editDraft.text || '')}"></label>
       <label class="field"><span>日期</span><input id="lDate" type="date" value="${editDraft.date || ''}"></label>
       <label class="field"><span>时间</span><input id="lTime" type="time" value="${editDraft.time || ''}"></label>`;
  } else if (kind === 'wish') {
    const wi = id ? S.wishes.find(x => x.id === id) : null;
    editDraft = wi ? Object.assign({}, wi) : { name: '', price: '', note: '', got: false };
    document.getElementById('sheetHeadTitle').textContent = wi ? '编辑心愿' : '添加心愿';
    form.innerHTML =
      `<label class="field"><span>想要什么</span><input id="wName" type="text" maxlength="24" placeholder="相机 / 显示器 / 一次旅行" value="${esc(editDraft.name || '')}"></label>
       <label class="field"><span>大概价格</span><input id="wPrice" type="number" inputmode="decimal" placeholder="0" value="${editDraft.price || ''}"></label>
       <label class="field"><span>备注</span><input id="wNote" type="text" maxlength="30" placeholder="为什么想要 / 攒到什么时候" value="${esc(editDraft.note || '')}"></label>
       <label class="switchRow"><span>已经实现</span><input type="checkbox" id="wGot" ${editDraft.got ? 'checked' : ''}><i></i></label>`;
  } else {
    const a = id ? S.assets.find(x => x.id === id) : null;
    editDraft = a ? Object.assign({}, a) : { name: '', emoji: '📦', price: '', buy: dayKey(new Date()), status: 'active' };
    document.getElementById('sheetHeadTitle').textContent = a ? '编辑资产' : '添加资产';
    form.innerHTML =
      `<label class="field"><span>名称</span><input id="aName" type="text" maxlength="20" placeholder="相机 / 键盘" value="${esc(editDraft.name || '')}"></label>
       <div class="field"><span>图标</span>
         <div class="emojiPick" id="aEmojiPick">
           <div class="big" id="aEmojiView">${editDraft.emoji || '📦'}</div>
           <div class="hint">点击选择图标</div>
         </div>
       </div>
       <label class="field"><span>价格（元）</span><input id="aPrice" type="number" inputmode="decimal" placeholder="0" value="${editDraft.price || ''}"></label>
       <label class="field"><span>购入日期</span><input id="aBuy" type="date" value="${editDraft.buy || ''}"></label>
       <div class="field"><span>类别</span>${chipRow('aCat', ['数码', '穿戴', '家居', '工具', '其他', '未分类'].map(c => [c, c]), editDraft.category || '未分类')}</div>
       <div class="field"><span>状态</span>${chipRow('aStatus', [['active', '服役中'], ['retired', '已退役'], ['sold', '已卖出']], editDraft.status)}</div>`;
    const ep = document.getElementById('aEmojiPick');
    if (ep) ep.addEventListener('click', () => openIconPicker(v => {
      editDraft.emoji = v;
      const view = document.getElementById('aEmojiView');
      if (view) view.textContent = v;
    }));
    bindChips('#aCat', v => editDraft.category = v);
    bindChips('#aStatus', v => editDraft.status = v);
  }

  document.getElementById('sheet').hidden = false;
}

function saveEditor() {
  if (editorKind === 'day') {
    const name = document.getElementById('eName').value.trim();
    if (!name) { alert('先填个名称'); return; }
    const y = +document.getElementById('eY').value || 0;
    const m = +document.getElementById('eM').value;
    const d = +document.getElementById('eD').value;
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) { alert('日期填 1–12 月、1–31 日'); return; }
    const type = editDraft.type || 'birthday';
    if (type === 'countdown' && !y) { alert('纪念日需要填年份'); return; }

    const obj = {
      id: editorId || ('d' + Date.now().toString(36)),
      type, name, y, m, d,
      lunar: type === 'birthday' && document.getElementById('eLunar').checked,
      leap: false,
      rel: editDraft.rel || '朋友',
      lead: editDraft.lead == null ? S.settings.defaultLead : editDraft.lead,
      note: document.getElementById('eNote').value.trim()
    };
    if (editorId) {
      const i = S.births.findIndex(x => x.id === editorId);
      if (i >= 0) S.births[i] = obj; else S.births.push(obj);
    } else S.births.push(obj);
    saveBirths();
  } else if (editorKind === 'log') {
    const text = document.getElementById('lText').value.trim();
    if (!text) { alert('写点什么吧'); return; }
    const obj = {
      id: editorId || ('l' + Date.now().toString(36)),
      text,
      date: document.getElementById('lDate').value || dayKey(new Date()),
      time: document.getElementById('lTime').value || ''
    };
    if (editorId) { const i = S.logs.findIndex(x => x.id === editorId); if (i >= 0) S.logs[i] = obj; else S.logs.push(obj); }
    else S.logs.push(obj);
    saveLogs();
  } else if (editorKind === 'wish') {
    const name2 = document.getElementById('wName').value.trim();
    if (!name2) { alert('先填想要什么'); return; }
    const obj = {
      id: editorId || ('w' + Date.now().toString(36)),
      name: name2,
      price: +document.getElementById('wPrice').value || 0,
      note: document.getElementById('wNote').value.trim(),
      got: document.getElementById('wGot').checked
    };
    if (editorId) { const i = S.wishes.findIndex(x => x.id === editorId); if (i >= 0) S.wishes[i] = obj; else S.wishes.push(obj); }
    else S.wishes.push(obj);
    saveWishes();
  } else {
    const name = document.getElementById('aName').value.trim();
    const price = +document.getElementById('aPrice').value;
    if (!name) { alert('先填名称'); return; }
    if (!(price > 0)) { alert('价格要大于 0'); return; }
    const obj = {
      id: editorId || ('a' + Date.now().toString(36)),
      name, emoji: editDraft.emoji || '📦', price,
      buy: document.getElementById('aBuy').value || dayKey(new Date()),
      status: editDraft.status || 'active',
      category: editDraft.category || '未分类'
    };
    if (editorId) {
      const i = S.assets.findIndex(x => x.id === editorId);
      if (i >= 0) S.assets[i] = obj; else S.assets.push(obj);
    } else S.assets.push(obj);
    saveAssets();
  }
  closeEditor();
  renderBirths(); renderAssets(); renderLogs(); renderWishes(); renderDash(); renderSettings();
}

function deleteEditor(kind, id) {
  const stores = { day: S.births, asset: S.assets, log: S.logs, wish: S.wishes };
  const arr = stores[kind];
  if (!arr) return;
  const target = arr.find(x => x.id === id);
  if (!target) return;
  const label = target.name || target.text || '这条记录';
  if (!confirm('删除「' + label + '」？')) return;

  if (kind === 'day') { S.births = S.births.filter(x => x.id !== id); saveBirths(); }
  else if (kind === 'asset') { S.assets = S.assets.filter(x => x.id !== id); saveAssets(); }
  else if (kind === 'log') { S.logs = S.logs.filter(x => x.id !== id); saveLogs(); }
  else if (kind === 'wish') { S.wishes = S.wishes.filter(x => x.id !== id); saveWishes(); }

  closeEditor();
  renderBirths(); renderAssets(); renderLogs(); renderWishes(); renderDash(); renderSettings();
}
/* ---------- 设置页（v2） ---------- */
function renderSettings() {
  const lead = document.getElementById('setLead');
  if (lead) lead.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', +c.dataset.v === S.settings.defaultLead));
  const iv = document.getElementById('setInterval');
  if (iv) iv.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', +c.dataset.v === S.settings.interval));

  const modBox = document.getElementById('setModules');
  if (modBox) {
    const hiddenMap = S.settings.hidden || {};
    modBox.innerHTML = MODULES.map(m =>
      '<div class="hub-item">' +
        '<div class="hub-ic" style="color:' + m.accent + '">' + m.icon + '</div>' +
        '<div class="hub-name">' + m.name + '</div>' +
        '<div class="hub-toggle ' + (hiddenMap[m.id] ? '' : 'on') + '" data-toggle="' + m.id + '" style="--accent-sys:' + m.accent + '"><i></i></div>' +
      '</div>').join('');
    modBox.querySelectorAll('[data-toggle]').forEach(t => t.addEventListener('click', () => {
      const id = t.dataset.toggle;
      S.settings.hidden = S.settings.hidden || {};
      S.settings.hidden[id] = !S.settings.hidden[id];
      saveSettings(); renderSettings(); renderDash();
    }));
  }
  const bc = document.getElementById('birthCount'); if (bc) bc.textContent = S.births.length + ' 条';
  const ac = document.getElementById('assetCount'); if (ac) ac.textContent = S.assets.length + ' 件';
  const vt = document.getElementById('verText'); if (vt) vt.textContent = '2.0';

  const btn = document.getElementById('btnNotify');
  if (btn) {
    if (!('Notification' in window)) btn.textContent = '不支持';
    else if (Notification.permission === 'granted') btn.textContent = '已开启';
    else if (Notification.permission === 'denied') btn.textContent = '被拒绝';
    else btn.textContent = '开启';
  }
}


/* ---------- 侧滑返回 ---------- */
function initSwipeBack() {
  const sv = document.getElementById('sheetView');
  if (!sv) return;
  let sx = 0, sy = 0, dx = 0, tracking = false, active = false;

  sv.addEventListener('pointerdown', e => {
    if (!currentModule) return;
    const left = sv.getBoundingClientRect().left;
    if (e.clientX - left > 34) return;
    tracking = true; active = false; sx = e.clientX; sy = e.clientY; dx = 0;
  }, { passive: true });

  sv.addEventListener('pointermove', e => {
    if (!tracking) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!active) {
      if (Math.abs(my) > 16 && Math.abs(my) > Math.abs(mx)) { tracking = false; return; }
      if (mx < 12) return;
      active = true;
      sv.classList.add('dragging');
    }
    dx = Math.max(0, mx);
    sv.style.transform = 'translateX(' + dx + 'px)';
    if (e.cancelable) e.preventDefault();
  });

  function finish() {
    if (!tracking) { return; }
    tracking = false;
    if (!active) { return; }
    active = false;
    sv.classList.remove('dragging');
    sv.classList.add('closing');
    if (dx > 88) {
      sv.style.transform = 'translateX(100%)';
      setTimeout(() => {
        sv.classList.remove('closing');
        sv.style.transform = '';
        closeModule();
      }, 190);
    } else {
      sv.style.transform = 'translateX(0)';
      setTimeout(() => sv.classList.remove('closing'), 190);
    }
    dx = 0;
  }

  sv.addEventListener('pointerup', finish);
  sv.addEventListener('pointercancel', finish);
  sv.addEventListener('pointerleave', finish);
}

/* ---------- 资产单品详情（三级页） ---------- */
let currentAsset = null;

function openAssetItem(id) {
  currentAsset = id;
  renderAssetItem();
  document.getElementById('itemView').hidden = false;
}

function closeAssetItem() {
  currentAsset = null;
  document.getElementById('itemView').hidden = true;
}

function costChartSvg(a, days) {
  const W = 320, H = 190, padL = 6, padR = 42, padT = 10, padB = 24;
  const N = Math.min(Math.max(days, 2), 60);
  const pts = [];
  for (let i = 0; i < N; i++) {
    const d = Math.max(1, Math.round(Math.pow(days, i / (N - 1))));
    pts.push({ d, v: a.price / d });
  }
  const vmax = a.price, vmin = a.price / days;
  const lgc = v => Math.log10(Math.max(0.01, v));
  const top = lgc(vmax), bot = lgc(vmin);
  const span = (top - bot) || 1;
  const xOf = dVal => padL + (dVal - 1) / Math.max(1, days - 1) * (W - padL - padR);
  const y = v => padT + (top - lgc(v)) / span * (H - padT - padB);

  let svg = `<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7ed321" stop-opacity="0.28"/><stop offset="1" stop-color="#7ed321" stop-opacity="0"/></linearGradient></defs>`;

  for (let i = 0; i <= 3; i++) {
    const v = Math.pow(10, top - i * span / 3);
    const gy = padT + i * (H - padT - padB) / 3;
    const label = v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : Math.round(v);
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${gy}" y2="${gy}" stroke="rgba(120,132,160,.18)" stroke-dasharray="3 4" stroke-width="1"/>`;
    svg += `<text x="${W - padR + 8}" y="${gy + 4}" font-size="11" fill="#9aa1ad">${label}</text>`;
  }

  const line = pts.map((p, i) => (i ? 'L' : 'M') + xOf(p.d).toFixed(1) + ' ' + y(p.v).toFixed(1)).join('');
  svg += `<path d="${line}L${xOf(days).toFixed(1)} ${H - padB}L${xOf(1).toFixed(1)} ${H - padB}Z" fill="url(#cg)"/>`;
  svg += `<path d="${line}" fill="none" stroke="#6cc51f" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
  svg += `<circle cx="${xOf(days).toFixed(1)}" cy="${y(pts[N - 1].v).toFixed(1)}" r="3.4" fill="#fff" stroke="#6cc51f" stroke-width="2"/>`;

  const bd = new Date(a.buy);
  const fmt = d => (d.getMonth() + 1) + '.' + d.getDate();
  const today = new Date();
  svg += `<text x="${padL}" y="${H - 6}" font-size="10.5" fill="#9aa1ad">${fmt(bd)}</text>`;
  svg += `<text x="${W - padR}" y="${H - 6}" font-size="10.5" fill="#9aa1ad" text-anchor="end">今天</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}</svg>`;
}

function renderAssetItem() {
  const a = S.assets.find(x => x.id === currentAsset);
  const body = document.getElementById('itemBody');
  if (!a || !body) { closeAssetItem(); return; }
  const days = assetDays(a);
  const per = a.price / days;
  const stName = a.status === 'retired' ? '已退役' : (a.status === 'sold' ? '已卖出' : '已服役');
  const bd = new Date(a.buy);
  costCtx = null;

  body.innerHTML =
    `<div class="itemHero">
      <div class="emoji">${a.emoji || '📦'}</div>
      <div class="nm">${esc(a.name)}</div>
      <div class="per">${money(per)}<small>/天</small></div>
      <div class="sub">总价：${money(a.price)}　·　${stName} ${days} 天</div>
    </div>
    <section class="card itemChart">
      <h4>日均成本</h4>
      <div class="costBox" id="costBox">
        <div id="costChartHost" style="position:absolute;inset:0">${costChartSvg(a, days)}</div>
        <svg id="costCross" viewBox="0 0 320 190" preserveAspectRatio="none"></svg>
        <div class="bubble" id="costBubble" hidden></div>
      </div>
    </section>
    <section class="card rows itemRows">
      <div class="row"><span>价格</span><b>${money(a.price)}</b></div>
      <div class="row"><span>类别</span><b>${esc(a.category || '未分类')}</b></div>
      <div class="row"><span>购买日期</span><b>${bd.getFullYear()}年${bd.getMonth() + 1}月${bd.getDate()}日</b></div>
    </section>
    <button type="button" class="itemDel" id="itemDelete">
      <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>
      删除
    </button>`;

  costCtx = { price: a.price, days, buy: new Date(a.buy) };
  const cc = document.getElementById('costCross'); if (cc) cc.innerHTML = '';
  const cb = document.getElementById('costBubble'); if (cb) cb.hidden = true;
  initCostChart();

  const del = document.getElementById('itemDelete');
  if (del) del.addEventListener('click', () => { deleteEditor('asset', a.id); closeAssetItem(); });
}

/* ---------- 日均成本曲线：长按看第 N 天 ---------- */
let costCtx = null, costPressing = false;

function openCostCross(clientX) {
  const box = document.getElementById('costBox');
  const cross = document.getElementById('costCross');
  const bubble = document.getElementById('costBubble');
  if (!box || !cross || !bubble || !costCtx) return;

  const W = 320, H = 190, padL = 6, padR = 42, padT = 10, padB = 24;
  const r = box.getBoundingClientRect();
  const xSvg = clamp((clientX - r.left) / r.width * W, padL, W - padR);
  const t = clamp((xSvg - padL) / (W - padL - padR), 0, 1);
  const day = Math.max(1, Math.min(costCtx.days, Math.round(1 + t * (costCtx.days - 1))));
  const v = costCtx.price / day;

  const lgc = x => Math.log10(Math.max(0.01, x));
  const top = lgc(costCtx.price), bot = lgc(costCtx.price / costCtx.days);
  const span = (top - bot) || 1;
  const px = padL + (day - 1) / Math.max(1, costCtx.days - 1) * (W - padL - padR);
  const py = padT + (top - lgc(v)) / span * (H - padT - padB);

  cross.innerHTML =
    `<line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${padT}" y2="${H - padB}" stroke="#5b616b" stroke-dasharray="3 3" stroke-width="1"/>` +
    `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.8" fill="#fff" stroke="#6cc51f" stroke-width="2"/>`;

  const d = new Date(costCtx.buy);
  d.setDate(d.getDate() + day - 1);
  bubble.innerHTML =
    `<div class="t">第 ${day} 天</div>` +
    `<div class="p">${money(v)}<span class="u">/天</span></div>` +
    `<div class="oh"><span>${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}</span></div>`;
  bubble.hidden = false;

  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  const leftCss = px / W * r.width;
  bubble.style.left = clamp(leftCss, bw / 2 + 4, r.width - bw / 2 - 4) + 'px';
  const topCss = py / H * r.height - 12;
  bubble.style.top = (topCss - bh < 4 ? topCss + bh + 24 : topCss) + 'px';
  bubble.style.transform = topCss - bh < 4 ? 'translate(-50%,0)' : 'translate(-50%,-100%)';
}

function initCostChart() {
  const box = document.getElementById('costBox');
  if (!box) return;
  box.addEventListener('pointerdown', e => {
    costPressing = true;
    try { box.setPointerCapture(e.pointerId); } catch (err) { }
    openCostCross(e.clientX);
    e.preventDefault();
  });
  box.addEventListener('pointermove', e => {
    if (costPressing) openCostCross(e.clientX);
  });
  box.addEventListener('pointerup', () => { costPressing = false; });
  box.addEventListener('pointercancel', () => { costPressing = false; });
}
/* ---------- 启动（v2） ---------- */
function bootV2() {
  loadSettings();
  loadBirths();
  loadAssets();
  loadLogs();
  loadWishes();
  loadMinuteCache();
  loadH4Cache();

  const leadBox = document.getElementById('setLead');
  if (leadBox) leadBox.innerHTML = LEADS.map(d => `<button type="button" class="chip" data-v="${d}">${leadText(d)}</button>`).join('');
  const ivBox = document.getElementById('setInterval');
  if (ivBox) ivBox.innerHTML = [15, 30, 60].map(s => `<button type="button" class="chip" data-v="${s}">${s}s</button>`).join('');

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => goTab(t.dataset.tab)));
  document.getElementById('sheetBack').addEventListener('click', closeModule);
  document.getElementById('itemClose').addEventListener('click', closeAssetItem);
  document.getElementById('itemEdit').addEventListener('click', () => { if (currentAsset) openEditor('asset', currentAsset); });
  document.getElementById('sheetCancel').addEventListener('click', closeEditor);
  document.getElementById('pickerClose').addEventListener('click', () => { document.getElementById('pickerView').hidden = true; });
  document.getElementById('mask').addEventListener('click', closeEditor);
  document.getElementById('fSave').addEventListener('click', saveEditor);
  document.getElementById('btnRefresh').addEventListener('click', () => refreshGold(true));

  if (leadBox) leadBox.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    S.settings.defaultLead = +c.dataset.v; saveSettings(); renderSettings();
  }));
  if (ivBox) ivBox.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    S.settings.interval = +c.dataset.v; saveSettings(); scheduleRefresh(); renderSettings();
  }));

  document.getElementById('btnNotify').addEventListener('click', enableNotify);
  document.getElementById('btnIcs').addEventListener('click', exportICS);
  document.getElementById('btnBackup').addEventListener('click', () => {
    const dump = {};
    for (const k of Object.keys(localStorage)) if (k.indexOf('daily.') === 0) dump[k] = localStorage.getItem(k);
    const blob = new Blob([JSON.stringify({ v: 2, at: Date.now(), data: dump }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'daily-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('备份已导出');
  });
  document.getElementById('btnClear').addEventListener('click', () => {
    if (!confirm('清空全部数据（重要日子、资产、设置缓存）？此操作无法撤销')) return;
    S.births = []; S.assets = [];
    saveBirths(); saveAssets();
    renderBirths(); renderAssets(); renderDash(); renderSettings();
    toast('已清空');
  });

  document.querySelectorAll('#seg button').forEach(b => b.addEventListener('click', () => loadPeriod(b.dataset.p)));
  document.querySelectorAll('#csSeg button').forEach(b => b.addEventListener('click', () => setCSPeriod(b.dataset.p)));

  initGestures();
  initCSGestures();
  initSwipeBack();

  goTab('dash');
  renderSettings();
  refreshGold(false);
  loadCS(false);
  scheduleRefresh();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refreshGold(false); loadCS(false); renderDash(); checkNotify(); }
  });
  window.addEventListener('resize', () => { if (currentModule === 'gold') renderChart(); if (currentModule === 'cs2') drawCS(); });

  setTimeout(checkNotify, 1000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
}


/* ================= 图标选择器 ================= */
const ICON_GROUPS = [
  { name: '数码', items: ['💻', '⌨️', '🖱️', '📱', '📷', '📹', '🎥', '🎮', '🕹️', '🎧', '🎤', '🖥️', '💾', '💿', '📀', '📼', '☎️', '📞', '📠', '📺', '📻', '🎙️', '⌚', '🖨️', '⌨️'] },
  { name: '电器', items: ['🔌', '💡', '🔦', '🧯', '🪔', '🧺', '🧹', '🧴', '🪣', '🧽', '🛁', '🚿', '🧼', '🪒', '🪥', '🌡️', '🧊', '🪭', '🔋', '📺'] },
  { name: '房产', items: ['🏠', '🏡', '🏢', '🏬', '🏨', '🏦', '🏪', '🏫', '🏛️', '🏗️', '🧱', '🪟', '🛋️', '🛏️', '🚪', '🪑', '🖼️', '🕯️', '🪴', '🧴'] },
  { name: '交通', items: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🛻', '🚚', '🚛', '🚜', '🛵', '🏍️', '🚲', '🛴', '🛹', '⛵', '✈️'] },
  { name: '箱包', items: ['🎒', '👝', '👛', '👜', '💼', '🧳', '🕶️', '👟', '👞', '🧢', '🎩', '💍', '🪞', '👓'] },
  { name: '生活', items: ['🎁', '📦', '🍰', '☕', '🎵', '📚', '✏️', '🖊️', '📌', '🧸', '🌱', '🎨', '🧩', '🪄', '⭐', '🛒', '🎫', '🍜', '🏀', '🎸'] },
];

let pickerCb = null, pickerCat = '全部';

function renderPicker() {
  const cats = document.getElementById('pickerCats');
  const grid = document.getElementById('pickerGrid');
  if (!cats || !grid) return;
  cats.innerHTML = ['全部'].concat(ICON_GROUPS.map(g => g.name))
    .map(n => `<button type="button" class="chip ${pickerCat === n ? 'on' : ''}" data-cat="${n}">${n}</button>`).join('');
  const items = pickerCat === '全部'
    ? ICON_GROUPS.reduce((a, g) => a.concat(g.items), [])
    : (ICON_GROUPS.find(g => g.name === pickerCat) || { items: [] }).items;
  grid.innerHTML = items.map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join('');

  cats.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
    pickerCat = b.dataset.cat; renderPicker();
  }));
  grid.querySelectorAll('[data-emoji]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.emoji;
    document.getElementById('pickerView').hidden = true;
    if (pickerCb) pickerCb(v);
  }));
}

function openIconPicker(cb) {
  pickerCb = cb;
  pickerCat = '全部';
  renderPicker();
  document.getElementById('pickerView').hidden = false;
}

/* ================= 今天干了什么 ================= */
const LS_LOGS = 'daily.logs.v1';
function loadLogs() {
  try { S.logs = JSON.parse(localStorage.getItem(LS_LOGS) || '[]') || []; } catch (e) { S.logs = []; }
}
function saveLogs() {
  try { localStorage.setItem(LS_LOGS, JSON.stringify(S.logs)); } catch (e) { }
}

function renderLogs() {
  const box = document.getElementById('logList');
  if (!box) return;
  const today = dayKey(new Date());
  const todays = S.logs.filter(l => l.date === today).sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  const past = S.logs.filter(l => l.date !== today)
    .sort((a, b) => (b.date + (b.time || '')) .localeCompare(a.date + (a.time || '')))
    .slice(0, 60);

  let html = `<section class="card" style="padding:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between">
        <div>
          <div style="font-size:11px;color:var(--muted);font-weight:600;letter-spacing:.05em">今天</div>
          <div style="font-size:30px;font-weight:700;margin-top:4px">${todays.length} 条</div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:6px">${today.replace(/-/g, '.')}</div>
        </div>
        <div style="font-size:34px">📝</div>
      </div>
    </section>`;

  if (!todays.length) {
    html += `<div class="card empty"><div class="ic">🫧</div><div class="t">今天还空着</div><div class="s">点右上角 ＋ 写一条</div></div>`;
  } else {
    html += `<div class="card rows" style="padding:0">` + todays.map(l =>
      `<div class="log-item" data-log="${l.id}">
        <div class="log-time">${l.time || ''}</div>
        <div class="log-text">${esc(l.text)}</div>
      </div>`).join('') + `</div>`;
  }

  if (past.length) {
    html += `<div class="log-date">往前</div><div class="card rows" style="padding:0">`;
    let last = '';
    for (const l of past) {
      if (l.date !== last) {
        html += `<div class="log-date" style="margin:12px 16px 2px">${l.date.replace(/-/g, '.')}</div>`;
        last = l.date;
      }
      html += `<div class="log-item" data-log="${l.id}">
        <div class="log-time">${l.time || ''}</div>
        <div class="log-text">${esc(l.text)}</div>
      </div>`;
    }
    html += `</div>`;
  }

  box.innerHTML = html;
  box.querySelectorAll('[data-log]').forEach(el => el.addEventListener('click', () => openEditor('log', el.dataset.log)));
}

/* ================= 心愿单 ================= */
const LS_WISH = 'daily.wishes.v1';
function loadWishes() {
  try { S.wishes = JSON.parse(localStorage.getItem(LS_WISH) || '[]') || []; } catch (e) { S.wishes = []; }
}
function saveWishes() {
  try { localStorage.setItem(LS_WISH, JSON.stringify(S.wishes)); } catch (e) { }
}
function wishStats() {
  let total = 0, got = 0;
  for (const w of S.wishes) { if (w.got) got++; else total += (+w.price || 0); }
  return { total, got, count: S.wishes.length, left: S.wishes.length - got };
}

function renderWishes() {
  const box = document.getElementById('wishList');
  if (!box) return;
  const st = wishStats();
  let html = `<section class="card" style="padding:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between">
        <div>
          <div style="font-size:11px;color:var(--muted);font-weight:600;letter-spacing:.05em">还想要</div>
          <div style="font-size:30px;font-weight:700;margin-top:4px">${money(st.total)}</div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:6px">${st.left} 件未实现 · 已实现 ${st.got} 件</div>
        </div>
        <div style="font-size:34px">✨</div>
      </div>
    </section>`;

  if (!st.count) {
    html += `<div class="card empty"><div class="ic">🎁</div><div class="t">还没有心愿</div><div class="s">点右上角 ＋ 加一个想要的东西</div></div>`;
  } else {
    const list = S.wishes.slice().sort((a, b) => (a.got ? 1 : 0) - (b.got ? 1 : 0));
    html += `<div class="card rows" style="padding:0">` + list.map(w =>
      `<div class="wish-row ${w.got ? 'got' : ''}" data-wish="${w.id}">
        <div class="nm">${esc(w.name)}${w.note ? `<small>${esc(w.note)}</small>` : ''}</div>
        ${w.got ? `<span class="wish-done">已实现</span>` : ''}
        <div class="pr">${w.price ? money(w.price) : '—'}</div>
      </div>`).join('') + `</div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-wish]').forEach(el => el.addEventListener('click', () => openEditor('wish', el.dataset.wish)));
}

bootV2();
