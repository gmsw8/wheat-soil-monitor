'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { createServer } = require('node:http');
const { createReadStream } = require('node:fs');
const { isIPv4 } = require('node:net');
const { join } = require('node:path');
const { parseArgs } = require('node:util');
const { snapshotFrom, summarize } = require('./analysis.js');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { host: { type: 'string', default: '127.0.0.1' } },
});
const onRender = process.env.RENDER === 'true';
const host = onRender ? '0.0.0.0' : values.host;
const port = Number(onRender ? (process.env.PORT ?? 10000) : (positionals[0] ?? 4175));
if ((!onRender && (!isIPv4(host) || host === '0.0.0.0')) || positionals.length > 1 || !Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('无效的端口或监听地址。');
  process.exit(1);
}
const localHosts = host === '127.0.0.1' ? [host, 'localhost'] : [host];
let renderUrl;
if (onRender) {
  try {
    renderUrl = new URL(process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || ''}`);
    if (renderUrl.protocol !== 'https:') throw new Error('HTTPS required');
  } catch {
    console.error('Render 未提供有效的 HTTPS 地址。');
    process.exit(1);
  }
}
const sitePassword = onRender ? process.env.SOIL_SITE_PASSWORD : undefined;
const digest = (text) => createHash('sha256').update(text).digest();
const siteLogin = sitePassword ? digest(`demo:${sitePassword}`) : null;

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/experiment.js', ['experiment.js', 'text/javascript; charset=utf-8']],
  ['/analysis.js', ['analysis.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

const modelName = process.env.SOIL_AI_MODEL?.trim();
const modelKey = process.env.SOIL_AI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
const baseUrl = (process.env.SOIL_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const modelConfigured = Boolean(modelName && modelKey);
const maxBody = 64 * 1024;
const modelInstructions = `你是小麦土柱课程实验的解读助手。实验为采煤沉陷区湖泥、煤矸石、原状土三个基质处理，原状土暂作为比较基线。收到的都是模拟数据。用简体中文写三段短文：当前状况、支持证据、接下来应核查什么。优先使用后台计算的组均值、近期变化和按实验方案触发的提醒，并在引用读数时标明柱号或组别、深度和单位。current 包含含水率（%）、温度（°C）、孔隙气体 CO₂（ppm）与电导率（dS/m），两值数组按 10 cm 和 25 cm 排列，CO₂ 只有 10 cm。change1h 为与一小时前的差，含水率变化以百分点计。采集暂停时按最后一次快照解读。不要从快照推算 SOC、CO₂ 排放通量、污染情况或因果关系。对浇水的建议以已设置的实验方案为依据。单柱范围只分析该柱。回复为纯文本，不超过 350 个汉字。`;

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) {
      request.resume();
      throw new RangeError('快照超过大小限制');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function interpret(snapshot, report) {
  const endpoint = new URL(`${baseUrl}/chat/completions`);
  const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && isLocal)) {
    throw new Error('模型地址需要 HTTPS 或本机回环地址');
  }
  const request = {
    model: modelName,
    messages: [
      { role: 'system', content: modelInstructions },
      { role: 'user', content: JSON.stringify({ snapshot, computed: report }) },
    ],
    ...(endpoint.hostname === 'api.openai.com' ? { max_completion_tokens: 2000, store: false } : { max_tokens: 2000 }),
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${modelKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`模型接口 HTTP ${response.status}`);
  const result = await response.json();
  const text = result.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型未返回文本');
  return text.trim().slice(0, 4000);
}

async function analyze(request, response) {
  const expectedOrigin = renderUrl?.origin || `http://${request.headers.host}`;
  if (request.headers.origin && request.headers.origin !== expectedOrigin) {
    json(response, 403, { error: '请从预览网页发起分析' });
    return;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    json(response, 415, { error: '请求需要 JSON 格式' });
    return;
  }
  let snapshot;
  let input;
  try {
    input = await readBody(request);
    snapshot = snapshotFrom(input);
  } catch (error) {
    json(response, error instanceof RangeError ? 413 : 400, { error: '无法读取土柱快照' });
    return;
  }
  const report = summarize(snapshot);
  if (modelConfigured && input.useModel === true) {
    try {
      report.modelText = await interpret(snapshot, report);
    } catch (error) {
      const status = /^模型接口 HTTP \d+$/.test(error.message) ? error.message : '模型请求失败或未返回结果';
      console.error(status);
      report.modelUnavailable = true;
    }
  }
  json(response, 200, report);
}

const preview = createServer((request, response) => {
  const path = request.url.split('?')[0];
  const requestHost = request.headers.host?.toLowerCase();
  const listeningPort = request.socket.localPort;
  const allowed = renderUrl
    ? requestHost === renderUrl.host || requestHost === `${renderUrl.hostname}:443`
    : localHosts.some((name) => requestHost === `${name}:${listeningPort}` || (listeningPort === 80 && requestHost === name));
  if (!allowed) {
    json(response, 403, { error: '请通过服务启动时显示的地址访问' });
    return;
  }
  if (siteLogin) {
    const basic = /^Basic\s+(\S+)$/i.exec(request.headers.authorization || '');
    const credentials = basic && Buffer.from(basic[1], 'base64');
    if (!credentials || !timingSafeEqual(digest(credentials), siteLogin)) {
      response.setHeader('WWW-Authenticate', 'Basic realm="Wheat Soil Monitor", charset="UTF-8"');
      json(response, 401, { error: '请输入网站访问账号和密码' });
      return;
    }
  }
  if (path === '/api/analysis/status' && request.method === 'GET') {
    json(response, 200, { configured: modelConfigured });
    return;
  }
  if (path === '/api/analysis' && request.method === 'POST') {
    analyze(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: '分析服务发生错误' });
      else response.end();
    });
    return;
  }
  const entry = files.get(path);
  if (!entry) {
    response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const [filename, type] = entry;
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  if (request.method === 'HEAD') response.end();
  else createReadStream(join(__dirname, filename)).pipe(response);
});

preview.listen(port, host, () => {
  console.log(`Preview: ${renderUrl?.origin || `http://${host}:${preview.address().port}`}/`);
});
preview.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
