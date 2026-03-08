// ═══════════════════════════════════════════════════════
// Agent Ops Admin — Comprehensive Admin Panel v2
// ═══════════════════════════════════════════════════════
'use strict';

// ── API Layer ──
const BASE = (() => { const s = document.currentScript?.src || ''; const i = s.lastIndexOf('/'); return i > 0 ? s.substring(0, i) : ''; })();
async function api(m, p, b) {
  const o = { method: m, headers: { 'Content-Type': 'application/json' } };
  const t = localStorage.getItem('aat');
  if (t) o.headers['Authorization'] = 'Bearer ' + t;
  if (b) o.body = JSON.stringify(b);
  const r = await fetch(BASE + p, o);
  if (r.status === 401) throw new Error('auth');
  return r.json();
}
const G = p => api('GET', p), PUT = (p, b) => api('PUT', p, b), POST = (p, b) => api('POST', p, b), DEL = p => api('DELETE', p);

// ── State ──
const AN = { master: 'Master调度中枢', data_auditor: '数据审计', ops_supervisor: '运营督导', chief_evaluator: '绩效考核', train_advisor: '培训顾问', appeal: '申诉处理', marketing_planner: '营销策划', marketing_executor: '营销执行', procurement_advisor: '采购建议' };
let tab = 'dashboard';
let S = { hl: {}, st: {}, fs: {}, agents: {}, rules: [], scores: {}, campaigns: [], templates: [], evalReport: {}, auditItems: [], cfgs: [], schedCfg: {}, anomalyCfg: {}, ratingCfg: {}, kpiTargets: [] };

// ── DOM Helpers ──
function $(id) { return document.getElementById(id); }
function el(t, a, c) {
  const e = document.createElement(t);
  if (a) Object.entries(a).forEach(([k, v]) => {
    if (k.startsWith('on')) e[k] = v;
    else if (k === 'className') e.className = v;
    else if (k === 'value') e.value = v;
    else if (k === 'innerHTML') e.innerHTML = v;
    else if (k === 'checked') e.checked = v;
    else e.setAttribute(k, v);
  });
  if (typeof c === 'string') e.textContent = c;
  else if (c instanceof HTMLElement) e.appendChild(c);
  else if (Array.isArray(c)) c.forEach(x => { if (x) e.appendChild(x); });
  return e;
}
function card(title, children) {
  const w = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-4' });
  if (title) w.appendChild(el('h3', { className: 'text-base font-semibold text-gray-800 mb-4 pb-2 border-b border-gray-100' }, title));
  if (Array.isArray(children)) children.forEach(c => { if (c) w.appendChild(c); });
  else if (children) w.appendChild(children);
  return w;
}
function stat(n, l, color) {
  const d = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-5 text-center' });
  d.appendChild(el('div', { className: 'text-2xl font-bold ' + (color || 'text-indigo-600') }, String(n)));
  d.appendChild(el('div', { className: 'text-xs text-gray-500 mt-1' }, l));
  return d;
}
function btn(label, onClick, cls) {
  return el('button', { className: cls || 'bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors font-medium', onclick: onClick }, label);
}
function btnDanger(label, onClick) { return btn(label, onClick, 'bg-red-50 text-red-600 text-sm px-3 py-1.5 rounded-lg hover:bg-red-100 transition-colors font-medium border border-red-200'); }
function btnGhost(label, onClick) { return btn(label, onClick, 'bg-gray-50 text-gray-700 text-sm px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors font-medium border border-gray-200'); }
function inp(id, ph, tp, cls) { return el('input', { id, type: tp || 'text', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none transition ' + (cls || ''), placeholder: ph }); }
function lbl(text) { return el('label', { className: 'block text-xs font-medium text-gray-600 mb-1' }, text); }
function field(label, inputEl) { const d = el('div', { className: 'mb-3' }); d.appendChild(lbl(label)); d.appendChild(inputEl); return d; }
function msg(t, isErr) {
  let m = $('toast');
  if (!m) { m = el('div', { id: 'toast', className: 'fixed top-4 right-4 px-5 py-3 rounded-xl shadow-lg text-sm z-50 font-medium transition-all' }); document.body.appendChild(m); }
  m.className = 'fixed top-4 right-4 px-5 py-3 rounded-xl shadow-lg text-sm z-50 font-medium transition-all ' + (isErr ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white');
  m.textContent = t; m.style.display = 'block'; setTimeout(() => m.style.display = 'none', 3000);
}
function fmtDate(d) { if (!d) return '-'; return String(typeof d === 'string' ? d : d.toISOString?.() || '').slice(0, 10); }
const STS = { planned: '🟡 计划中', active: '🟢 执行中', completed: '✅ 已完成', cancelled: '⛔ 已取消' };

// ═══════════════════════════════════════════════════════
// LOGIN (no inline handlers — uses el() onclick)
// ═══════════════════════════════════════════════════════
function renderLogin() {
  const a = $('app'); a.innerHTML = '';
  const wrap = el('div', { className: 'min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-purple-50' });
  const box = el('div', { className: 'w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-100 p-8' });
  box.appendChild(el('div', { className: 'text-center mb-8' }, [
    el('div', { className: 'text-5xl mb-3' }, '🤖'),
    el('h1', { className: 'text-2xl font-bold text-gray-900' }, 'Agent Ops Admin'),
    el('p', { className: 'text-sm text-gray-500 mt-1' }, 'Agents Service V2 管理面板')
  ]));
  box.appendChild(field('用户名', inp('lu', '请输入用户名')));
  const pwdInp = inp('lp', '请输入密码', 'password');
  pwdInp.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  box.appendChild(field('密码', pwdInp));
  box.appendChild(el('div', { id: 'lerr', className: 'text-red-500 text-xs mb-3 hidden' }));
  box.appendChild(btn('登 录', doLogin, 'w-full bg-indigo-600 text-white rounded-lg py-3 hover:bg-indigo-700 transition-colors font-semibold text-base'));
  // Token login
  const det = el('details', { className: 'mt-6' });
  det.appendChild(el('summary', { className: 'text-xs text-gray-400 cursor-pointer hover:text-gray-600' }, '高级: Token登录'));
  const detBox = el('div', { className: 'mt-2' });
  detBox.appendChild(inp('ti', 'JWT Token', 'password', 'text-xs'));
  detBox.appendChild(btn('Token登录', doTokenLogin, 'w-full mt-2 bg-gray-100 text-gray-600 text-xs rounded-lg py-2 hover:bg-gray-200'));
  det.appendChild(detBox);
  box.appendChild(det);
  wrap.appendChild(box); a.appendChild(wrap);
}

async function doLogin() {
  const u = $('lu')?.value?.trim(), p = $('lp')?.value?.trim(), errEl = $('lerr');
  if (!u || !p) { if (errEl) { errEl.textContent = '请输入用户名和密码'; errEl.classList.remove('hidden'); } return; }
  try {
    const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    const d = await r.json();
    if (d.ok && d.token) { localStorage.setItem('aat', d.token); go('dashboard'); }
    else { if (errEl) { errEl.textContent = d.error || '登录失败'; errEl.classList.remove('hidden'); } }
  } catch (e) { if (errEl) { errEl.textContent = '网络错误'; errEl.classList.remove('hidden'); } }
}
function doTokenLogin() { const t = $('ti')?.value?.trim(); if (t) { localStorage.setItem('aat', t); go('dashboard'); } }

// ═══════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════
function viewDash() {
  const w = el('div');
  const tt = (S.st.tasks || []).reduce((s, t) => s + (t.c || 0), 0);
  const pend = (S.st.tasks || []).find(t => t.status === 'pending_response')?.c || 0;
  const row = el('div', { className: 'grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6' });
  row.appendChild(stat(S.hl.ok ? '🟢 在线' : '🔴 离线', '系统状态'));
  row.appendChild(stat(S.st.messages24h || 0, '24h消息量', 'text-blue-600'));
  row.appendChild(stat(S.st.anomaliesToday || 0, '今日异常', S.st.anomaliesToday > 0 ? 'text-red-600' : 'text-green-600'));
  row.appendChild(stat(tt, '总任务数', 'text-purple-600'));
  row.appendChild(stat(pend, '待处理', pend > 0 ? 'text-orange-600' : 'text-green-600'));
  w.appendChild(row);

  const svcRow = el('div', { className: 'grid grid-cols-1 md:grid-cols-4 gap-4 mb-6' });
  const svcCard = (icon, title, ok, detail) => {
    const c = el('div', { className: 'bg-white rounded-xl shadow-sm border p-4 flex items-center gap-3 ' + (ok ? 'border-green-200' : 'border-red-200') });
    c.appendChild(el('div', { className: 'text-2xl' }, icon));
    const info = el('div');
    info.appendChild(el('div', { className: 'font-semibold text-sm' }, title));
    info.appendChild(el('div', { className: 'text-xs ' + (ok ? 'text-green-600' : 'text-red-600') }, detail));
    c.appendChild(info); return c;
  };
  svcRow.appendChild(svcCard('🗄️', 'PostgreSQL', S.hl.database, S.hl.database ? '连接正常' : '未连接'));
  svcRow.appendChild(svcCard('⚡', 'Redis', S.hl.redis, S.hl.redis ? '连接正常' : '未连接'));
  svcRow.appendChild(svcCard('💬', '飞书', S.fs.configured, S.fs.configured ? (S.fs.hasToken ? 'Token有效' : '已配置/Token刷新中') : '未配置'));
  svcRow.appendChild(svcCard('🧠', 'LLM', true, '3 providers'));
  w.appendChild(svcRow);

  w.appendChild(el('div', { className: 'text-xs text-gray-400 mt-2' }, 'Uptime: ' + (S.hl.uptime ? Math.round(S.hl.uptime / 60) + ' min' : 'N/A') + ' | Version: ' + (S.hl.version || '?') + ' | ' + Object.keys(AN).length + ' Agents'));
  return w;
}

// ═══════════════════════════════════════════════════════
// AGENT CONFIG
// ═══════════════════════════════════════════════════════
function viewAgents() {
  const w = el('div');
  w.appendChild(el('div', { className: 'flex justify-between items-center mb-4' }, [
    el('h2', { className: 'text-lg font-bold text-gray-900' }, 'Agent 配置管理'),
    el('span', { className: 'text-xs bg-indigo-100 text-indigo-700 px-3 py-1 rounded-full font-medium' }, Object.keys(AN).length + ' Agents')
  ]));
  Object.entries(AN).forEach(([id, nm]) => {
    const c = S.agents[id] || {};
    const isEnabled = c.enabled !== false;
    const b = el('div', { className: 'bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-3 ' + (isEnabled ? '' : 'opacity-60') });
    const hd = el('div', { className: 'flex justify-between items-center mb-3' });
    const titleRow = el('div', { className: 'flex items-center gap-2' });
    titleRow.appendChild(el('span', { className: 'w-2 h-2 rounded-full ' + (isEnabled ? 'bg-green-500' : 'bg-gray-400') }));
    titleRow.appendChild(el('span', { className: 'font-semibold text-gray-900' }, nm));
    titleRow.appendChild(el('code', { className: 'text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded font-mono' }, id));
    hd.appendChild(titleRow);
    const ck = el('input', { type: 'checkbox', id: 'ae_' + id, className: 'w-4 h-4 text-indigo-600 rounded' }); ck.checked = isEnabled;
    const lbEl = el('label', { className: 'flex items-center gap-2 text-sm text-gray-600' }); lbEl.appendChild(ck); lbEl.appendChild(el('span', {}, '启用'));
    hd.appendChild(lbEl); b.appendChild(hd);
    b.appendChild(lbl('System Prompt'));
    const ta = el('textarea', { id: 'ap_' + id, className: 'w-full border border-gray-300 rounded-lg p-3 text-sm mt-1 mb-3 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none', rows: '3' }); ta.value = c.prompt || ''; b.appendChild(ta);
    const row = el('div', { className: 'flex gap-4 items-end' });
    const mf = (label, eid, val, w) => { const d = el('div'); d.appendChild(lbl(label)); d.appendChild(el('input', { id: eid, type: 'number', step: '0.1', className: 'border border-gray-300 rounded-lg px-3 py-2 text-sm ' + w + ' focus:ring-2 focus:ring-indigo-200 outline-none', value: String(val) })); return d; };
    row.appendChild(mf('Temperature', 'at_' + id, c.temperature || 0.3, 'w-24'));
    row.appendChild(mf('MaxTokens', 'am_' + id, c.maxTokens || 800, 'w-28'));
    row.appendChild(mf('Model', 'amd_' + id, '', 'w-36'));
    const modelInp = row.querySelector('#amd_' + id); if (modelInp) { modelInp.type = 'text'; modelInp.value = c.model || 'deepseek-chat'; }
    row.appendChild(btn('保存', async () => {
      const cfg = { prompt: $('ap_' + id).value, temperature: parseFloat($('at_' + id).value) || 0.3, maxTokens: parseInt($('am_' + id).value) || 800, enabled: $('ae_' + id).checked, model: $('amd_' + id)?.value || 'deepseek-chat' };
      await PUT('/api/agent-config/' + id, cfg); S.agents[id] = cfg; msg(nm + ' 配置已保存');
    }));
    b.appendChild(row); w.appendChild(b);
  });
  return w;
}

// ═══════════════════════════════════════════════════════
// SCHEDULED TASKS (定时任务)
// ═══════════════════════════════════════════════════════
function viewScheduled() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '定时任务与巡检配置'));
  const cfg = S.schedCfg || {};

  // Rhythm schedule
  w.appendChild(card('节奏引擎 - 定时调度', (() => {
    const items = [
      { key: 'morning', label: '晨检推送', time: '09:30', desc: '每日发送门店晨检提醒' },
      { key: 'patrol_am', label: '上午巡检', time: '11:30', desc: '午市前巡检推送' },
      { key: 'patrol_pm', label: '下午巡检', time: '16:30', desc: '晚市前巡检推送' },
      { key: 'eod', label: '日终报告', time: '21:30', desc: '日终运营数据汇总推送' },
      { key: 'weekly', label: '周报', time: '周一 10:00', desc: '周度运营分析报告' },
      { key: 'monthly', label: '月评', time: '每月1日 10:00', desc: '月度绩效评估报告' }
    ];
    const g = el('div', { className: 'space-y-2' });
    items.forEach(it => {
      const r = el('div', { className: 'flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg' });
      const left = el('div', { className: 'flex items-center gap-3' });
      const ck = el('input', { type: 'checkbox', id: 'rhy_' + it.key, className: 'w-4 h-4 text-indigo-600 rounded' });
      ck.checked = cfg['rhythm_' + it.key] !== false;
      left.appendChild(ck);
      left.appendChild(el('div', {}, [el('span', { className: 'font-medium text-sm' }, it.label), el('span', { className: 'text-xs text-gray-500 ml-2' }, it.desc)]));
      r.appendChild(left);
      r.appendChild(el('span', { className: 'text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded font-mono' }, it.time));
      g.appendChild(r);
    });
    g.appendChild(btn('保存节奏配置', async () => {
      const data = {};
      items.forEach(it => { data['rhythm_' + it.key] = $('rhy_' + it.key)?.checked !== false; });
      await PUT('/api/config/rhythm_schedule', { config_value: data, description: '节奏引擎调度配置' });
      msg('节奏配置已保存 → 后端立即生效');
    }, 'mt-3 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));

  // Daily inspections
  w.appendChild(card('每日巡检任务', (() => {
    const daily = cfg.dailyInspections || [
      { store: '洪潮大宁久光店', brand: '洪潮', type: 'opening', time: '10:30' },
      { store: '马己仙上海音乐广场店', brand: '马己仙', type: 'opening', time: '10:00' },
      { store: '洪潮大宁久光店', brand: '洪潮', type: 'closing', time: '22:00' },
      { store: '马己仙上海音乐广场店', brand: '马己仙', type: 'closing', time: '22:30' }
    ];
    const g = el('div');
    const tbl = el('table', { className: 'w-full text-sm' });
    const th = el('tr'); ['门店', '品牌', '类型', '时间', '频率'].forEach(x => th.appendChild(el('th', { className: 'text-left p-2 border-b-2 text-gray-600 font-medium text-xs' }, x)));
    tbl.appendChild(th);
    daily.forEach((d, i) => {
      const tr = el('tr', { className: 'hover:bg-gray-50' });
      tr.appendChild(el('td', { className: 'p-2 border-b text-xs' }, d.store));
      tr.appendChild(el('td', { className: 'p-2 border-b text-xs' }, d.brand));
      const typeSelect = el('select', { className: 'border rounded px-2 py-1 text-xs', id: 'di_type_' + i });
      ['opening', 'closing', 'patrol'].forEach(v => { const o = el('option', { value: v }, v === 'opening' ? '开档' : v === 'closing' ? '收档' : '巡检'); if (v === d.type) o.selected = true; typeSelect.appendChild(o); });
      const tdType = el('td', { className: 'p-2 border-b' }); tdType.appendChild(typeSelect); tr.appendChild(tdType);
      const timeInp = el('input', { type: 'time', value: d.time || '10:00', id: 'di_time_' + i, className: 'border rounded px-2 py-1 text-xs' });
      const tdTime = el('td', { className: 'p-2 border-b' }); tdTime.appendChild(timeInp); tr.appendChild(tdTime);
      tr.appendChild(el('td', { className: 'p-2 border-b text-xs' }, d.frequency || 'daily'));
      tbl.appendChild(tr);
    });
    g.appendChild(tbl);
    g.appendChild(btn('保存巡检配置', async () => {
      const items = daily.map((d, i) => ({ ...d, type: $('di_type_' + i)?.value || d.type, time: $('di_time_' + i)?.value || d.time }));
      await PUT('/api/config/daily_inspections', { config_value: items, description: '每日巡检任务配置' });
      msg('巡检配置已保存 → 后端立即生效');
    }, 'mt-3 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));

  // Random inspections
  w.appendChild(card('随机抽检配置', (() => {
    const random = cfg.randomInspections || [
      { type: '海鲜池水温', description: '拍摄海鲜池水温计照片', timeWindow: 15, intervalMinHours: 2, intervalMaxHours: 4 },
      { type: '冰箱标签检查', description: '检查冰箱标签是否过期', timeWindow: 10, intervalMinHours: 2, intervalMaxHours: 4 },
      { type: '洗手20秒', description: '录制洗手20秒视频', timeWindow: 5, intervalMinHours: 2, intervalMaxHours: 4 }
    ];
    const g = el('div', { className: 'space-y-3' });
    random.forEach((r, i) => {
      const row = el('div', { className: 'bg-gray-50 rounded-lg p-3 flex flex-wrap gap-3 items-center' });
      row.appendChild(el('div', { className: 'font-medium text-sm min-w-[120px]' }, r.type));
      row.appendChild(el('div', { className: 'text-xs text-gray-500 flex-1' }, r.description));
      const tw = el('div', { className: 'flex items-center gap-1' }); tw.appendChild(lbl('限时(分)')); tw.appendChild(el('input', { type: 'number', value: String(r.timeWindow), id: 'ri_tw_' + i, className: 'border rounded px-2 py-1 text-xs w-16' })); row.appendChild(tw);
      const iv = el('div', { className: 'flex items-center gap-1' }); iv.appendChild(lbl('间隔(h)')); iv.appendChild(el('input', { type: 'number', value: String(r.intervalMinHours), id: 'ri_min_' + i, className: 'border rounded px-2 py-1 text-xs w-14' })); iv.appendChild(el('span', {}, '~')); iv.appendChild(el('input', { type: 'number', value: String(r.intervalMaxHours), id: 'ri_max_' + i, className: 'border rounded px-2 py-1 text-xs w-14' })); row.appendChild(iv);
      g.appendChild(row);
    });
    g.appendChild(btn('保存抽检配置', async () => {
      const items = random.map((r, i) => ({ ...r, timeWindow: parseInt($('ri_tw_' + i)?.value) || r.timeWindow, intervalMinHours: parseInt($('ri_min_' + i)?.value) || r.intervalMinHours, intervalMaxHours: parseInt($('ri_max_' + i)?.value) || r.intervalMaxHours }));
      await PUT('/api/config/random_inspections', { config_value: items, description: '随机抽检配置' });
      msg('抽检配置已保存 → 后端立即生效');
    }, 'mt-3 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));
  return w;
}

// ═══════════════════════════════════════════════════════
// ANOMALY THRESHOLDS (异常阈值)
// ═══════════════════════════════════════════════════════
function viewAnomaly() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '异常检测阈值配置'));
  const cfg = S.anomalyCfg || {};
  const global = cfg.global || {};
  const thresholds = [
    { key: 'revenueGapMedium', label: '营收差距(Medium)', val: global.revenueGapMedium ?? 0.10, unit: '比率' },
    { key: 'revenueGapHigh', label: '营收差距(High)', val: global.revenueGapHigh ?? 0.20, unit: '比率' },
    { key: 'efficiencyMedium', label: '人效值(Medium)', val: global.efficiencyMedium ?? 1100, unit: '元/时' },
    { key: 'efficiencyHigh', label: '人效值(High)', val: global.efficiencyHigh ?? 1000, unit: '元/时' },
    { key: 'marginMedium', label: '毛利率(Medium)', val: global.marginMedium ?? 0.69, unit: '比率' },
    { key: 'marginHigh', label: '毛利率(High)', val: global.marginHigh ?? 0.68, unit: '比率' },
    { key: 'tableVisitRatioMedium', label: '桌访占比(Medium)', val: global.tableVisitRatioMedium ?? 0.5, unit: '比率' },
    { key: 'tableVisitRatioHigh', label: '桌访占比(High)', val: global.tableVisitRatioHigh ?? 0.4, unit: '比率' },
    { key: 'badReviewMedium', label: '差评数(Medium)', val: global.badReviewMedium ?? 1, unit: '条' },
    { key: 'badReviewHigh', label: '差评数(High)', val: global.badReviewHigh ?? 2, unit: '条' },
    { key: 'rechargeStreakHighDays', label: '充值连续异常天数', val: global.rechargeStreakHighDays ?? 2, unit: '天' },
  ];

  w.appendChild(card('全局异常阈值', (() => {
    const g = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3' });
    thresholds.forEach(t => {
      const row = el('div', { className: 'flex items-center gap-3 bg-gray-50 rounded-lg px-3 py-2' });
      row.appendChild(el('span', { className: 'text-sm font-medium flex-1 min-w-[160px]' }, t.label));
      row.appendChild(el('input', { type: 'number', step: '0.01', value: String(t.val), id: 'at_' + t.key, className: 'border rounded-lg px-3 py-1.5 text-sm w-24 text-center' }));
      row.appendChild(el('span', { className: 'text-xs text-gray-400 w-12' }, t.unit));
      g.appendChild(row);
    });
    g.appendChild(btn('保存全局阈值', async () => {
      const data = {};
      thresholds.forEach(t => { data[t.key] = parseFloat($('at_' + t.key)?.value) || t.val; });
      await PUT('/api/config/anomaly_thresholds', { config_value: { global: data, storeOverrides: cfg.storeOverrides || {} }, description: '异常检测阈值' });
      msg('异常阈值已保存 → 下次检测生效');
    }, 'mt-4 col-span-2 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));

  // Store overrides
  const overrides = cfg.storeOverrides || {};
  w.appendChild(card('门店特殊阈值覆盖', (() => {
    const g = el('div');
    if (!Object.keys(overrides).length) g.appendChild(el('p', { className: 'text-sm text-gray-500' }, '暂无门店特殊配置，使用全局阈值'));
    Object.entries(overrides).forEach(([store, vals]) => {
      const row = el('div', { className: 'bg-gray-50 rounded-lg p-3 mb-2' });
      row.appendChild(el('div', { className: 'font-medium text-sm mb-2' }, '📍 ' + store));
      const items = el('div', { className: 'flex flex-wrap gap-2' });
      Object.entries(vals).forEach(([k, v]) => { items.appendChild(el('span', { className: 'bg-white border rounded px-2 py-1 text-xs' }, k + ': ' + v)); });
      row.appendChild(items); g.appendChild(row);
    });
    return g;
  })()));
  return w;
}

// ═══════════════════════════════════════════════════════
// PERFORMANCE EVALUATION (绩效考核标准)
// ═══════════════════════════════════════════════════════
function viewPerformance() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '绩效考核标准设置'));

  // Deduction rules
  const deductions = [
    { cat: '桌访占比异常', role: 'store_manager', med: 10, high: 20, freq: 'monthly' },
    { cat: '实收营收异常', role: 'store_manager', med: 20, high: 40, freq: 'monthly' },
    { cat: '人效值异常', role: 'store_manager', med: 10, high: 20, freq: 'monthly' },
    { cat: '充值异常', role: 'store_manager', med: 1, high: 2, freq: 'daily' },
    { cat: '总实收毛利率异常', role: 'store_production_manager', med: 20, high: 40, freq: 'monthly' },
    { cat: '产品差评异常', role: 'store_production_manager', med: 5, high: 10, freq: 'weekly' },
    { cat: '服务差评异常', role: 'store_manager', med: 5, high: 10, freq: 'weekly' },
    { cat: '桌访产品异常', role: 'store_production_manager', med: 5, high: 10, freq: 'weekly' },
  ];
  w.appendChild(card('异常扣分规则', (() => {
    const tbl = el('table', { className: 'w-full text-sm' });
    const th = el('tr'); ['异常类型', '责任角色', 'Medium扣分', 'High扣分', '频率'].forEach(x => th.appendChild(el('th', { className: 'text-left p-2 border-b-2 text-gray-600 font-medium text-xs' }, x)));
    tbl.appendChild(th);
    deductions.forEach((d, i) => {
      const tr = el('tr', { className: 'hover:bg-gray-50' });
      tr.appendChild(el('td', { className: 'p-2 border-b text-xs font-medium' }, d.cat));
      tr.appendChild(el('td', { className: 'p-2 border-b text-xs' }, d.role === 'store_manager' ? '店长' : '出品经理'));
      const medTd = el('td', { className: 'p-2 border-b' }); medTd.appendChild(el('input', { type: 'number', value: String(d.med), id: 'ded_m_' + i, className: 'border rounded px-2 py-1 text-xs w-16 text-center' })); tr.appendChild(medTd);
      const highTd = el('td', { className: 'p-2 border-b' }); highTd.appendChild(el('input', { type: 'number', value: String(d.high), id: 'ded_h_' + i, className: 'border rounded px-2 py-1 text-xs w-16 text-center' })); tr.appendChild(highTd);
      tr.appendChild(el('td', { className: 'p-2 border-b text-xs' }, d.freq));
      tbl.appendChild(tr);
    });
    const g = el('div');
    g.appendChild(tbl);
    g.appendChild(btn('保存扣分规则', async () => {
      const data = deductions.map((d, i) => ({ ...d, med: parseInt($('ded_m_' + i)?.value) || d.med, high: parseInt($('ded_h_' + i)?.value) || d.high }));
      await PUT('/api/config/deduction_rules', { config_value: data, description: '异常扣分规则' });
      msg('扣分规则已保存 → 下次评分生效');
    }, 'mt-3 bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700'));
    return g;
  })()));

  // Rating criteria
  w.appendChild(card('门店评级标准', (() => {
    const g = el('div', { className: 'space-y-2' });
    [{ grade: 'A', label: '达成率 > 95%', cls: 'bg-green-50 text-green-700 border-green-200' },
     { grade: 'B', label: '达成率 > 90%', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
     { grade: 'C', label: '达成率 >= 85%', cls: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
     { grade: 'D', label: '达成率 < 85%', cls: 'bg-red-50 text-red-700 border-red-200' }
    ].forEach(r => {
      g.appendChild(el('div', { className: 'flex items-center gap-3 border rounded-lg px-4 py-2 ' + r.cls }, [
        el('span', { className: 'font-bold text-lg w-8' }, r.grade), el('span', { className: 'text-sm' }, r.label)
      ]));
    });
    return g;
  })()));

  // Bonus config
  w.appendChild(card('奖金计算规则', (() => {
    const g = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-4' });
    [{ brand: '马己仙', base: 1500 }, { brand: '洪潮', base: 2000 }].forEach(b => {
      const c = el('div', { className: 'bg-gray-50 rounded-lg p-4' });
      c.appendChild(el('div', { className: 'font-semibold text-sm mb-2' }, b.brand));
      c.appendChild(el('div', { className: 'text-xs text-gray-600 space-y-1' }, [
        el('div', {}, '基础奖金: ¥' + b.base),
        el('div', {}, 'A/B级: 奖金 = 得分/100 × ' + b.base),
        el('div', {}, 'C级: 奖金归零'),
        el('div', {}, 'D级: 工资打8折')
      ]));
      g.appendChild(c);
    });
    return g;
  })()));
  return w;
}

// ═══════════════════════════════════════════════════════
// MARKETING (营销管理)
// ═══════════════════════════════════════════════════════
function viewMarketing() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '营销管理'));

  // Create campaign form
  w.appendChild(card('创建营销活动', (() => {
    const g = el('div');
    const r1 = el('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-3 mb-3' });
    r1.appendChild(field('门店', inp('c_store', '选择门店'))); r1.appendChild(field('活动标题', inp('c_title', '活动名称')));
    r1.appendChild(field('开始日期', inp('c_start', '', 'date'))); r1.appendChild(field('结束日期', inp('c_end', '', 'date')));
    g.appendChild(r1);
    const r2 = el('div', { className: 'grid grid-cols-3 gap-3 mb-3' });
    r2.appendChild(field('目标指标', inp('c_metric', '如: revenue'))); r2.appendChild(field('目标值', inp('c_target', '0', 'number'))); r2.appendChild(field('预算', inp('c_budget', '0', 'number')));
    g.appendChild(r2);
    g.appendChild(field('描述', inp('c_desc', '活动详细描述')));
    g.appendChild(btn('创建活动', async () => {
      const d = { store: $('c_store').value, title: $('c_title').value, description: $('c_desc').value, start_date: $('c_start').value, end_date: $('c_end').value, target_metric: $('c_metric').value, target_value: $('c_target').value, budget_amount: $('c_budget').value };
      if (!d.store || !d.title) { msg('请填写门店和标题', true); return; }
      await POST('/api/campaigns', d); msg('活动已创建'); go('marketing');
    }, 'bg-emerald-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-emerald-700 font-medium'));
    return g;
  })()));

  // Campaign list
  if (S.campaigns.length) {
    w.appendChild(card('活动列表 (' + S.campaigns.length + ')', (() => {
      const tbl = el('table', { className: 'w-full text-sm' });
      const th = el('tr'); ['门店', '活动', '状态', '时间', '目标', '实际', '预算', '操作'].forEach(x => th.appendChild(el('th', { className: 'text-left p-2 border-b-2 text-gray-600 text-xs font-medium' }, x)));
      tbl.appendChild(th);
      S.campaigns.forEach(c => {
        const tr = el('tr', { className: 'hover:bg-gray-50' });
        [c.store || '', c.title || '', STS[c.status] || c.status, fmtDate(c.start_date) + '~' + fmtDate(c.end_date), (c.target_metric || '') + '=' + (c.target_value || ''), String(c.actual_value || '-'), '¥' + (c.budget_amount || 0)].forEach(x => tr.appendChild(el('td', { className: 'p-2 border-b text-xs' }, x)));
        const acts = el('td', { className: 'p-2 border-b flex gap-1' });
        if (c.status === 'planned') acts.appendChild(btnGhost('启动', async () => { await PUT('/api/campaigns/' + c.id, { status: 'active' }); msg('已启动'); go('marketing'); }));
        if (c.status === 'active') acts.appendChild(btnGhost('完成', async () => { await PUT('/api/campaigns/' + c.id, { status: 'completed' }); msg('已完成'); go('marketing'); }));
        acts.appendChild(btnDanger('删除', async () => { await DEL('/api/campaigns/' + c.id); msg('已删除'); go('marketing'); }));
        tr.appendChild(acts); tbl.appendChild(tr);
      });
      return tbl;
    })()));
  }

  // Templates
  if (S.templates.length) {
    w.appendChild(card('营销模板库 (' + S.templates.length + ')', (() => {
      const g = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3' });
      S.templates.forEach(t => {
        const c = el('div', { className: 'bg-gray-50 rounded-lg p-4 border border-gray-200' });
        c.appendChild(el('div', { className: 'flex justify-between items-start mb-2' }, [
          el('div', {}, [el('b', { className: 'text-sm' }, t.name), el('span', { className: 'ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded' }, t.category)]),
          el('div', { className: 'text-xs text-gray-500' }, 'ROI: ' + (t.expected_roi || '?') + 'x')
        ]));
        c.appendChild(el('p', { className: 'text-xs text-gray-600 mb-2' }, t.description || ''));
        c.appendChild(btnGhost('使用此模板', () => { if ($('c_title')) $('c_title').value = t.name; if ($('c_desc')) $('c_desc').value = t.description || ''; msg('已填充模板: ' + t.name); }));
        g.appendChild(c);
      });
      return g;
    })()));
  }
  return w;
}

// ═══════════════════════════════════════════════════════
// EVALUATION (Agent评估)
// ═══════════════════════════════════════════════════════
function viewEval() {
  const w = el('div');
  w.appendChild(el('div', { className: 'flex justify-between items-center mb-4' }, [
    el('h2', { className: 'text-lg font-bold text-gray-900' }, 'Agent 健康评估'),
    btn('🔄 刷新评估', () => go('evaluation'))
  ]));
  const s = S.evalReport.summary || {};
  const row = el('div', { className: 'grid grid-cols-2 md:grid-cols-4 gap-4 mb-6' });
  row.appendChild(stat(s.avgHealthScore || '-', '平均健康分', s.avgHealthScore >= 70 ? 'text-green-600' : 'text-orange-600'));
  row.appendChild(stat(s.totalAgents || '-', 'Agent总数'));
  row.appendChild(stat(s.totalSuggestions || 0, '优化建议', s.totalSuggestions > 0 ? 'text-orange-600' : 'text-green-600'));
  row.appendChild(stat(s.evaluatedAt ? fmtDate(s.evaluatedAt) : 'N/A', '评估时间'));
  w.appendChild(row);
  const agents = S.evalReport.agents || {};
  Object.entries(agents).forEach(([id, r]) => {
    const c = el('div', { className: 'bg-white rounded-xl shadow-sm border p-4 mb-3 ' + (r.healthScore >= 70 ? 'border-green-200' : r.healthScore >= 40 ? 'border-yellow-200' : 'border-red-200') });
    const hd = el('div', { className: 'flex justify-between items-center mb-2' });
    hd.appendChild(el('div', { className: 'flex items-center gap-2' }, [el('span', { className: 'font-semibold' }, AN[id] || id), el('code', { className: 'text-xs bg-gray-100 px-2 py-0.5 rounded' }, id)]));
    const hc = r.healthScore >= 70 ? 'text-green-600' : r.healthScore >= 40 ? 'text-yellow-600' : 'text-red-600';
    hd.appendChild(el('span', { className: 'text-xl font-bold ' + hc }, r.healthScore + '/100'));
    c.appendChild(hd);
    const meta = el('div', { className: 'grid grid-cols-4 gap-2 text-xs text-gray-500' });
    meta.appendChild(el('div', {}, '成功率: ' + (r.successRate || 0) + '%'));
    meta.appendChild(el('div', {}, '消息数: ' + (r.stats?.messages || 0)));
    meta.appendChild(el('div', {}, '记忆: ' + (r.recentMemories || 0) + '条'));
    meta.appendChild(el('div', {}, '延迟: ' + (r.stats?.avgLatencySeconds || 0) + 's'));
    c.appendChild(meta);
    if (r.suggestions?.length) { const sg = el('div', { className: 'mt-2 text-xs space-y-1' }); r.suggestions.forEach(s => { sg.appendChild(el('div', { className: 'text-orange-600 bg-orange-50 px-2 py-1 rounded' }, '⚠ [' + s.type + '] ' + s.reason)); }); c.appendChild(sg); }
    w.appendChild(c);
  });
  return w;
}

// ═══════════════════════════════════════════════════════
// SYSTEM CONFIG
// ═══════════════════════════════════════════════════════
function viewCfgs() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '系统配置'));
  if (!S.cfgs.length) { w.appendChild(el('p', { className: 'text-gray-500' }, '暂无配置项')); return w; }
  S.cfgs.forEach(c => {
    const d = el('div', { className: 'bg-white rounded-xl shadow-sm border p-4 mb-3' });
    d.appendChild(el('div', { className: 'flex justify-between items-center' }, [
      el('code', { className: 'font-mono text-sm font-medium text-indigo-700' }, c.config_key),
      el('span', { className: 'text-xs text-gray-400' }, 'v' + (c.version || 1))
    ]));
    if (c.description) d.appendChild(el('div', { className: 'text-xs text-gray-500 mt-1' }, c.description));
    w.appendChild(d);
  });
  return w;
}

// ═══════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════
function viewAudit() {
  const w = el('div');
  w.appendChild(el('h2', { className: 'text-lg font-bold text-gray-900 mb-4' }, '操作审计日志'));
  if (!S.auditItems.length) { w.appendChild(el('p', { className: 'text-gray-500' }, '暂无审计记录')); return w; }
  const tbl = el('table', { className: 'w-full text-sm bg-white rounded-xl shadow-sm border' });
  const th = el('tr'); ['时间', '配置项', '操作', '操作人'].forEach(x => th.appendChild(el('th', { className: 'text-left p-3 border-b-2 text-gray-600 text-xs font-medium' }, x)));
  tbl.appendChild(th);
  S.auditItems.forEach(a => {
    const tr = el('tr', { className: 'hover:bg-gray-50' });
    [fmtDate(a.changed_at), a.config_key || '', a.action || 'update', a.changed_by || 'system'].forEach(x => tr.appendChild(el('td', { className: 'p-3 border-b text-xs' }, x)));
    tbl.appendChild(tr);
  });
  w.appendChild(tbl);
  return w;
}

// ═══════════════════════════════════════════════════════
// DATA LOADER
// ═══════════════════════════════════════════════════════
async function load(t) {
  try {
    if (t === 'dashboard') { [S.hl, S.st, S.fs] = await Promise.all([G('/health').catch(() => ({})), G('/api/system-stats').catch(() => ({ tasks: [], messages24h: 0, anomaliesToday: 0 })), G('/api/feishu/status').catch(() => ({}))]); }
    if (t === 'agents') { S.agents = (await G('/api/agent-config').catch(() => ({ agents: {} }))).agents || {}; }
    if (t === 'scheduled') {
      const [di, ri, rhy] = await Promise.all([G('/api/config/daily_inspections').catch(() => null), G('/api/config/random_inspections').catch(() => null), G('/api/config/rhythm_schedule').catch(() => null)]);
      S.schedCfg = { dailyInspections: di?.config_value, randomInspections: ri?.config_value, ...(rhy?.config_value || {}) };
    }
    if (t === 'anomaly') { const r = await G('/api/config/anomaly_thresholds').catch(() => null); S.anomalyCfg = r?.config_value || {}; }
    if (t === 'performance') { /* uses hardcoded defaults + scoring rules */ S.scores = (await G('/api/scoring-rules').catch(() => ({ rules: {} }))).rules || {}; }
    if (t === 'marketing') { [S.campaigns, S.templates] = await Promise.all([(G('/api/campaigns').catch(() => ({ campaigns: [] }))).then(r => r.campaigns || []), (G('/api/templates').catch(() => ({ templates: [] }))).then(r => r.templates || [])]); }
    if (t === 'evaluation') { S.evalReport = await G('/api/agent-evaluation').catch(() => ({})); }
    if (t === 'configs') { S.cfgs = (await G('/api/config').catch(() => ({ configs: [] }))).configs || []; }
    if (t === 'audit') { S.auditItems = (await G('/api/audit-log?limit=50').catch(() => ({ log: [] }))).log || []; }
  } catch (e) { if (e.message === 'auth') { localStorage.removeItem('aat'); renderLogin(); } }
}

// ═══════════════════════════════════════════════════════
// TABS & ROUTER
// ═══════════════════════════════════════════════════════
const TABS = [
  ['dashboard', '📊 仪表盘'], ['agents', '🤖 Agent配置'], ['scheduled', '⏰ 定时任务'],
  ['anomaly', '🚨 异常阈值'], ['performance', '📋 绩效考核'], ['marketing', '📢 营销管理'],
  ['evaluation', '🔍 Agent评估'], ['configs', '⚙️ 系统配置'], ['audit', '📝 审计日志']
];
const VW = { dashboard: viewDash, agents: viewAgents, scheduled: viewScheduled, anomaly: viewAnomaly, performance: viewPerformance, marketing: viewMarketing, evaluation: viewEval, configs: viewCfgs, audit: viewAudit };

function render() {
  const a = $('app');
  if (!localStorage.getItem('aat')) { renderLogin(); return; }
  a.innerHTML = '';

  // Header
  const hd = el('header', { className: 'bg-white shadow-sm border-b border-gray-200' });
  const hi = el('div', { className: 'max-w-7xl mx-auto px-6 py-4 flex justify-between items-center' });
  hi.appendChild(el('div', { className: 'flex items-center gap-3' }, [
    el('span', { className: 'text-2xl' }, '🤖'),
    el('div', {}, [el('h1', { className: 'font-bold text-lg text-gray-900 leading-tight' }, 'Agent Ops Admin'), el('p', { className: 'text-xs text-gray-500' }, 'Agents Service V2 管理面板')])
  ]));
  hi.appendChild(btn('退出登录', () => { localStorage.removeItem('aat'); renderLogin(); }, 'text-sm text-gray-500 hover:text-red-500 bg-transparent'));
  hd.appendChild(hi); a.appendChild(hd);

  // Nav tabs
  const nv = el('nav', { className: 'bg-white border-b border-gray-100' });
  const nvInner = el('div', { className: 'max-w-7xl mx-auto px-6 flex gap-1 overflow-x-auto' });
  TABS.forEach(([k, l]) => {
    const cls = 'px-4 py-3 text-sm cursor-pointer whitespace-nowrap transition-colors font-medium ' + (tab === k ? 'border-b-2 border-indigo-500 text-indigo-600' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-t');
    nvInner.appendChild(el('div', { className: cls, onclick: () => go(k) }, l));
  });
  nv.appendChild(nvInner); a.appendChild(nv);

  // Content
  const ct = el('div', { className: 'max-w-7xl mx-auto px-6 py-6' });
  const fn = VW[tab] || viewDash;
  ct.appendChild(fn()); a.appendChild(ct);

  // Footer
  a.appendChild(el('footer', { className: 'max-w-7xl mx-auto px-6 py-4 text-xs text-gray-400 text-center border-t border-gray-100 mt-8' }, '© 2026 Agent Ops Admin — ' + Object.keys(AN).length + ' Agents | Phase 7'));
}

async function go(t) { tab = t; await load(t); render(); }

// ── Init ──
if (localStorage.getItem('aat')) go('dashboard'); else renderLogin();
