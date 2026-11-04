// dsh-ima · 配置校验与规范化
//
// 设计约束（刻意的）：本文件不 import 任何 `@deepseek-ai/*` 包。
// 宿主 Cordis 在插件**没有** `Config` 时会把 profile patch 里的 `config:` 原样传进来，
// 非法值被静默忽略——那是最难查的失效形态。这里用宿主认的 `~standard`
// （standard-schema v1）协议声明校验：非法配置在**加载期**响亮失败，不静默回落默认值。
//
// 为什么不用 `@deepseek-ai/schemastery`：静态 import 会让「裸仓库 / 最小宿主」下的入口
// import 失败 → 工具全都不注册；动态 import 在 pnpm 严格依赖下也不保证可解析。
// 纯对象 + `~standard` 已被本机 profile 里的 lunheng-article-pipeline 实测验证。

/** 配置默认值（也是 `cordis.patch.yml` 省略字段时的取值）。 */
export const DEFAULTS = Object.freeze({
  backend: 'auto',
  app: Object.freeze({
    executable: '',
    launchTimeoutMs: 20000,
    // 桌面「投递问题」默认关闭：靠窗口矩形比例猜输入框位置 + 模拟击键，
    // 不同布局下可能点不中，可靠性不足以默认开启。要数据请用 HTTP 后端。
    allowDelivery: false,
    // 仅用于体检：该版本实测忽略 --remote-debugging-port，这里只报告端口是否恰好可达
    // （未来版本或用户自建调试版可能开），不作为任何主路径的前提。
    debugPort: 9333,
  }),
  http: Object.freeze({
    baseUrl: '',
    token: '',
    authHeader: 'Authorization',
    authScheme: 'Bearer ',
    paths: Object.freeze({
      ask: '/v1/ask',
      search: '/v1/search',
      kbList: '/v1/knowledge_bases',
      import: '/v1/documents',
    }),
    mapping: Object.freeze({
      answer: 'answer',
      citations: 'citations',
      hits: 'hits',
      hitTitle: 'title',
      hitSnippet: 'snippet',
      hitUrl: 'url',
      hitScore: 'score',
    }),
    timeoutMs: 60000,
  }),
  knowledgeBase: '',
  topK: 8,
  quiet: false,
});

const BACKENDS = ['auto', 'app', 'http'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function intIn(value, fallback, min, max, key, issues) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < min || n > max) {
    issues.push({ path: [key], message: `config.${key} 必须是 ${min}..${max} 之间的整数，收到 ${JSON.stringify(value)}` });
    return fallback;
  }
  return n;
}

/**
 * 校验并规范化配置。
 * @param {unknown} input - profile patch / 加载器传入的原始配置。
 * @returns {{value: object}|{issues: Array<{path: string[], message: string}>}}
 */
export function validateConfig(input) {
  const issues = [];
  if (input !== undefined && input !== null && !isPlainObject(input)) {
    return { issues: [{ path: [], message: `config 必须是对象，收到 ${Array.isArray(input) ? 'array' : typeof input}` }] };
  }
  const raw = isPlainObject(input) ? input : {};
  const rawApp = isPlainObject(raw.app) ? raw.app : {};
  const rawHttp = isPlainObject(raw.http) ? raw.http : {};
  const rawPaths = isPlainObject(rawHttp.paths) ? rawHttp.paths : {};
  const rawMap = isPlainObject(rawHttp.mapping) ? rawHttp.mapping : {};

  const backend = str(raw.backend, DEFAULTS.backend).trim().toLowerCase();
  if (!BACKENDS.includes(backend)) {
    issues.push({ path: ['backend'], message: `config.backend 必须是 ${BACKENDS.join(' | ')}，收到 ${JSON.stringify(raw.backend)}` });
  }

  const app = {
    executable: str(rawApp.executable, DEFAULTS.app.executable).trim(),
    launchTimeoutMs: intIn(rawApp.launchTimeoutMs, DEFAULTS.app.launchTimeoutMs, 1000, 180000, 'app.launchTimeoutMs', issues),
    allowDelivery: rawApp.allowDelivery === undefined ? DEFAULTS.app.allowDelivery : rawApp.allowDelivery === true,
    debugPort: intIn(rawApp.debugPort, DEFAULTS.app.debugPort, 1024, 65535, 'app.debugPort', issues),
  };

  const baseUrl = str(rawHttp.baseUrl, DEFAULTS.http.baseUrl).trim().replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    issues.push({ path: ['http', 'baseUrl'], message: `config.http.baseUrl 必须以 http:// 或 https:// 开头，收到 ${JSON.stringify(rawHttp.baseUrl)}` });
  }

  const paths = {};
  for (const key of Object.keys(DEFAULTS.http.paths)) {
    const value = str(rawPaths[key], DEFAULTS.http.paths[key]).trim();
    if (value && !value.startsWith('/')) {
      issues.push({ path: ['http', 'paths', key], message: `config.http.paths.${key} 必须以 / 开头，收到 ${JSON.stringify(rawPaths[key])}` });
    }
    paths[key] = value;
  }

  const mapping = {};
  for (const key of Object.keys(DEFAULTS.http.mapping)) {
    mapping[key] = str(rawMap[key], DEFAULTS.http.mapping[key]).trim();
  }

  const http = {
    baseUrl,
    token: str(rawHttp.token, DEFAULTS.http.token).trim(),
    authHeader: str(rawHttp.authHeader, DEFAULTS.http.authHeader).trim() || DEFAULTS.http.authHeader,
    authScheme: str(rawHttp.authScheme, DEFAULTS.http.authScheme),
    paths,
    mapping,
    timeoutMs: intIn(rawHttp.timeoutMs, DEFAULTS.http.timeoutMs, 1000, 600000, 'http.timeoutMs', issues),
  };

  const value = {
    backend,
    app,
    http,
    knowledgeBase: str(raw.knowledgeBase, DEFAULTS.knowledgeBase).trim(),
    topK: intIn(raw.topK, DEFAULTS.topK, 1, 50, 'topK', issues),
    quiet: raw.quiet === undefined ? DEFAULTS.quiet : raw.quiet === true,
  };

  return issues.length ? { issues } : { value };
}

/** 与 `Config['~standard'].validate` 同源；非法即抛（供直接调用 apply 的路径兜底）。 */
export function resolveConfig(input) {
  const result = validateConfig(input);
  if (result.issues) {
    throw new TypeError('dsh-ima 配置非法：\n' + result.issues.map((i) => `  - ${i.message}`).join('\n'));
  }
  return result.value;
}

/** 宿主用的 standard-schema v1 校验器声明。 */
export const Config = Object.freeze({
  '~standard': Object.freeze({ version: 1, vendor: 'dsh-ima', validate: validateConfig }),
});

/**
 * 按 `a.b[0].c` 形式取值（HTTP 响应映射用）。取不到返回 undefined。
 * @param {unknown} value - 被取值的对象。
 * @param {string} path - 点号路径，支持 `[n]` 下标。
 * @returns {unknown} 命中的值。
 */
export function getByPath(value, path) {
  if (!path) return undefined;
  const tokens = [];
  for (const part of String(path).split('.')) {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(part)) !== null) tokens.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  let current = value;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    current = current[token];
  }
  return current;
}

/** 把 token 打码后再进日志 / 诊断输出（绝不在工具结果里回显完整密钥）。 */
export function maskSecret(secret) {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

/** 解析实际使用的后端：`auto` 时 baseUrl 已配置即走 HTTP，否则走本机客户端。 */
export function resolveBackend(config) {
  if (config.backend === 'auto') return config.http.baseUrl ? 'http' : 'app';
  return config.backend;
}
