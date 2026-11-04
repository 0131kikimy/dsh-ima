// dsh-ima · 本地设置页
//
// 自带 HTML（不依赖宿主设置面板，也不用前端构建）：用户在这里填 API Key / 地址，
// 保存后写 $DSH_HOME/dsh-ima/settings.json，下一次工具调用即生效（无需重启）。
// 页面只监听本机，且必须带令牌（?token=…）才能读写。

/**
 * 渲染设置页。
 * @param {object} config - 当前生效配置（已规范化）。
 * @param {string} token - 访问令牌。
 * @param {{origin: string}} info - 服务信息。
 * @returns {string} 完整 HTML。
 */
export function renderSettingsPage(config, token, info) {
  const value = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const options = (list, current) => list
    .map((item) => `<option value="${value(item.v)}"${item.v === current ? ' selected' : ''}>${value(item.label)}</option>`)
    .join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>dsh-ima 设置</title>
<style>
  :root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1c1f23;--muted:#6b7280;--line:#e5e7eb;--brand:#2b6ef6;--ok:#0f9d58;--err:#d93025}
  @media (prefers-color-scheme:dark){:root{--bg:#16181d;--card:#1e2127;--fg:#e8eaed;--muted:#9aa0a6;--line:#2f333a}}
  *{box-sizing:border-box}
  body{margin:0;padding:28px 18px;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 18px 8px;margin-bottom:16px}
  .card h2{font-size:14px;margin:0 0 12px;color:var(--muted);font-weight:600;letter-spacing:.02em}
  label{display:block;margin:0 0 12px}
  .label{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;margin-bottom:5px}
  .hint{color:var(--muted);font-size:12px;font-weight:400}
  input,select{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
  input:focus,select:focus{outline:2px solid color-mix(in srgb,var(--brand) 45%,transparent);border-color:var(--brand)}
  .row{display:flex;gap:12px}.row>label{flex:1}
  .actions{display:flex;gap:10px;align-items:center;margin:4px 0 18px}
  button{padding:9px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}
  button.primary{background:var(--brand);border-color:var(--brand);color:#fff}
  button:disabled{opacity:.55;cursor:default}
  pre{margin:0;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto}
  .ok{color:var(--ok)}.err{color:var(--err)}
  code{background:var(--bg);padding:1px 5px;border-radius:4px;font-size:12px}
</style></head><body><div class="wrap">
<h1>dsh-ima 设置</h1>
<div class="sub">保存后立即生效（写入 <code>settings.json</code>，无需重启）。页面仅本机可访问，需带令牌。</div>

<div class="card"><h2>数据后端</h2>
  <div class="row">
    <label><span class="label">后端选择 <span class="hint">auto = 配好 HTTP 就用 HTTP</span></span>
      <select id="backend">${options([{ v: 'auto', label: 'auto（推荐）' }, { v: 'http', label: 'http' }, { v: 'app', label: 'app（仅桌面）' }], config.backend)}</select></label>
    <label><span class="label">接口预设</span>
      <select id="preset">${options([{ v: 'ima', label: 'ima 官方 OpenAPI' }, { v: 'generic', label: '自定义 REST' }], config.http.preset)}</select></label>
  </div>
</div>

<div class="card"><h2>ima 官方 OpenAPI</h2>
  <label><span class="label">Client ID <span class="hint">在 ima.qq.com/agent-interface 获取</span></span>
    <input id="clientId" value="${value(config.http.clientId)}" placeholder="32 位十六进制" autocomplete="off" spellcheck="false"/></label>
  <label><span class="label">API Key</span>
    <input id="apiKey" type="password" value="${value(config.http.apiKey)}" placeholder="ima 开放平台 API Key" autocomplete="off" spellcheck="false"/></label>
</div>

<div class="card"><h2>自定义 REST（预设选 generic 时生效）</h2>
  <label><span class="label">baseUrl</span>
    <input id="baseUrl" value="${value(config.http.baseUrl)}" placeholder="https://your-endpoint.example.com" autocomplete="off" spellcheck="false"/></label>
  <label><span class="label">token <span class="hint">以 Bearer 发送</span></span>
    <input id="token" type="password" value="${value(config.http.token)}" autocomplete="off" spellcheck="false"/></label>
</div>

<div class="card"><h2>默认值</h2>
  <div class="row">
    <label><span class="label">默认知识库 <span class="hint">id 或名称，可留空</span></span>
      <input id="knowledgeBase" value="${value(config.knowledgeBase)}" placeholder="ima_kb_…" autocomplete="off" spellcheck="false"/></label>
    <label><span class="label">检索条数 topK</span>
      <input id="topK" type="number" min="1" max="50" value="${value(config.topK)}"/></label>
  </div>
  <label><span class="label">ima 客户端路径 <span class="hint">留空自动探测</span></span>
    <input id="executable" value="${value(config.app.executable)}" placeholder="C:\\…\\ima.copilot.exe" autocomplete="off" spellcheck="false"/></label>
</div>

<div class="actions">
  <button class="primary" id="save">保存</button>
  <button id="test">测试连接</button>
  <span id="status" class="sub" style="margin:0"></span>
</div>

<div class="card"><h2>结果</h2><pre id="out">（点「测试连接」看两条通道的实际状态）</pre></div>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);
const statusEl = $('status'), outEl = $('out');
function collect() {
  return {
    backend: $('backend').value,
    knowledgeBase: $('knowledgeBase').value.trim(),
    topK: Number($('topK').value) || 8,
    http: {
      preset: $('preset').value,
      clientId: $('clientId').value.trim(),
      apiKey: $('apiKey').value.trim(),
      baseUrl: $('baseUrl').value.trim(),
      token: $('token').value.trim(),
    },
    app: { executable: $('executable').value.trim() },
  };
}
async function call(method, extra) {
  const res = await fetch('${info.origin}/dsh-ima/settings?token=' + TOKEN + (extra || ''), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(collect()) : undefined,
  });
  return res.json();
}
$('save').onclick = async () => {
  statusEl.textContent = '保存中…';
  const r = await call('POST');
  if (r.ok) { statusEl.className = 'sub ok'; statusEl.textContent = '已保存，立即生效'; outEl.textContent = JSON.stringify(r.effective, null, 2); }
  else { statusEl.className = 'sub err'; statusEl.textContent = '保存失败'; outEl.textContent = (r.issues || []).map(i => '- ' + i.message).join('\\n') || r.error || '未知错误'; }
};
$('test').onclick = async () => {
  statusEl.textContent = '测试中…';
  const r = await call('GET', '&test=1');
  statusEl.textContent = '';
  outEl.textContent = JSON.stringify(r, null, 2);
};
</script></body></html>`;
}
