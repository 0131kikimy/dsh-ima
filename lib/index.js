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

import { resolveConfig, resolveBackend, DEFAULTS, validateConfig, Config } from './config.js';
import { readSettings, writeSettings, mergeSettings, settingsFile } from './store.js';
import { registerSettingsRoute } from './settings-route.js';
import * as httpBackend from './http.js';
import * as appBackend from './app.js';
import * as writeBackend from './write.js';

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

  // ── 4. 问答 / 检索汇总 ────────────────────────────────────────────────────
  register({
    name: 'ima_ask',
    description:
      '向 ima 知识库提问。需要先点左侧栏的「ima」图标填好 Client ID 与 API Key。'
      + 'ima 官方接口没有问答生成能力，所以返回的是**知识库检索汇总**（首行会注明），不是 AI 生成的答案；'
      + '要拿到文档原文请用 ima_list_docs + ima_get_doc。',
    parameters: {
      question: { type: 'string', required: true, description: '问题或关键词（关键词比问句更容易命中）' },
      knowledgeBase: { type: 'string', description: '可选：限定知识库（id 或名称）' },
      topK: { type: 'number', description: `可选：返回条数（默认 ${DEFAULTS.topK}）` },
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
          mode: { type: 'string', description: 'ima preset 下为 retrieval（检索汇总）' },
          note: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `${v.answer}${v.citations && v.citations.length
          ? '\n\n— 引用 ' + v.citations.length + ' 条 —\n' + v.citations.slice(0, 8).map((c, i) => `[${i + 1}] ${c.title || c.url || ''}${c.snippet ? `\n    ${String(c.snippet).slice(0, 200)}` : ''}`).join('\n')
          : ''}`,
      }],
    },
    async execute(args) {
      if (typeof args?.question !== 'string' || !args.question.trim()) {
        throw new Error('ima_ask 需要非空 question');
      }
      const question = args.question.trim();
      if (backendOf(config) !== 'http') {
        throw new Error('还没配置 ima 接口。请点左侧栏的「ima」图标，填 Client ID 与 API Key 并保存；只想打开 ima 客户端请用 ima_open。');
      }
      const result = await httpBackend.ask(config, { question, knowledgeBase: args.knowledgeBase, topK: args.topK });
      return { backend: 'http', question, ...result };
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

  // ── 8. 写入知识库（需 confirm）────────────────────────────────
  register({
    name: 'ima_import',
    description:
      '把一个网址（网页/公众号文章）写进 ima 知识库。**写操作，必须带 confirm: true**。'
      + '纯文本请改用 ima_create_note 写成笔记，再用 ima_add_note_to_kb 归档。',
    parameters: {
      url: { type: 'string', required: true, description: '要收藏的网址' },
      title: { type: 'string', description: '可选：标题' },
      knowledgeBase: { type: 'string', description: '可选：目标知识库（id 或名称）' },
      confirm: { type: 'boolean', description: '写操作确认位，必须为 true' },
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
      requireConfirm(args, '把网址写进知识库');
      if (typeof args?.url !== 'string' || !args.url.trim()) throw new Error('ima_import 需要 url');
      return httpBackend.importItem(config, {
        url: args.url.trim(),
        title: args.title,
        knowledgeBase: args.knowledgeBase,
      });
    },
  });

  // ── 9. 笔记：只读 ─────────────────────────────────────────────────────────
  register({
    name: 'ima_list_notebooks',
    executionMode: 'parallel',
    description: '列出 ima 里的笔记本（id / 名称 / 笔记数）。写笔记前用它挑目标笔记本。**仅 ima 官方 OpenAPI 可用**。',
    parameters: { limit: { type: 'number', description: '数量上限（默认 20，上限 20）' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          notebooks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                noteCount: { type: 'number' },
                parentId: { type: 'string' },
                type: { type: 'number' },
              },
            },
          },
          isEnd: { type: 'boolean' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.notebooks.length
          ? v.notebooks.map((f) => `- ${f.name || '(未命名)'}（${f.id}）${f.noteCount !== undefined ? `：${f.noteCount} 篇` : ''}`).join('\n')
          : '没有笔记本（新账号可能为空，可以直接写笔记到"未分类"）',
      }],
    },
    async execute(args) {
      return writeBackend.listNotebooks(config, { limit: args?.limit });
    },
  });

  register({
    name: 'ima_list_notes',
    executionMode: 'parallel',
    description: '列出 ima 笔记（可按笔记本过滤），返回 noteId / 标题 / 更新时间。**仅 ima 官方 OpenAPI 可用**。',
    parameters: {
      folderId: { type: 'string', description: '可选：限定笔记本 id（先用 ima_list_notebooks 查）' },
      limit: { type: 'number', description: '数量上限（默认 20，上限 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          notes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                noteId: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                folderId: { type: 'string' },
                folderName: { type: 'string' },
                modifyTime: { type: 'number' },
              },
            },
          },
          isEnd: { type: 'boolean' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.notes.length
          ? v.notes.map((n, i) => `${i + 1}. ${n.title || '(无标题)'}${n.folderName ? `（${n.folderName}）` : ''}\n   noteId=${n.noteId}`).join('\n')
          : '没有笔记',
      }],
    },
    async execute(args) {
      return writeBackend.listNotes(config, { folderId: args?.folderId, limit: args?.limit });
    },
  });

  register({
    name: 'ima_get_note',
    executionMode: 'parallel',
    description: '读取一篇 ima 笔记的正文（纯文本）。**仅 ima 官方 OpenAPI 可用**，且只能读自己写的笔记。',
    parameters: { noteId: { type: 'string', required: true, description: '笔记 id（来自 ima_list_notes / ima_create_note）' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          noteId: { type: 'string' },
          content: { type: 'string' },
          chars: { type: 'number' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `${v.noteId}｜${v.chars} 字\n\n${String(v.content || '').slice(0, 3000)}${(v.content || '').length > 3000 ? '\n…（已截断）' : ''}`,
      }],
    },
    async execute(args) {
      if (!args?.noteId) throw new Error('ima_get_note 需要 noteId');
      const result = await writeBackend.getNote(config, { noteId: args.noteId });
      return { ...result, chars: result.content.length };
    },
  });

  // ── 10. 笔记：写入（需 confirm）────────────────────────────────────────────
  const requireConfirm = (args, what) => {
    if (args?.confirm !== true) {
      throw new Error(
        `这是写操作（${what}），会在你的 ima 账号里真实创建/修改内容，而官方没有删除接口。`
        + '请先向用户确认目标（笔记本 / 知识库 / 标题），确认后带 confirm: true 再调用一次。',
      );
    }
  };

  register({
    name: 'ima_create_note',
    description:
      '新建一篇 ima 笔记（Markdown）。**写操作，必须带 confirm: true**。'
      + '建议先用 ima_list_notebooks 拿笔记本 id，或直接传 folderName 让它落到该笔记本。',
    parameters: {
      content: { type: 'string', required: true, description: 'Markdown 正文（不要为空）' },
      folderId: { type: 'string', description: '可选：目标笔记本 id' },
      folderName: { type: 'string', description: '可选：目标笔记本名称（没有 id 时用）' },
      confirm: { type: 'boolean', description: '写操作确认位，必须为 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          noteId: { type: 'string' },
          folderName: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `已新建笔记：noteId=${v.noteId}${v.folderName ? `（笔记本：${v.folderName}）` : ''}`,
      }],
    },
    async execute(args) {
      requireConfirm(args, '新建笔记');
      return writeBackend.createNote(config, {
        content: args.content,
        folderId: args.folderId,
        folderName: args.folderName,
      });
    },
  });

  register({
    name: 'ima_append_note',
    description: '在已有 ima 笔记末尾追加内容（Markdown）。**写操作，必须带 confirm: true**，且需要你是作者。',
    parameters: {
      noteId: { type: 'string', required: true, description: '目标笔记 id' },
      content: { type: 'string', required: true, description: '要追加的 Markdown 文本' },
      confirm: { type: 'boolean', description: '写操作确认位，必须为 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { noteId: { type: 'string' } },
      },
      render: (_args, v) => [{ type: 'text', text: `已追加到笔记 ${v.noteId}` }],
    },
    async execute(args) {
      requireConfirm(args, '追加笔记内容');
      return writeBackend.appendNote(config, { noteId: args.noteId, content: args.content });
    },
  });

  // ── 11. 知识库：写入（需 confirm）──────────────────────────────────────────
  register({
    name: 'ima_add_note_to_kb',
    description:
      '把一篇 ima 笔记加进知识库（官方 media_type=11）。**写操作，必须带 confirm: true**。'
      + '典型用法：ima_create_note 写好内容 → 本工具归档进知识库。',
    parameters: {
      noteId: { type: 'string', required: true, description: '笔记 id' },
      title: { type: 'string', description: '可选：在知识库里显示的标题（默认"未命名笔记"）' },
      knowledgeBase: { type: 'string', description: '目标知识库 id 或名称（省略则用配置里的默认库）' },
      folderId: { type: 'string', description: '可选：知识库内的目标文件夹 id' },
      confirm: { type: 'boolean', description: '写操作确认位，必须为 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mediaId: { type: 'string' },
          knowledgeBase: { type: 'string' },
          knowledgeBaseName: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `已把笔记加入知识库「${v.knowledgeBaseName}」（${v.knowledgeBase}），mediaId=${v.mediaId}`,
      }],
    },
    async execute(args) {
      requireConfirm(args, '把笔记加入知识库');
      return writeBackend.addNoteToKb(config, {
        noteId: args.noteId,
        title: args.title,
        knowledgeBase: args.knowledgeBase,
        folderId: args.folderId,
      });
    },
  });

  register({
    name: 'ima_upload_file',
    description:
      '把本机文件上传进知识库（create_media → 腾讯云 COS 上传 → add_knowledge）。'
      + '支持 pdf / docx / pptx / xlsx / csv / md / txt / html / epub / 图片 / xmind / 音频。'
      + '**写操作，必须带 confirm: true**。大文件上传较慢（超时默认 5 分钟）。',
    parameters: {
      filePath: { type: 'string', required: true, description: '本机文件路径（绝对路径或相对会话工作区）' },
      title: { type: 'string', description: '可选：知识库里显示的标题（默认文件名）' },
      knowledgeBase: { type: 'string', description: '目标知识库 id 或名称' },
      folderId: { type: 'string', description: '可选：知识库内目标文件夹 id' },
      confirm: { type: 'boolean', description: '写操作确认位，必须为 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mediaId: { type: 'string' },
          title: { type: 'string' },
          bytes: { type: 'number' },
          mediaType: { type: 'number' },
          knowledgeBase: { type: 'string' },
          knowledgeBaseName: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `已上传「${v.title}」（${Math.round(v.bytes / 1024)} KB，media_type=${v.mediaType}）到知识库「${v.knowledgeBaseName}」\nmediaId=${v.mediaId}`,
      }],
    },
    async execute(args) {
      requireConfirm(args, '上传文件到知识库');
      return writeBackend.uploadFile(config, {
        filePath: args.filePath,
        title: args.title,
        knowledgeBase: args.knowledgeBase,
        folderId: args.folderId,
      });
    },
  });


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
