// dsh-ima · 插件入口
//
// 注册九个原生工具：ima_health / ima_settings / ima_open / ima_search / ima_ask /
// ima_kb_list / ima_list_docs / ima_get_doc / ima_import。
//
// 设计约束（与 lunheng-article-pipeline 同款，刻意的）：
//   · 入口**不静态 import 任何 `@deepseek-ai/*` 包**——裸仓库 / 最小宿主下 import 失败
//     会让整包工具全都不注册。`defineTool` 走**动态 import + 降级**：拿不到就退回
//     `ctx.tools.register` 的裸定义（参数用标准 JSON Schema）。
//   · `tools` 服务用 `ctx.get('tools')` 取（可选依赖），不写进 inject 的硬依赖里，
//     避免某个 profile 缺该服务时入口整体抛错。
//   · 配置非法在 apply 第一句就响亮失败（`resolveConfig` 抛错），不静默回落默认值。

import { resolveConfig, resolveBackend, DEFAULTS, validateConfig } from './config.js';
import { Config } from './settings.js';
import { readSettings, writeSettings, mergeSettings, settingsFile } from './store.js';
import { registerSettingsRoute } from './settings-route.js';
import * as httpBackend from './http.js';
import * as appBackend from './app.js';

export const name = 'dsh-ima';
export { Config };

/** 设置页 URL（apply 时填充；拿不到 webServer 时为空）。 */
let settingsUrl = '';
/** 设置页挂载诊断（排障用：把 inject 的实际结果带给 ima_settings / ima_health）。 */
let settingsDiag = 'not-attempted';
/** 上一次注册的注销函数：宿主进程常驻，重载插件时必须先撤旧路由，否则会报 duplicate route。
 *  放在 globalThis 上：插件重载会重新求值本模块，模块级变量会被重置，只有全局登记能跨重载。 */
const ROUTE_REGISTRY = Symbol.for('dsh-ima.settingsRoute');
function routeRegistry() {
  if (!globalThis[ROUTE_REGISTRY]) globalThis[ROUTE_REGISTRY] = { dispose: undefined, url: '' };
  return globalThis[ROUTE_REGISTRY];
}

/** 工具用到的输出 schema 片段（宿主 value schema DSL 不支持 required，嵌套也不行）。 */
const CITATION_SCHEMA = {
  type: 'array',
  description: '引用来源',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      url: { type: 'string' },
      snippet: { type: 'string' },
      score: { type: 'number' },
      index: { type: 'number' },
    },
  },
};

const HIT_SCHEMA = {
  type: 'array',
  description: '检索命中',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      snippet: { type: 'string' },
      url: { type: 'string' },
      score: { type: 'number' },
      knowledgeBase: { type: 'string' },
      mediaId: { type: 'string', description: 'ima 文档/文件夹 id' },
      mediaType: { type: 'number', description: 'ima 媒体类型（1=文档，99=文件夹）' },
    },
  },
};

function backendOf(config) {
  return resolveBackend(config);
}

/** 桌面后端做不了「读回」时的统一指向说明。 */
function readBackHint(config) {
  return config.http.baseUrl
    ? ''
    : '。要拿到结构化结果，请把 http.baseUrl 配成你的 ima HTTP 接口（本机客户端不开放 DOM/CDP，无法读回答案）';
}

/**
 * 深剪枝：去掉 `undefined` / 函数 / 非有限数字。
 *
 * 为什么必须有：宿主对工具返回值做「无损 JSON」校验，`{ title: undefined }` 这种
 * 对象会被判成 `returned invalid output: value is not lossless JSON`——整次调用失败，
 * 而错误信息完全不指向真正的字段。宁可在这里统一剪掉，也不要让每个工具各自小心。
 * @param {unknown} value - 工具返回值。
 * @returns {unknown} 可安全序列化的同构值。
 */
function pruneValue(value) {
  if (Array.isArray(value)) return value.map(pruneValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function') continue;
      if (typeof item === 'number' && !Number.isFinite(item)) continue;
      out[key] = pruneValue(item);
    }
    return out;
  }
  return value;
}

/**
 * 安装全部工具。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} initial - 启动时的已规范化配置。
 * @param {() => object} resolveActive - 每次调用前重新解析生效配置（设置页保存后可即时生效）。
 * @returns {Promise<string[]>} 已注册的工具名。
 */
async function installTools(ctx, initial, resolveActive) {
  let config = initial;
  /** 每次工具执行前刷新配置：设置页保存的值优先于 cordis 配置。 */
  const refresh = () => {
    try {
      const next = resolveActive();
      if (next) config = next;
    } catch {
      /* 保留上一次可用的配置，避免一次坏配置让所有工具瘫掉 */
    }
  };
  const tools = ctx.get?.('tools') ?? ctx.tools;
  if (!tools?.register) {
    ctx.logger?.warn?.('dsh-ima: 当前宿主没有 tools 服务，工具未注册');
    return [];
  }

  let defineTool;
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    defineTool = mod.defineTool;
  } catch {
    defineTool = undefined;
  }

  const names = [];
  /** @type {Array<() => void>} 注册返回的注销函数（交给 ctx.effect 托管，防 HMR 残留）。 */
  const disposers = [];

  /**
   * 注册一个工具：优先宿主 `defineTool`（得到参数校验），退化为裸定义。
   * 注册成功即记入 names/disposers，供卸载时统一注销。
   * @param {object} spec - 工具规格。
   * @returns {void}
   */
  const register = (spec) => {
    // 统一包一层：先跑 execute，再剪枝成无损 JSON，最后才交给输出 schema。
    const definition = {
      ...spec,
      execute: async (args, exec) => {
        refresh();
        return pruneValue(await spec.execute(args, exec));
      },
    };
    let dispose;
    if (typeof defineTool === 'function') {
      try {
        dispose = tools.register(defineTool(definition));
      } catch (error) {
        ctx.logger?.warn?.(`dsh-ima: defineTool 注册 ${spec.name} 失败，退回裸定义：${error?.message ?? error}`);
      }
    }
    if (dispose === undefined) {
      const properties = {};
      const required = [];
      for (const [key, field] of Object.entries(spec.parameters || {})) {
        const copy = { ...field };
        if (copy.required) { required.push(key); delete copy.required; }
        properties[key] = copy;
      }
      dispose = tools.register({
        name: spec.name,
        description: spec.description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
        output: spec.output,
        execute: definition.execute,
      });
    }
    names.push(spec.name);
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  // ── 1. 体检 ───────────────────────────────────────────────────────────────
  register({
    name: 'ima_health',
    executionMode: 'parallel',
    description:
      '体检 dsh-ima 的两条通道并回报事实：当前解析到的后端、ima 桌面进程/窗口状态、HTTP 接口可达性、以及哪些操作真的能读回结果。'
      + '**排障第一步**：任何 ima_* 工具报错先跑它。只读，不改变任何状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backend: { type: 'string', description: '实际使用的后端：http / app' },
          configuredBackend: { type: 'string', description: '配置里的 backend（auto / app / http）' },
          httpBaseUrl: { type: 'string' },
          settingsUrl: { type: 'string', description: '可视化设置页地址（本机，含访问令牌）' },
          app: { type: 'object' },
          http: { type: 'object' },
          capabilities: { type: 'object' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: [
          `后端：${v.backend}（配置 backend=${v.configuredBackend}）`,
          `可视化设置：${v.settingsUrl || '（宿主没有 webServer，无法提供设置页）'}`,
          `桌面客户端：${v.app?.reachable ? `运行中，${v.app.processCount} 个进程` : `不可用${v.app?.error ? `（${v.app.error}）` : ''}`}`
            + (v.app?.title ? `｜窗口「${v.app.title}」` : '')
            + (v.app?.readBack === false ? '｜**不能读回答案**' : ''),
          `HTTP 接口：${v.http?.configured ? (v.http.reachable ? `可达（${v.http.probe}）` : `不可达（${v.http.error}）`) : '未配置 http.baseUrl'}`,
          `能力：问答/检索/知识库读写 = ${v.capabilities?.readBack ? '可用' : '需要 HTTP 后端'}；唤起 ima = ${v.capabilities?.open ? '可用' : '不可用'}`,
        ].join('\n'),
      }],
    },
    async execute() {
      const backend = backendOf(config);
      const [appHealth, httpHealth] = await Promise.all([
        appBackend.health(config),
        httpBackend.health(config),
      ]);
      return {
        backend,
        configuredBackend: config.backend,
        httpBaseUrl: config.http.baseUrl,
        settingsUrl,
        app: appHealth,
        http: httpHealth,
        capabilities: {
          open: appHealth.running === true || Boolean(appHealth.executable),
          deliver: true,
          readBack: httpHealth.reachable === true,
          settingsPage: Boolean(settingsUrl),
        },
      };
    },
  });

  // ── 2. 可视化设置入口 ─────────────────────────────────────────────────────
  register({
    name: 'ima_settings',
    executionMode: 'parallel',
    description:
      '给出可可视化填写 API Key / 接口地址的**本地设置页地址**（打开即填，保存后立即生效，无需重启）。'
      + '同时回报当前生效的配置（密钥打码）。当你需要用户提供 ima 凭据时，调用它把 URL 给用户。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: '设置页地址（带访问令牌，仅本机可开）' },
          diag: { type: 'string', description: '设置页挂载诊断（排障用）' },
          storePath: { type: 'string', description: '设置保存位置' },
          effective: {
            type: 'object',
            additionalProperties: false,
            properties: {
              backend: { type: 'string' },
              preset: { type: 'string' },
              baseUrl: { type: 'string' },
              clientId: { type: 'string' },
              hasApiKey: { type: 'boolean' },
              knowledgeBase: { type: 'string' },
              topK: { type: 'number' },
            },
          },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: [
          `可视化设置页：${v.url || '（宿主没有 webServer，无法提供设置页）'}`,
          `挂载诊断：${v.diag || '(无)'}`,
          `保存位置：${v.storePath}`,
          `当前生效：backend=${v.effective?.backend}｜preset=${v.effective?.preset}｜baseUrl=${v.effective?.baseUrl || '(空)'}`
            + `｜clientId=${v.effective?.clientId || '(空)'}｜API Key=${v.effective?.hasApiKey ? '已配置' : '未配置'}`,
          '在上述页面填好 ima 的 Client ID / API Key 并保存，然后跑一次 ima_health 验证。',
        ].join('\n'),
      }],
    },
    async execute() {
      return {
        url: settingsUrl,
        diag: settingsDiag,
        storePath: settingsFile(),
        effective: {
          backend: config.backend,
          preset: config.http.preset,
          baseUrl: config.http.baseUrl,
          clientId: config.http.clientId ? `${config.http.clientId.slice(0, 6)}…` : '',
          hasApiKey: Boolean(config.http.apiKey),
          knowledgeBase: config.knowledgeBase,
          topK: config.topK,
        },
      };
    },
  });

  // ── 3. 唤起 ima ───────────────────────────────────────────────────────────
  register({
    name: 'ima_open',
    executionMode: 'parallel',
    description:
      '唤起本机 ima 桌面客户端（没运行就拉起，运行了就聚焦窗口），可选让它打开一个 URL 或 `imacopilot://` 深链接。'
      + '用于「让人去看 ima」或把某个网页丢进 ima。不返回任何知识库内容。',
    parameters: {
      url: { type: 'string', description: '可选：要让 ima 打开的网址（会转成 imacopilot://open?url=… 深链接）；留空只唤起窗口' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          opened: { type: 'boolean' },
          url: { type: 'string' },
          visible: { type: 'boolean' },
          windowHandle: { type: 'number' },
          title: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `已唤起 ima${v.title ? `（窗口「${v.title}」）` : ''}${v.url ? `，并请求打开 ${v.url}` : ''}${v.visible === false ? '\n⚠️ 窗口仍不可见（可能驻留托盘）' : ''}`,
      }],
    },
    async execute(args) {
      return appBackend.open(config, { url: args?.url });
    },
  });

  // ── 3. 检索 ───────────────────────────────────────────────────────────────
  register({
    name: 'ima_search',
    executionMode: 'parallel',
    description:
      '在 ima 知识库里检索片段（返回 title/snippet/url/score 列表）。**走 HTTP 后端**：需要配置 http.baseUrl。'
      + '桌面客户端不开放 DOM/CDP，无法把检索结果读回来。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词或自然语言问题' },
      knowledgeBase: { type: 'string', description: '可选：限定知识库（id 或名称）；省略则用 config.knowledgeBase' },
      topK: { type: 'number', description: `可选：返回条数上限（默认 ${DEFAULTS.topK}）` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          hits: HIT_SCHEMA,
          total: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.hits.length
          ? `${v.query} → ${v.hits.length} 条命中\n` + v.hits.map((hit, index) => {
            const meta = [hit.knowledgeBase, hit.score !== undefined ? `score=${hit.score}` : '', hit.url || '']
              .filter(Boolean).join('｜');
            return `${index + 1}. ${hit.title || '(无标题)'}${meta ? `\n   ${meta}` : ''}${hit.snippet ? `\n   ${String(hit.snippet).slice(0, 300)}` : ''}`;
          }).join('\n')
          : `没有命中${v.note ? `（${v.note}）` : ''}`,
      }],
    },
    async execute(args) {
      if (!config.http.baseUrl) {
        throw new Error(`ima_search 需要 HTTP 后端：未配置 http.baseUrl${readBackHint(config)}`);
      }
      if (typeof args?.query !== 'string' || !args.query.trim()) {
        throw new Error('ima_search 需要非空 query');
      }
      return httpBackend.search(config, { query: args.query.trim(), knowledgeBase: args.knowledgeBase, topK: args.topK });
    },
  });

  // ── 4. 问答 ───────────────────────────────────────────────────────────────
  register({
    name: 'ima_ask',
    description:
      '向 ima 提问。两种形态：配了 http.baseUrl → 返回 **answer + citations**（可读回，推荐）；'
      + '否则走桌面客户端，而桌面「投递」是**默认关闭的实验能力**（app.allowDelivery:false 时会直接报错并说明原因）——'
      + '它靠窗口比例猜输入框位置 + 模拟击键，不同布局下可能点不中，问题送不进去。'
      + '需要真实问答请配 http.baseUrl；只想让人去看 ima 用 ima_open。传 dryRun:true 可安全演练坐标与归属校验。',
    parameters: {
      question: { type: 'string', required: true, description: '问题' },
      knowledgeBase: { type: 'string', description: '可选：限定知识库（id 或名称）' },
      topK: { type: 'number', description: `可选：检索条数（默认 ${DEFAULTS.topK}）` },
      dryRun: { type: 'boolean', description: '仅桌面后端：只做坐标与归属校验、不点击不输入。改了配置或换了窗口布局后建议先演练一次' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backend: { type: 'string' },
          question: { type: 'string' },
          answer: { type: 'string' },
          citations: CITATION_SCHEMA,
          knowledgeBase: { type: 'string' },
          mode: { type: 'string', description: 'http + ima preset 时为 retrieval（官方接口无问答生成，返回检索汇总）' },
          delivered: { type: 'boolean' },
          readBack: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          foregroundVerified: { type: 'boolean', description: '击键前 ima 是否确实在前台（false 时脚本会直接报错而不是盲打）' },
          pointPid: { type: 'number', description: '点击点所属进程 PID，必须属于 ima' },
          deliveredWhileImaForeground: { type: 'boolean', description: '投递完成那一刻 ima 是否仍在前台' },
          click: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            description: '桌面投递时点击的屏幕坐标（排障用）',
          },
          rect: {
            type: 'object',
            additionalProperties: false,
            properties: {
              left: { type: 'number' },
              top: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            description: '计算坐标时读到的 ima 窗口矩形（DPI 感知后的物理像素）',
          },
          note: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.backend === 'http'
          ? `${v.answer}${v.citations && v.citations.length
            ? `\n\n— 引用 ${v.citations.length} 条 —\n` + v.citations.slice(0, 8).map((c, i) => `[${i + 1}] ${c.title || c.url || ''}${c.url ? ` ${c.url}` : ''}${c.snippet ? `\n    ${String(c.snippet).slice(0, 200)}` : ''}`).join('\n')
            : ''}`
          : v.dryRun
            ? `演练通过：点击点归属 PID ${v.pointPid}（属于 ima），前台校验 ${v.foregroundVerified ? '通过' : '未通过'}，坐标 (${v.click?.x}, ${v.click?.y})，窗口 ${v.rect?.width}x${v.rect?.height}。未点击、未输入。`
            : `已把问题投递到 ima 客户端（未读回答案）。前台校验=${v.foregroundVerified ? '通过' : '未通过'}${v.deliveredWhileImaForeground === false ? '，⚠️ 投递那一刻 ima 已不在前台' : ''}`,
      }],
    },
    async execute(args) {
      if (typeof args?.question !== 'string' || !args.question.trim()) {
        throw new Error('ima_ask 需要非空 question');
      }
      const question = args.question.trim();
      const backend = backendOf(config);
      if (backend === 'http') {
        const result = await httpBackend.ask(config, { question, knowledgeBase: args.knowledgeBase, topK: args.topK });
        return { backend: 'http', question, ...result };
      }
      // 桌面投递默认关闭：先做一次安全的坐标/归属演练；未显式打开时直接拒绝，
      // 并把「怎么才能真正拿到答案」说清楚，而不是让调用方以为投递成功就等于问到了。
      const dryRun = args.dryRun === true;
      if (!config.app.allowDelivery) {
        const probe = await appBackend.deliver(config, { question, dryRun: true });
        // 演练本身是安全的：即便投递关着，也把「如果真投递会打哪儿」如实回报。
        if (dryRun) return { backend: 'app', question, ...probe };
        throw new Error(
          '桌面「投递」默认关闭（app.allowDelivery=false）：它靠窗口比例猜输入框位置，实测在真实布局下会点到正文、'
          + `问题送不进去。演练结果：点击点归属 PID ${probe.pointPid}、前台校验 ${probe.foregroundVerified ? '通过' : '未通过'}、`
          + `坐标 (${probe.click?.x}, ${probe.click?.y})、窗口 ${probe.rect?.width}x${probe.rect?.height}。`
          + '要真正问答请配置 http.baseUrl（返回答案与引用）；只想打开 ima 用 ima_open；'
          + '确认要试实验性投递，把 app.allowDelivery 设为 true。',
        );
      }
      const result = await appBackend.deliver(config, { question, dryRun });
      return { backend: 'app', question, ...result };
    },
  });
  // ── 5. 列知识库 ───────────────────────────────────────────────────────────
  register({
    name: 'ima_kb_list',
    executionMode: 'parallel',
    description: '列出 ima 里的知识库（id / 名称 / 文档数）。**仅 HTTP 后端可用**，需要配置 http.baseUrl。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          knowledgeBases: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                count: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.knowledgeBases.length
          ? v.knowledgeBases.map((kb) => `- ${kb.name || kb.id}${kb.id && kb.name ? `（${kb.id}）` : ''}${kb.count !== undefined ? `：${kb.count} 篇` : ''}`).join('\n')
          : '没有返回任何知识库',
      }],
    },
    async execute() {
      if (!config.http.baseUrl) {
        throw new Error(`ima_kb_list 需要 HTTP 后端：未配置 http.baseUrl${readBackHint(config)}`);
      }
      return httpBackend.kbList(config);
    },
  });

  // ── 6. 列知识库内文档 ─────────────────────────────────────────────────────
  register({
    name: 'ima_list_docs',
    executionMode: 'parallel',
    description:
      '列出某个 ima 知识库里的文档与文件夹（默认递归展开子文件夹，返回 mediaId / 标题 / 所在路径）。'
      + '**仅 ima 官方 OpenAPI（http.preset: ima）可用**。'
      + '需要引用原文的任务（知识卡片、备课摘要、逐字核对）必须走「先 ima_list_docs 拿 mediaId，再 ima_get_doc 取正文」，'
      + '因为 ima_search 只返回标题。',
    parameters: {
      knowledgeBase: { type: 'string', description: '知识库 id 或名称；省略则用 config.knowledgeBase（账号下只有一个库时才可省略）' },
      folderId: { type: 'string', description: '可选：从某个文件夹开始（默认知识库根目录）' },
      limit: { type: 'number', description: '最多返回多少篇文档（默认 200，上限 500）' },
      recursive: { type: 'boolean', description: '是否递归子文件夹（默认 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          knowledgeBase: { type: 'string' },
          knowledgeBaseName: { type: 'string' },
          docs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                mediaId: { type: 'string' },
                mediaType: { type: 'number' },
                parentFolderId: { type: 'string' },
                folder: { type: 'string' },
              },
            },
          },
          folders: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                mediaId: { type: 'string' },
                mediaType: { type: 'number' },
                parentFolderId: { type: 'string' },
                folder: { type: 'string' },
              },
            },
          },
          total: { type: 'number' },
          foldersScanned: { type: 'number' },
          pages: { type: 'number' },
          truncated: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `${v.knowledgeBaseName || v.knowledgeBase}：${v.total} 篇文档、${v.foldersScanned} 个文件夹（翻 ${v.pages} 页${v.truncated ? '，已截断' : ''}）`
          + '\n'
          + v.docs.slice(0, 30).map((d, i) => `${i + 1}. ${d.title}${d.folder ? `（${d.folder}）` : ''}｜mediaId=${d.mediaId}`).join('\n')
          + (v.docs.length > 30 ? `\n… 其余 ${v.docs.length - 30} 篇略` : '')
          + (v.docs[0] ? '\n\n下一步：ima_get_doc({ mediaId }) 取正文' : ''),
      }],
    },
    async execute(args) {
      return httpBackend.listDocs(config, {
        knowledgeBase: args?.knowledgeBase,
        folderId: args?.folderId,
        limit: args?.limit,
        recursive: args?.recursive !== false,
      });
    },
  });

  // ── 7. 取文档正文 ─────────────────────────────────────────────────────────
  register({
    name: 'ima_get_doc',
    executionMode: 'parallel',
    description:
      '按 mediaId 取单篇 ima 文档的正文：get_media_info 拿签名下载链接 → 下载原件 → 落临时文件 → 用 pdftotext 抽 PDF 文本'
      + '（非 PDF 只下载原件、不自作解析）。**仅 ima 官方 OpenAPI（http.preset: ima）可用**。'
      + '抽不出文本时如实回报 extractor / extractError（可能是扫描版需要 OCR），不会假装成功。',
    parameters: {
      mediaId: { type: 'string', required: true, description: '文档 id（来自 ima_list_docs 或 ima_search 的 mediaId）' },
      maxChars: { type: 'number', description: '正文字数上限（默认 20000，上限 200000）' },
      saveTo: { type: 'string', description: '可选：把原件另存到该目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mediaId: { type: 'string' },
          title: { type: 'string' },
          mediaType: { type: 'number' },
          bytes: { type: 'number' },
          savedPath: { type: 'string' },
          extractor: { type: 'string' },
          extractorPath: { type: 'string', description: '实际用到的 pdftotext 路径（排障用）' },
          extractError: { type: 'string' },
          text: { type: 'string' },
          textChars: { type: 'number' },
          textTruncated: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: [
          `${v.title || v.mediaId}｜${Math.round((v.bytes || 0) / 1024)} KB｜抽取器=${v.extractor}`
            + (v.textChars ? `｜正文 ${v.textChars} 字${v.textTruncated ? '（已截断）' : ''}` : ''),
          v.extractError ? `⚠️ ${v.extractError}` : '',
          `原件：${v.savedPath}`,
          v.text ? `\n--- 正文（前 600 字）---\n${v.text.slice(0, 600)}` : '',
        ].filter(Boolean).join('\n'),
      }],
    },
    async execute(args) {
      if (!args?.mediaId) throw new Error('ima_get_doc 需要 mediaId');
      const result = await httpBackend.getDoc(config, {
        mediaId: args.mediaId,
        maxChars: args.maxChars,
        saveTo: args.saveTo,
      });
      // 签名下载链接会过期，也没必要进对话记录：只留本地文件路径。
      const { url, ...rest } = result;
      void url;
      return rest;
    },
  });

  // ── 8. 写入知识库 ─────────────────────────────────────────────────────────
  register({
    name: 'ima_import',
    description:
      '把一个 URL 或一段纯文本写入 ima 知识库（url 与 text 二选一）。**仅 HTTP 后端可用**，需要配置 http.baseUrl。'
      + '这是**有副作用**的写操作：请先向用户确认要写入哪个知识库。',
    parameters: {
      url: { type: 'string', description: '要收藏的网址（与 text 二选一）' },
      text: { type: 'string', description: '要写入的纯文本（与 url 二选一）' },
      title: { type: 'string', description: '可选：标题' },
      knowledgeBase: { type: 'string', description: '可选：目标知识库（id 或名称）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `已提交写入 ima 知识库：status=${v.status}${v.id ? `，id=${v.id}` : ''}`,
      }],
    },
    async execute(args) {
      if (!config.http.baseUrl) {
        throw new Error(`ima_import 需要 HTTP 后端：未配置 http.baseUrl${readBackHint(config)}`);
      }
      const hasUrl = typeof args?.url === 'string' && args.url.trim();
      const hasText = typeof args?.text === 'string' && args.text.trim();
      if (hasUrl === hasText) throw new Error('ima_import 需要 url 与 text 二选一（不能同时给，也不能都不给）');
      return httpBackend.importItem(config, {
        url: hasUrl ? args.url.trim() : undefined,
        text: hasText ? args.text : undefined,
        title: args.title,
        knowledgeBase: args.knowledgeBase,
      });
    },
  });

  // 注销：`tools.register` 的注册作用域绑定在宿主为本次 apply 建立的 fiber 上，
  // 宿主卸载插件时其 scoped 注册会随之撤销，因此这里不再额外声明 ctx.effect
  //（该版 Cordis 对 effect 回调形态校验很严，实测 `ctx.effect(() => () => {})`
  //  会抛 TypeError: Invalid effect，连带整个插件激活失败——不值得为一个
  //  宿主已保证的生命周期动作冒这个险）。disposers 保留用于诊断。
  void disposers;

  return names;
}

export async function apply(ctx, config) {
  const baseConfig = resolveConfig(config);

  /** 每次调用重新算生效配置：设置页保存的值优先于 cordis 配置。 */
  const resolveActive = () => {
    const saved = readSettings().data;
    return resolveConfig(mergeSettings(baseConfig, saved));
  };
  let active = baseConfig;
  try {
    active = resolveActive();
  } catch (error) {
    ctx.logger?.warn?.(`dsh-ima: 设置文件里的配置非法，回退到 cordis 配置：${error?.message ?? error}`);
  }

  // 可视化设置页：挂在宿主 webServer 上。webServer 可能比本插件晚就绪，
  // 所以用 `ctx.inject(['webServer'], …)` 等它——直接 `ctx.get` 在挂载瞬间常常拿不到。
  const mountSettings = (webServer, via) => {
    if (!webServer?.register || typeof webServer.getOrigin !== 'function') {
      settingsDiag = `${via}: no webServer service`;
      return;
    }
    try {
      try { routeRegistry().dispose?.(); } catch { /* 旧路由可能已随宿主撤销 */ }
      const route = registerSettingsRoute({
        webServer,
        getConfig: () => {
          try { return resolveActive(); } catch { return active; }
        },
        applySettings: (posted, options = {}) => {
          const saved = readSettings().data;
          const next = {
            ...saved,
            ...posted,
            http: { ...(saved.http || {}), ...(posted.http || {}) },
            app: { ...(saved.app || {}), ...(posted.app || {}) },
          };
          const result = validateConfig(mergeSettings(baseConfig, next));
          if (options.dryRun) return result.issues ? { issues: result.issues } : { ok: true };
          if (result.issues) return { issues: result.issues };
          writeSettings(next);
          const refreshed = resolveActive();
          return {
            backend: refreshed.backend,
            preset: refreshed.http.preset,
            baseUrl: refreshed.http.baseUrl,
            clientId: refreshed.http.clientId,
            knowledgeBase: refreshed.knowledgeBase,
            topK: refreshed.topK,
          };
        },
        testConnection: async () => {
          let cfg = active;
          try { cfg = resolveActive(); } catch { /* 用上一份可用配置 */ }
          const [app, http] = await Promise.all([appBackend.health(cfg), httpBackend.health(cfg)]);
          return { backend: resolveBackend(cfg), app, http };
        },
        log: (level, message) => ctx.logger?.[level]?.(message),
      });
      const registry = routeRegistry();
      registry.dispose = route.dispose;
      registry.url = route.url;
      settingsUrl = route.url;
      settingsDiag = `${via}: ok`;
      ctx.logger?.info?.(`dsh-ima: 可视化设置页 ${settingsUrl}`);
    } catch (error) {
      const message = String(error?.message ?? error);
      // 上一实例留下的同名路由仍活着时，重新注册会报 duplicate——
      // 那条路由用的是同一个持久化令牌，直接沿用它的 URL 即可。
      if (/duplicate/i.test(message)) {
        try {
          settingsUrl = `${webServer.getOrigin()}/dsh-ima/settings?token=${readSettings().token}`;
          settingsDiag = `${via}: reused existing route`;
          return;
        } catch { /* 落到下面的失败分支 */ }
      }
      settingsDiag = `${via}: error ${message}`;
      ctx.logger?.warn?.(`dsh-ima: 设置页注册失败（不影响工具）：${message}`);
    }
  };
  if (typeof ctx.inject === 'function') {
    settingsDiag = 'inject-pending';
    try {
      ctx.inject(['webServer'], (sub) => {
        settingsDiag = 'inject-callback';
        mountSettings(sub?.webServer ?? sub?.get?.('webServer'), 'inject');
      });
    } catch (error) {
      settingsDiag = `inject-threw: ${error?.message ?? error}`;
    }
  } else {
    mountSettings(ctx.get?.('webServer') ?? ctx.webServer, 'direct');
  }

  if (!active.quiet) {
    ctx.logger?.info?.(`dsh-ima: 启动（backend=${active.backend}，preset=${active.http.preset}，http=${active.http.baseUrl || '未配置'}）`);
    if (settingsUrl) ctx.logger?.info?.(`dsh-ima: 可视化设置页 ${settingsUrl}`);
  }

  let names = [];
  try {
    names = await installTools(ctx, active, () => {
      try { return resolveActive(); } catch { return undefined; }
    });
  } catch (error) {
    ctx.logger?.error?.(`dsh-ima: 工具注册失败：${error?.stack ?? error}`);
    throw error;
  }
  if (!active.quiet) {
    ctx.logger?.info?.(`dsh-ima: 已注册 ${names.length} 个工具：${names.join(', ')}`);
  }
  // 刻意不返回任何值：该版 Cordis 会把 apply 的非 undefined 返回值当成 effect 校验，
  // 返回数组会抛 `TypeError: Invalid effect` 并导致插件整个不激活。
  return undefined;
}
