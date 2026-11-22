'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const STEP = 5 * 60 * 1000;
const HOUR = 12 * STEP;
const DEMO_RULE = { type: 'threshold', depth: 0, threshold: 18, time: '09:00', amount: 150 };
const GROUPS = SOIL_GROUPS.map((group) => ({ ...group, rule: { ...DEMO_RULE } }));
const COLUMNS = GROUPS.flatMap((group, g) => Array.from({ length: 5 }, (_, i) => ({
  id: `${group.id}-0${i + 1}`, group, index: g * 5 + i, offset: [0, 1, -0.5, 1.9, 0.4][i],
})));
const METRICS = {
  moisture: { name: '含水率', title: '体积含水率', unit: '%', digits: 1, icon: 'H₂O', color: '#397358', shade: '#e4efe5', series: 2 },
  temp: { name: '温度', title: '土壤温度', unit: '°C', digits: 1, icon: '°C', color: '#90662d', shade: '#f5ead7', series: 2 },
  co2: { name: 'CO₂', title: '孔隙气体 CO₂', unit: 'ppm', digits: 0, icon: 'CO₂', color: '#4f726c', shade: '#e6efed', series: 1 },
  ec: { name: '电导率', title: '土壤电导率', unit: 'dS/m', digits: 2, icon: 'EC', color: '#656e9b', shade: '#e9ebf4', series: 2 },
};
const axisTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fullTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayTime = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const sameDay = (a, b) => dayTime.format(a) === dayTime.format(b);
const toNumber = (value, digits = 1) => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const signed = (value, digits = 1) => `${value > 0 ? '+' : ''}${toNumber(value, digits)}`;
const groupLabel = (group) => group.control ? `${group.name}（对照）` : group.name;
const selection = () => COLUMNS.find(({ id }) => id === selected);
const labStore = () => state.lab[selected];
const watering = (columnId) => state.events.filter((event) => event.columnId === columnId);

function createDemo() {
  const time = Math.floor(Date.now() / STEP) * STEP;
  const lab = Object.fromEntries(COLUMNS.map(({ id, offset }) => [id, {
    soc: [[12.7 + offset, 2.3, 13.1 + offset, 2.3], [10.3 + offset, 5.6, 10.4 + offset, 5.6]],
    ph: [[7.2, 6.9], [7.3, 7.1]],
    doc: [{ concentration: 20, volume: 0.5 }, { concentration: 14, volume: 0.35 }],
  }]));
  const events = COLUMNS.map(({ id, group }, i) => ({
    columnId: id, time: time - (19 + i % 3) * STEP, amount: group.rule.amount, note: '模拟浇水',
  }));
  return { time, events, lab, rules: Object.fromEntries(GROUPS.map((g) => [g.id, { ...g.rule }])) };
}

// Old water-treatment demo data stays under v1 and is not assigned to the new substrates.
const STORAGE_KEY = 'wheat-soil-monitor-substrates-v2';
let storageAvailable = true;
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Number.isFinite(saved.time) && saved.events && saved.lab && saved.rules) return saved;
  } catch {
    storageAvailable = false;
  }
  return createDemo();
}
const state = load();
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { storageAvailable = false; }
  if (!storageAvailable) $('footer span:last-child').textContent = '浏览器存储不可用，记录仅保留在当前页面';
}
let selected = 'B-01';
let activePage = 'monitor';
let currentMetric = 'moisture';
let running = true;
let blinkTimer;
let activePoint = null;
let chartGeometry;

function reading(column, time) {
  const minutes = (time / 60000) % 1440;
  const phase = minutes / 29 + column.index * 1.27;
  let wetting = 0;
  let deepWetting = 0;
  let pulse = 0;
  for (const event of watering(column.id)) {
    const age = (time - event.time) / 60000;
    if (age <= 0 || age > 360) continue;
    const strength = Math.min(event.amount / 150, 2);
    wetting += strength * 4.4 * (1 - Math.exp(-age / 5)) * Math.exp(-age / 35);
    if (age > 15) deepWetting += strength * 2.5 * (1 - Math.exp(-(age - 15) / 11)) * Math.exp(-(age - 15) / 48);
    pulse += strength * 510 * (1 - Math.exp(-age / 11)) * Math.exp(-age / 42);
  }
  const base = column.group.moisture + column.offset;
  const moisture = Math.min(70, base + 0.25 * Math.sin(phase) + wetting);
  const deepMoisture = Math.min(70, base + 3.1 + 0.20 * Math.sin(phase - 0.6) + deepWetting);
  const temp = 22.1 + 1.1 * Math.sin(minutes / 229) + 0.25 * Math.sin(phase - 1);
  return {
    moisture: [moisture, deepMoisture], temp: [temp, temp - 0.75 + 0.12 * Math.sin(phase - 2)],
    co2: [Math.round(975 + 18 * column.index + 46 * Math.sin(phase) + pulse)],
    ec: [0.29 + moisture / 138 + 0.012 * Math.sin(phase), 0.30 + deepMoisture / 129],
  };
}

function waterStatus(column) {
  const rule = state.rules[column.group.id];
  if (rule.type === 'scheduled') {
    const done = watering(column.id).some((e) => sameDay(e.time, state.time) && axisTime.format(e.time) >= rule.time);
    if (axisTime.format(state.time) >= rule.time && !done) {
      return { due: true, title: '已到计划浇水时间', detail: `按此处理组方案计划浇水 ${rule.amount} mL。` };
    }
    return { due: false, title: done ? '今日计划已记录' : '等待计划时间', detail: `每日 ${rule.time}（UTC+8），计划 ${rule.amount} mL。` };
  }
  const values = [2, 1, 0].map((i) => reading(column, state.time - i * STEP).moisture[rule.depth]);
  const trend = values.slice().reverse().findIndex((value) => value >= rule.threshold);
  const count = trend === -1 ? 3 : trend;
  if (!running) return { due: false, title: '模拟采集已暂停', detail: '恢复采集后继续判断含水率。', paused: true, count };
  const latestEvent = watering(column.id).at(-1);
  if (latestEvent && latestEvent.time === state.time) {
    return { due: false, title: '已记录浇水', detail: '等待下一条含水率读数。', count };
  }
  return count === 3
    ? { due: true, title: '建议按方案补水', detail: `含水率 ${toNumber(values.at(-1))}% · 连续 3 次低于 ${toNumber(rule.threshold)}%。`, count }
    : { due: false, title: count > 0 ? '继续观察含水率' : '含水率正常', detail: `含水率 ${toNumber(values.at(-1))}% · 下限 ${toNumber(rule.threshold)}%。`, count };
}

function initControls() {
  $('#column-select').innerHTML = GROUPS.map((group) => `<optgroup label="${groupLabel(group)}">${COLUMNS.filter((column) => column.group === group).map((column) => `<option value="${column.id}">${column.id} · ${groupLabel(group)}</option>`).join('')}</optgroup>`).join('');
  $('#overview-groups').innerHTML = GROUPS.map((group) => `<section class="group"><h3>${groupLabel(group)}</h3><div class="column-grid">${COLUMNS.filter((column) => column.group === group).map((column) => `<button class="column-chip" type="button" data-column="${column.id}">${column.id}<span></span></button>`).join('')}</div></section>`).join('');
  $('#chart-controls').innerHTML = Object.entries(METRICS).map(([key, cfg]) => `<button type="button" data-metric="${key}">${cfg.name}</button>`).join('');
}

function renderMonitor() {
  const current = reading(selection(), state.time);
  let dueCount = 0;
  for (const button of $$('.column-chip')) {
    const column = COLUMNS.find((candidate) => candidate.id === button.dataset.column);
    const status = waterStatus(column);
    if (status.due) dueCount++;
    const value = `${toNumber(reading(column, state.time).moisture[0])}%`;
    button.firstElementChild.textContent = value;
    button.classList.toggle('attention', status.due);
    button.setAttribute('aria-pressed', column.id === selected);
    button.setAttribute('aria-label', `${column.id}，10 厘米含水率 ${value}，${status.title}`);
  }
  $('#overview-summary').textContent = dueCount ? `${dueCount} 柱待浇水 · 卡片显示 10 cm 含水率` : '卡片显示 10 cm 含水率';
  $('#metrics').innerHTML = Object.entries(METRICS).map(([key, cfg]) => `<div class="card metric" style="--metric-fg:${cfg.color};--metric-bg:${cfg.shade}">
    <div class="metric-label"><span class="metric-symbol" aria-hidden="true">${cfg.icon}</span>${cfg.title}</div>
    <p class="metric-value">${toNumber(current[key][0], cfg.digits)}<small>${cfg.unit}</small></p>
    <p class="metric-detail">10 cm${cfg.series === 2 ? ` · 25 cm 为 ${toNumber(current[key][1], cfg.digits)} ${cfg.unit}` : ' · 浅层探头'}</p></div>`).join('');
  const status = waterStatus(selection());
  const rule = state.rules[selection().group.id];
  const html = `<div class="notice ${status.due ? 'attention' : status.paused ? 'paused' : ''}"><strong><span class="dot"></span>${status.title}</strong><p>${status.detail}</p></div>`;
  if ($('#water-status').innerHTML !== html) $('#water-status').innerHTML = html;
  const recent = watering(selected).at(-1);
  const fields = rule.type === 'threshold'
    ? [['提醒方式', '连续 3 次低于下限'], ['判断深度', rule.depth === 0 ? '10 cm' : '25 cm']]
    : [['提醒方式', '每日定时'], ['计划水量', `${rule.amount} mL`]];
  fields.push(['上次浇水', recent ? `${fullTime.format(recent.time)} · ${recent.amount} mL` : '暂无']);
  $('#rule-summary').innerHTML = fields.map(([label, value]) => `<div class="rule-item"><span>${label}</span><strong>${value}</strong></div>`).join('');
  renderChart();
}

function setupCanvas(node) {
  const { width, height } = node.getBoundingClientRect();
  if (!width || !height) return null;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  node.width = Math.round(width * ratio);
  node.height = Math.round(height * ratio);
  const ctx = node.getContext('2d');
  ctx.scale(ratio, ratio);
  return { ctx, width, height };
}

function renderChart() {
  const cfg = METRICS[currentMetric];
  const range = Number($('#time-window').value);
  const start = state.time - range * 60000;
  const count = range / 5;
  const samples = Array.from({ length: count + 1 }, (_, i) => {
    const time = start + i * STEP;
    return { time, values: reading(selection(), time)[currentMetric] };
  });
  const irrigationEvents = watering(selected).filter(({ time }) => time >= start && time <= state.time);
  const canvas = $('#trend-chart');
  canvas.setAttribute('aria-label', `${selected} ${cfg.title}最近 ${range / 60} 小时曲线，单位 ${cfg.unit}，当前值 ${toNumber(samples.at(-1).values[0], cfg.digits)}`);
  $('#trend-subtitle').textContent = `${selected} · ${cfg.title}（${cfg.unit}）`;
  for (const button of $$('#chart-controls button')) {
    button.classList.toggle('active', button.dataset.metric === currentMetric);
    button.setAttribute('aria-pressed', button.dataset.metric === currentMetric);
  }
  const colors = [cfg.color, '#9a7438'];
  $('#legend').innerHTML = `<span><i style="--line:${colors[0]}"></i>10 cm</span>${cfg.series === 2 ? `<span><i class="dashed" style="--line:${colors[1]}"></i>25 cm</span>` : ''}<span><i class="dashed" style="--line:#748377"></i>浇水时刻</span>`;
  const surface = setupCanvas(canvas);
  if (!surface) return;
  const { ctx, width, height } = surface;
  const left = 42;
  const top = 12;
  const right = width - 18;
  const bottom = height - 24;
  const values = samples.flatMap((sample) => sample.values);
  const band = Math.max((Math.max(...values) - Math.min(...values)) / 3, { moisture: 1, temp: 0.5, co2: 100, ec: 0.02 }[currentMetric]);
  const magnitude = 10 ** Math.floor(Math.log10(band));
  const step = [1, 2, 2.5, 5, 10].map((v) => v * magnitude).find((v) => v >= band * (1 - 1e-10));
  const low = Math.floor(Math.min(...values) / step) * step;
  const high = Math.ceil(Math.max(...values) / step) * step;
  const x = (i) => left + (right - left) * i / count;
  const y = (value) => bottom - (bottom - top) * (value - low) / (high - low || 1);
  ctx.font = '11px system-ui';
  ctx.lineWidth = 1;
  for (let v = low; v <= high + step / 1000; v += step) {
    const py = y(v);
    ctx.strokeStyle = '#e7e9df';
    ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
    ctx.fillStyle = '#646d60'; ctx.textAlign = 'right';
    ctx.fillText(toNumber(v, cfg.digits), left - 7, py + 4);
  }
  const divisions = width < 405 ? 3 : 6;
  for (let i = 0; i <= divisions; i++) {
    const index = Math.round(count * i / divisions);
    ctx.fillStyle = '#646d60'; ctx.textAlign = i === divisions ? 'right' : i === 0 ? 'left' : 'center';
    ctx.fillText(axisTime.format(samples[index].time), x(index), bottom + 16);
  }
  for (const event of irrigationEvents) {
    const ex = x((event.time - start) / STEP);
    ctx.strokeStyle = '#748377'; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(ex, top); ctx.lineTo(ex, bottom); ctx.stroke();
  }
  for (let j = 0; j < cfg.series; j++) {
    ctx.strokeStyle = colors[j]; ctx.lineWidth = 2.3; ctx.setLineDash(j ? [5, 4] : []);
    ctx.beginPath();
    samples.forEach(({ values: row }, i) => i ? ctx.lineTo(x(i), y(row[j])) : ctx.moveTo(x(i), y(row[j])));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  chartGeometry = { left, right, count };
  const tip = $('#chart-tip');
  tip.hidden = activePoint === null;
  if (activePoint !== null && samples[activePoint]) {
    const sample = samples[activePoint];
    const cx = x(activePoint);
    ctx.strokeStyle = '#778274'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, bottom); ctx.stroke();
    sample.values.forEach((value, i) => {
      ctx.fillStyle = colors[i]; ctx.beginPath(); ctx.arc(cx, y(value), 4, 0, Math.PI * 2); ctx.fill();
    });
    tip.textContent = `${fullTime.format(sample.time)}\n${sample.values.map((value, i) => `${i === 0 ? 10 : 25} cm · ${toNumber(value, cfg.digits)} ${cfg.unit}`).join('\n')}`;
  }
}

function drawSoil() {
  const surface = setupCanvas($('#soil-illustration'));
  if (!surface) return;
  const { ctx, width, height } = surface;
  const factor = Math.min(width / 550, height / 240, 1.18);
  ctx.translate(width / 2 - 215 * factor, (height - 238 * factor) / 2);
  ctx.scale(factor, factor);
  const ink = (color, line, commands) => {
    ctx.strokeStyle = color; ctx.lineWidth = line; ctx.beginPath(); commands(); ctx.stroke();
  };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = '#e1e7bb14'; ctx.lineWidth = 1;
  for (let radius = 55; radius <= 136; radius += 27) {
    ctx.beginPath(); ctx.arc(198, 115, radius, 0, Math.PI * 2); ctx.stroke();
  }
  const earth = ctx.createLinearGradient(124, 101, 280, 200);
  earth.addColorStop(0, '#8d7049'); earth.addColorStop(0.55, '#72573c'); earth.addColorStop(1, '#513e31');
  ctx.beginPath(); ctx.moveTo(127, 103); ctx.lineTo(127, 202); ctx.bezierCurveTo(128, 228, 269, 228, 270, 202); ctx.lineTo(270, 103); ctx.closePath();
  ctx.fillStyle = earth; ctx.fill();
  const soilShape = new Path2D();
  soilShape.moveTo(127, 103); soilShape.lineTo(127, 202); soilShape.bezierCurveTo(128, 228, 269, 228, 270, 202); soilShape.lineTo(270, 103); soilShape.closePath();
  ctx.save(); ctx.clip(soilShape);
  for (let i = 0; i < 190; i++) {
    const xx = 128 + ((i * 1787) % 1430) / 10;
    const yy = 103 + ((i * 897) % 1170) / 10;
    ctx.fillStyle = i % 3 ? '#ebd2a666' : '#30271daa';
    ctx.fillRect(xx, yy, 1 + i % 3, 1 + i % 2);
  }
  for (let i = 0; i < 10; i++) {
    ink(i % 2 ? '#dec294b3' : '#d3a875bf', 1.1, () => {
      ctx.moveTo(190 + i * 1.9, 102); ctx.bezierCurveTo(179 + i * 5, 134, 155 + i * 9, 157, 158 + i * 9, 170 + i % 6 * 6);
    });
  }
  ctx.restore();
  ctx.fillStyle = '#a08255'; ctx.beginPath(); ctx.ellipse(198.5, 103, 71.5, 15, 0, 0, Math.PI * 2); ctx.fill();
  ink('#e0ead28c', 1.2, () => { ctx.moveTo(127, 94); ctx.lineTo(127, 202); ctx.bezierCurveTo(128, 228, 269, 228, 270, 202); ctx.lineTo(270, 94); });
  ink('#e0ead285', 1.2, () => ctx.ellipse(198.5, 94, 71.5, 15, 0, 0, Math.PI * 2));
  for (const [endX, endY, hue] of [[174, 35, '#a5bf77'], [195, 20, '#c7d687'], [220, 32, '#b1c77c'], [236, 46, '#a5bf77'], [159, 51, '#8fa56c']]) {
    ink(hue, 2.1, () => { ctx.moveTo(198, 102); ctx.quadraticCurveTo(193, 70, endX, endY); });
    ctx.fillStyle = hue;
    ctx.beginPath(); ctx.moveTo(198, 97); ctx.quadraticCurveTo(endX + 7, endY + 24, endX, endY); ctx.quadraticCurveTo(endX + 19, endY + 8, 198, 97); ctx.fill();
  }
  for (const [y, label, detail] of [[133, '10 cm', '水分 · 温度 · EC · CO₂'], [180, '25 cm', '水分 · 温度 · EC']]) {
    ink('#d5e0afaf', 1, () => { ctx.moveTo(254, y); ctx.lineTo(305, y); ctx.lineTo(316, y - 7); ctx.lineTo(329, y - 7); });
    ctx.fillStyle = '#dce6af'; ctx.beginPath(); ctx.arc(254, y, 3.2, 0, 2 * Math.PI); ctx.fill();
    ctx.font = '600 15px system-ui'; ctx.fillStyle = '#edf1d8'; ctx.fillText(label, 338, y - 5);
    ctx.font = '11px "Microsoft YaHei UI", system-ui'; ctx.fillStyle = '#c6d5b9'; ctx.fillText(detail, 338, y + 12);
  }
  ctx.font = '11px "Microsoft YaHei UI", system-ui'; ctx.fillStyle = '#ccd8b8'; ctx.fillText('土柱剖面示意', 338, 53);
}

function eventStats(event) {
  if (state.time - event.time < HOUR) return null;
  if (event.stats) return event.stats;
  const column = COLUMNS.find(({ id }) => id === event.columnId);
  const before = Array.from({ length: 12 }, (_, i) => reading(column, event.time - (i + 1) * STEP));
  const after = Array.from({ length: 12 }, (_, i) => reading(column, event.time + (i + 1) * STEP));
  const mean = (rows, key) => rows.reduce((sum, row) => sum + row[key][0], 0) / rows.length;
  const values = after.map((row) => row.co2[0]);
  const max = Math.max(...values);
  return { moisture: mean(after, 'moisture') - mean(before, 'moisture'), co2: mean(after, 'co2') - mean(before, 'co2'), max, minutes: (values.indexOf(max) + 1) * 5 };
}

function renderHistory() {
  const body = $('#water-history');
  body.replaceChildren();
  const events = watering(selected).slice().reverse();
  if (!events.length) { body.insertAdjacentHTML('beforeend', '<tr><td colspan="6">当前土柱暂无记录</td></tr>'); return; }
  for (const event of events) {
    const stats = eventStats(event);
    const row = body.insertRow();
    const values = [fullTime.format(event.time), `${event.amount} mL`, stats ? `${signed(stats.moisture)} 个百分点` : '计算中', stats ? `${signed(stats.co2, 0)} ppm` : '计算中', stats ? `${toNumber(stats.max, 0)} ppm（${stats.minutes} 分钟）` : '计算中', event.note || '—'];
    for (const value of values) row.insertCell().textContent = value;
  }
}

function field(value, row, col, label, max) {
  return `<input type="number" min="0" ${max ? `max="${max}"` : ''} step="any" value="${value ?? ''}" data-row="${row}" data-col="${col}" aria-label="${label}">`;
}
function renderLab() {
  const depths = ['0–15 cm', '15–35 cm'];
  const lab = labStore();
  const socLabels = ['播前 SOC', '播前干土', '收获 SOC', '收获干土'];
  $('#soc-rows').innerHTML = lab.soc.map((row, i) => `<tr><td>${depths[i]}</td>${row.map((value, j) => `<td>${field(value, i, j, depths[i] + ' ' + socLabels[j])}</td>`).join('')}</tr>`).join('');
  $('#ph-rows').innerHTML = lab.ph.map((row, i) => `<tr><td>${depths[i]}</td>${row.map((value, j) => `<td>${field(value, i, j, depths[i] + (j === 0 ? ' 播种前 pH' : ' 收获后 pH'), 14)}</td>`).join('')}<td class="ph-delta"></td></tr>`).join('');
  renderLabResults();
  renderDoc();
}
function renderLabResults() {
  const { soc, ph } = labStore();
  const before = soc.every((r) => r[0] !== null && r[1] !== null) ? soc.reduce((s, r) => s + r[0] * r[1], 0) : null;
  const after = soc.every((r) => r[2] !== null && r[3] !== null) ? soc.reduce((s, r) => s + r[2] * r[3], 0) : null;
  const delta = before !== null && after !== null ? `${signed(after - before, 2)} g C` : '待输入';
  $('#soc-results').innerHTML = `<span>播种前 <strong>${before === null ? '待输入' : `${toNumber(before, 2)} g C`}</strong></span><span>收获后 <strong>${after === null ? '待输入' : `${toNumber(after, 2)} g C`}</strong></span><span>存量变化 <strong>${delta}</strong></span>`;
  $$('.ph-delta').forEach((node, i) => { node.textContent = ph[i].includes(null) ? '待输入' : signed(ph[i][1] - ph[i][0], 2); });
}
function renderDoc() {
  const samples = labStore().doc;
  $('#doc-rows').innerHTML = samples.map(({ concentration, volume }) => `<tr><td>${toNumber(concentration, 2)} mg C/L</td><td>${toNumber(volume, 3)} L</td><td>${toNumber(concentration * volume, 2)} mg C</td></tr>`).join('');
  const total = samples.reduce((sum, { concentration, volume }) => sum + concentration * volume, 0);
  $('#doc-total').innerHTML = `<span>累计溶解性有机碳</span><strong>${toNumber(total, 2)} mg C</strong>`;
}

function selectColumn(id) {
  selected = id;
  activePoint = null;
  render();
  if (activePage === 'carbon') renderLab();
}
function render() {
  $('#column-select').value = selected;
  $('#sample-info').textContent = `模拟时间 ${fullTime.format(state.time)}（UTC+8） · 每 5 秒采样一次，推进 5 分钟`;
  if (activePage === 'monitor') renderMonitor();
  if (activePage === 'irrigation') renderHistory();
  $('#analysis-current').textContent = `${selected} · ${groupLabel(selection().group)}`;
}
function showToast(text) {
  const toast = $('#toast');
  toast.hidden = false;
  toast.textContent = text;
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}
function syncRuleFields() {
  const scheduled = $('#rule-form').elements.type.value === 'scheduled';
  $('#threshold-fields').hidden = scheduled;
  $('#schedule-fields').hidden = !scheduled;
  $$('#threshold-fields input, #threshold-fields select').forEach((el) => { el.disabled = scheduled; });
  $$('#schedule-fields input').forEach((el) => { el.disabled = !scheduled; });
}

initControls();
$('#column-select').addEventListener('change', (e) => selectColumn(e.target.value));
$('#overview-groups').addEventListener('click', (e) => {
  const target = e.target.closest('[data-column]');
  if (target) selectColumn(target.dataset.column);
});
$$('.nav-button').forEach((button) => button.addEventListener('click', () => {
  activePage = button.dataset.page;
  $$('.page').forEach((page) => { page.hidden = page.id !== activePage; });
  $$('.nav-button').forEach((item) => {
    const on = item === button;
    item.classList.toggle('active', on);
    if (on) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  render();
  if (activePage === 'carbon') renderLab();
  if (activePage === 'analysis') checkAnalysisConnection();
}));
$('#toggle-run').addEventListener('click', () => {
  running = !running;
  $('#toggle-run').setAttribute('aria-pressed', running);
  $('#mode-label').textContent = running ? '模拟采集中' : '模拟已暂停';
  $('#mode-icon').textContent = running ? 'Ⅱ' : '▶';
  render();
});
$('#chart-controls').addEventListener('click', (event) => {
  const button = event.target.closest('[data-metric]');
  if (!button) return;
  currentMetric = button.dataset.metric;
  activePoint = null;
  renderChart();
});
$('#time-window').addEventListener('change', () => { activePoint = null; renderChart(); });
$('#trend-chart').addEventListener('pointermove', (event) => {
  if (!chartGeometry) return;
  const { left, right, count } = chartGeometry;
  const position = event.clientX - event.currentTarget.getBoundingClientRect().left;
  const next = Math.max(0, Math.min(count, Math.round(count * (position - left) / (right - left))));
  if (next !== activePoint) { activePoint = next; renderChart(); }
});
$('#trend-chart').addEventListener('pointerleave', () => { activePoint = null; renderChart(); });
$$('.log-trigger').forEach((button) => button.addEventListener('click', () => {
  $('#log-form').reset();
  $('#log-column').textContent = `${selected} · ${selection().group.name}`;
  $('#log-dialog').showModal();
}));
$$('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$('#log-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  state.events.push({ columnId: selected, time: state.time, amount: Number(fields.get('amount')), note: String(fields.get('note')).trim() });
  save();
  $('#log-dialog').close();
  render();
  showToast(`已记录 ${selected} 浇水 ${fields.get('amount')} mL`);
});
$('#edit-rule').addEventListener('click', () => {
  const group = selection().group;
  const fields = $('#rule-form').elements;
  for (const [key, value] of Object.entries(state.rules[group.id])) fields.namedItem(key).value = value;
  $('#rule-column').textContent = `${groupLabel(group)} · ${group.id} 组的 5 个土柱`;
  syncRuleFields();
  $('#rule-dialog').showModal();
});
$('#rule-form').elements.type.addEventListener('change', syncRuleFields);
$('#rule-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const f = event.currentTarget.elements;
  const rule = state.rules[selection().group.id];
  rule.type = f.type.value;
  if (rule.type === 'threshold') {
    rule.depth = Number(f.depth.value);
    rule.threshold = f.threshold.valueAsNumber;
  } else {
    rule.time = f.time.value;
    rule.amount = f.amount.valueAsNumber;
  }
  save();
  $('#rule-dialog').close();
  render();
  showToast('已保存处理组的浇水方案');
});
for (const key of ['soc', 'ph']) {
  $(`#${key}-form`).addEventListener('input', (event) => {
    const input = event.target;
    if (!input.matches('[data-row]')) return;
    labStore()[key][Number(input.dataset.row)][Number(input.dataset.col)] = Number.isFinite(input.valueAsNumber) && input.validity.valid ? input.valueAsNumber : null;
    save();
    renderLabResults();
  });
  $(`#${key}-form`).addEventListener('submit', (event) => event.preventDefault());
}
$('#doc-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  labStore().doc.push({ concentration: Number(fields.get('concentration')), volume: Number(fields.get('volume')) });
  save();
  event.currentTarget.reset();
  renderDoc();
  showToast('已添加排水样品');
});
window.addEventListener('resize', () => { drawSoil(); if (activePage === 'monitor') renderChart(); });
setInterval(() => {
  if (!running) return;
  state.time += STEP;
  for (const event of state.events) if (!event.stats && state.time - event.time >= HOUR) event.stats = eventStats(event);
  save();
  render();
}, 5000);

save();
drawSoil();
render();



let analysisReachable = false;
let analysisConfigured = false;

async function checkAnalysisConnection() {
  if (location.protocol !== 'file:') {
    try {
      const response = await fetch('/api/analysis/status', { signal: AbortSignal.timeout(3500) });
      if (!response.ok) throw new Error('状态接口不可用');
      const { configured } = await response.json();
      analysisReachable = true;
      analysisConfigured = configured === true;
    } catch {
      analysisReachable = false;
      analysisConfigured = false;
    }
  }
  $('#analysis-connection').textContent = analysisConfigured ? '模型已配置' : '本地规则演示';
  $('#analysis-hint').textContent = analysisConfigured
    ? '点击分析会把所选土柱的模拟读数、变化量及浇水量发给已配置的模型服务。'
    : '当前使用本地规则分析。配置模型后，这里也会显示模型解读。';
}

function captureAnalysis(scope) {
  const time = state.time;
  const columns = scope === 'all' ? COLUMNS : [selection()];
  return {
    time, running,
    columns: columns.map((column) => {
      const current = reading(column, time);
      const previous = reading(column, time - HOUR);
      const change1h = Object.fromEntries(Object.entries(current).map(([metric, values]) => [metric, values.map((value, depth) => value - previous[metric][depth])]));
      const settings = state.rules[column.group.id];
      const status = waterStatus(column);
      const rule = settings.type === 'threshold'
        ? { type: settings.type, depthCm: settings.depth === 0 ? 10 : 25, minVwcPct: settings.threshold, consecutiveBelow: status.count, due: status.due }
        : { type: settings.type, timeUtc8: settings.time, amountMl: settings.amount, due: status.due };
      const latest = watering(column.id).at(-1);
      const lastIrrigation = latest ? { minutesAgo: (time - latest.time) / 60000, amountMl: latest.amount } : null;
      return { id: column.id, current, change1h, rule, lastIrrigation };
    }),
  };
}

function renderAnalysis(report, snapshot) {
  const subject = snapshot.columns.length === 1 ? snapshot.columns[0].id : '全部 15 柱';
  $('#analysis-meta').textContent = `${subject} · 模拟时间 ${fullTime.format(snapshot.time)}（UTC+8）`;
  $('#analysis-headline').textContent = report.headline;
  const list = $('#analysis-findings');
  list.replaceChildren();
  for (const finding of report.findings) {
    const item = document.createElement('li');
    item.textContent = finding;
    list.append(item);
  }
  const body = $('#analysis-groups');
  body.replaceChildren();
  for (const group of report.groups) {
    const row = body.insertRow();
    const cells = [group.label, group.count, `${toNumber(group.shallow)}%`, `${toNumber(group.deep)}%`, `${toNumber(group.co2, 0)} ppm`, `${signed(group.moistureChange)} 个百分点`, `${signed(group.co2Change, 0)} ppm`];
    for (const cell of cells) row.insertCell().textContent = cell;
  }
  $('#model-text').textContent = report.modelText || '';
  $('#model-result').hidden = !report.modelText;
  $('#analysis-results').hidden = false;
}

$('#analysis-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const status = $('#analysis-state');
  const snapshot = captureAnalysis($('#analysis-scope').value);
  const localReport = SoilAnalysis.summarize(SoilAnalysis.snapshotFrom(snapshot));
  let report = localReport;
  let message = '已完成本地规则分析。';
  $('#analysis-results').hidden = true;
  status.textContent = '正在分析当前快照…';
  button.disabled = true;
  try {
    if (analysisReachable) {
      const response = await fetch('/api/analysis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...snapshot, useModel: analysisConfigured }), signal: AbortSignal.timeout(26000),
      });
      if (!response.ok) throw new Error('分析接口不可用');
      report = await response.json();
      if (report.modelText) message = '已完成规则分析与模型解读。';
      if (report.modelUnavailable) message = '本次模型调用未成功，已显示规则分析。';
    }
  } catch {
    message = '本地服务暂不可用，已在浏览器计算规则结果。';
  } finally {
    button.disabled = false;
  }
  renderAnalysis(report, snapshot);
  status.textContent = message;
});
