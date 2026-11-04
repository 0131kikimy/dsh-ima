// dsh-ima · HTTP 后端
//
// 契约（可配置，全部字段见 lib/config.js 的 `http`）：
//   POST {baseUrl}{paths.ask}      body {"question","knowledge_base","top_k"}  → {answer, citations}
//   POST {baseUrl}{paths.search}   body {"query","knowledge_base","top_k"}     → {hits[]}
//   GET  {baseUrl}{paths.kbList}                                              → {knowledge_bases[]}
//   POST {baseUrl}{paths.import}   body {"url"|"text","title","knowledge_base"}→ {id, status}
//
// 响应字段用 `http.mapping` 的点号路径取值（支持 `choices[0].message.content` 这种形态），
// 所以「OpenAI 兼容的 /chat/completions」和「自家 /v1/ask」都能不改代码接上。
// 这里不猜 ima 官方接口的形状：用户填什么就按什么映射，映射不到就如实报错。

import { getByPath, maskSecret } from './config.js';

/** ima 官方 OpenAPI 的请求头（协议来自官方 ima-skills 包里的 ima_api.cjs）。 */
function imaHeaders(config) {
  return {
    'ima-openapi-clientid': config.http.clientId,
    'ima-openapi-apikey': config.http.apiKey,
    'ima-openapi-ctx': `skill_version=${config.http.skillVersion}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * 调一次 ima 官方 OpenAPI。
 * @param {object} config - 已规范化配置。
 * @param {string} apiPath - 例如 `openapi/wiki/v1/search_knowledge`。
 * @param {object} body - 请求体。
 * @returns {Promise<object>} `data` 字段内容。
 */
async function imaPost(config, apiPath, body = {}) {
  if (!config.http.clientId || !config.http.apiKey) {
    throw new Error(
      'ima 后端缺少凭据：请在 https://ima.qq.com/agent-interface 获取 API Key，'
      + '然后配置 http.clientId 与 http.apiKey（或改用 http.preset: generic 接你自己的接口）。',
    );
  }
  const url = `${config.http.baseUrl}/${apiPath}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: imaHeaders(config),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.http.timeoutMs),
    });
  } catch (error) {
    const reason = error?.cause?.code || error?.name || 'fetch failed';
    throw new Error(`无法连接 ima 开放接口 ${url}（${reason}）`);
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text || '{}');
  } catch {
    throw new Error(`ima 接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok || (payload.code !== 0 && payload.code !== undefined)) {
    throw new Error(
      `ima 接口 ${apiPath} 失败：HTTP ${response.status}，code=${payload.code}，msg=${payload.msg || payload.message || ''}`,
    );
  }
  return payload.data ?? {};
}

/**
 * 发一次 HTTP 请求。
 * @param {object} config - 已规范化配置。
 * @param {{method: string, path: string, body?: object, timeoutMs?: number}} request - 请求描述。
 * @returns {Promise<{status: number, data: unknown} >} 状态码与解析后的响应体。
 */
async function send(config, request) {
  const http = config.http;
  const url = `${http.baseUrl}${request.path}`;
  const headers = { Accept: 'application/json' };
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';
  // 先铺自定义头，再写标准鉴权头：让 `Authorization` 的语义不被自定义值意外覆盖。
  for (const [name, value] of Object.entries(http.headers || {})) headers[name] = value;
  if (http.token) headers[http.authHeader || 'Authorization'] = `${http.authScheme ?? ''}${http.token}`;

  let response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutMs ?? http.timeoutMs),
    });
  } catch (error) {
    const reason = error?.cause?.code || error?.name || 'fetch failed';
    throw new Error(
      `无法连接 ima HTTP 接口 ${url}（${reason}）。`
      + '请确认 http.baseUrl 正确、服务在运行、token 有效；若你还没有接口，把 backend 设为 app 或直接不配 baseUrl。',
    );
  }

  const text = await response.text();
  let data;
  try {
    data = text.length ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
    throw new Error(`ima HTTP 接口返回 HTTP ${response.status}：${detail}`);
  }
  return { status: response.status, data };
}

/** 把 citations 的多种常见形状归一成 `{title,url,snippet}` 数组。 */
function normalizeCitations(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    if (typeof item === 'string') return { snippet: item, index };
    return {
      title: item?.title ?? item?.name ?? item?.doc_name,
      url: item?.url ?? item?.link ?? item?.doc_url,
      snippet: item?.snippet ?? item?.content ?? item?.text ?? item?.passage,
      score: typeof item?.score === 'number' ? item.score : undefined,
      index,
    };
  }).filter((item) => item.title || item.url || item.snippet);
}

/**
 * 体检：能否连上 HTTP 后端。
 * @param {object} config - 已规范化配置。
 * @returns {Promise<object>} 体检结果。
 */
export async function health(config) {
  if (config.http.preset === 'ima') return imaHealth(config);
  const base = {
    configured: Boolean(config.http.baseUrl),
    baseUrl: config.http.baseUrl,
    token: maskSecret(config.http.token),
    timeoutMs: config.http.timeoutMs,
  };
  if (!config.http.baseUrl) return { ...base, reachable: false, error: '未配置 http.baseUrl' };
  try {
    const { status } = await send(config, {
      method: 'GET',
      path: config.http.paths.kbList,
      timeoutMs: Math.min(config.http.timeoutMs, 10000),
    });
    return { ...base, reachable: true, status, probe: `GET ${config.http.paths.kbList}` };
  } catch (error) {
    return { ...base, reachable: false, error: String(error?.message ?? error) };
  }
}

/**
 * 问答。
 * @param {object} config - 已规范化配置。
 * @param {{question: string, knowledgeBase?: string, topK?: number}} input - 提问参数。
 * @returns {Promise<object>} `{answer, citations}`。
 */
export async function ask(config, input) {
  if (config.http.preset === 'ima') return imaAsk(config, input);
  const { data } = await send(config, {
    method: 'POST',
    path: config.http.paths.ask,
    body: {
      question: input.question,
      knowledge_base: input.knowledgeBase || config.knowledgeBase || undefined,
      top_k: input.topK ?? config.topK,
    },
  });
  const mapping = config.http.mapping;
  const answer = getByPath(data, mapping.answer)
    ?? getByPath(data, 'data.answer')
    ?? getByPath(data, 'content')
    ?? getByPath(data, 'choices[0].message.content');
  if (typeof answer !== 'string' || answer.trim().length === 0) {
    throw new Error(
      `接口响应里取不到答案文本（按 http.mapping.answer="${mapping.answer}" 与回退路径都没命中）。`
      + `响应片段：${JSON.stringify(data).slice(0, 300)}`,
    );
  }
  const citationsRaw = getByPath(data, mapping.citations)
    ?? getByPath(data, 'data.citations')
    ?? getByPath(data, 'references');
  return {
    answer: answer.trim(),
    citations: normalizeCitations(citationsRaw),
    knowledgeBase: input.knowledgeBase || config.knowledgeBase || undefined,
  };
}

/**
 * 检索。
 * @param {object} config - 已规范化配置。
 * @param {{query: string, knowledgeBase?: string, topK?: number}} input - 检索参数。
 * @returns {Promise<object>} `{hits[]}`。
 */
export async function search(config, input) {
  if (config.http.preset === 'ima') return imaSearch(config, input);
  const { data } = await send(config, {
    method: 'POST',
    path: config.http.paths.search,
    body: {
      query: input.query,
      knowledge_base: input.knowledgeBase || config.knowledgeBase || undefined,
      top_k: input.topK ?? config.topK,
    },
  });
  const mapping = config.http.mapping;
  const rawHits = getByPath(data, mapping.hits)
    ?? getByPath(data, 'data.hits')
    ?? getByPath(data, 'data')
    ?? getByPath(data, 'results');
  const list = Array.isArray(rawHits) ? rawHits : [];
  if (list.length === 0) {
    return {
      query: input.query,
      hits: [],
      total: 0,
      note: rawHits === undefined
        ? `接口响应里取不到命中列表（按 http.mapping.hits="${mapping.hits}" 没命中）。响应片段：${JSON.stringify(data).slice(0, 200)}`
        : undefined,
    };
  }
  const hits = list.slice(0, input.topK ?? config.topK).map((item, index) => ({
    title: getByPath(item, mapping.hitTitle) ?? getByPath(item, 'name') ?? `结果 ${index + 1}`,
    snippet: getByPath(item, mapping.hitSnippet) ?? getByPath(item, 'content') ?? getByPath(item, 'text'),
    url: getByPath(item, mapping.hitUrl) ?? getByPath(item, 'link'),
    score: getByPath(item, mapping.hitScore),
    knowledgeBase: item?.knowledge_base ?? item?.kb_name,
  }));
  return { query: input.query, hits, total: hits.length };
}

/**
 * 列知识库。
 * @param {object} config - 已规范化配置。
 * @returns {Promise<object>} `{knowledgeBases[]}`。
 */
export async function kbList(config) {
  if (config.http.preset === 'ima') return imaKbList(config);
  const { data } = await send(config, { method: 'GET', path: config.http.paths.kbList });
  const raw = data?.knowledge_bases ?? data?.data ?? data?.items ?? data;
  const list = Array.isArray(raw) ? raw : [];
  return {
    knowledgeBases: list.map((item) => ({
      id: item?.id ?? item?.kb_id ?? item?.knowledge_base_id,
      name: item?.name ?? item?.title ?? '',
      count: typeof item?.doc_count === 'number' ? item.doc_count : undefined,
    })).filter((item) => item.name || item.id),
  };
}

/**
 * 写入知识库（URL 或纯文本）。
 * @param {object} config - 已规范化配置。
 * @param {{url?: string, text?: string, title?: string, knowledgeBase?: string}} input - 写入参数。
 * @returns {Promise<object>} `{id, status}`。
 */
export async function importItem(config, input) {
  if (config.http.preset === 'ima') return imaImport(config, input);
  const body = {
    knowledge_base: input.knowledgeBase || config.knowledgeBase || undefined,
    title: input.title,
  };
  if (input.url) body.url = input.url;
  else body.text = input.text;
  const { data } = await send(config, { method: 'POST', path: config.http.paths.import, body });
  return {
    id: data?.id ?? data?.doc_id ?? data?.data?.id,
    status: data?.status ?? data?.data?.status ?? 'accepted',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ima 官方 OpenAPI preset
//
// 协议真源：腾讯官方 ima-skills 包（`ima-skills-1.1.10.zip`）里的 `ima_api.cjs`——
//   POST {baseUrl}/<apiPath>
//   headers: ima-openapi-clientid / ima-openapi-apikey / ima-openapi-ctx: skill_version=…
// 接口集合来自同包的 `references/api.md`：`wiki/v1`（知识库）与 `note/v1`（笔记），
// **没有问答生成接口**。所以 `ima_ask` 在这里退化为「检索 + 汇总」，并在答案首行如实标注。
// 凭据申请页：https://ima.qq.com/agent-interface

/**
 * ima preset 体检。
 * @param {object} config - 已规范化配置。
 * @returns {Promise<object>} 体检结果。
 */
async function imaHealth(config) {
  const base = {
    preset: 'ima',
    configured: Boolean(config.http.clientId && config.http.apiKey),
    baseUrl: config.http.baseUrl,
    clientId: maskSecret(config.http.clientId),
    apiKey: maskSecret(config.http.apiKey),
    skillVersion: config.http.skillVersion,
    timeoutMs: config.http.timeoutMs,
  };
  if (!base.configured) {
    return { ...base, reachable: false, error: '未配置 http.clientId / http.apiKey（在 https://ima.qq.com/agent-interface 获取）' };
  }
  try {
    const list = await imaKbListRaw(config);
    return {
      ...base,
      reachable: true,
      probe: 'POST openapi/wiki/v1/search_knowledge_base',
      knowledgeBaseCount: list.length,
      knowledgeBaseSample: list.slice(0, 3).map((kb) => kb.name).filter(Boolean),
      note: 'ima 官方 OpenAPI 提供知识库/笔记接口，无问答生成接口；ima_ask 走检索汇总。',
    };
  } catch (error) {
    return { ...base, reachable: false, error: String(error?.message ?? error) };
  }
}

/**
 * 取知识库原始列表。
 * @param {object} config - 已规范化配置。
 * @returns {Promise<Array<{id: string, name: string, count?: number, description?: string, baseType?: string}>>} 知识库列表。
 */
async function imaKbListRaw(config) {
  const data = await imaPost(config, 'openapi/wiki/v1/search_knowledge_base', { query: '', cursor: '', limit: 20 });
  const list = Array.isArray(data?.info_list) ? data.info_list : [];
  return list.map((item) => ({
    id: item.kb_id,
    name: item.kb_name,
    count: Number(item.content_count) || undefined,
    description: item.description || undefined,
    baseType: item.base_type || undefined,
  }));
}

/**
 * ima preset：列知识库。
 * @param {object} config - 已规范化配置。
 * @returns {Promise<object>} `{knowledgeBases[]}`。
 */
async function imaKbList(config) {
  const list = await imaKbListRaw(config);
  return { knowledgeBases: list.map(({ id, name, count }) => ({ id, name, count })) };
}

/**
 * 归一化一条检索命中。
 * @param {object} item - ima 返回的 info_list 项。
 * @param {string} kbName - 所属知识库名。
 * @returns {object} 命中对象。
 */
function imaHit(item, kbName) {
  return {
    title: item?.title,
    snippet: item?.highlight_content || undefined,
    mediaId: item?.media_id,
    mediaType: item?.media_type,
    knowledgeBase: kbName,
  };
}

/**
 * ima preset：检索。未指定知识库时按前 5 个知识库逐个检索后合并。
 * @param {object} config - 已规范化配置。
 * @param {{query: string, knowledgeBase?: string, topK?: number}} input - 检索参数。
 * @returns {Promise<object>} `{query, hits[], total}`。
 */
async function imaSearch(config, input) {
  const topK = input.topK ?? config.topK;
  const all = await imaKbListRaw(config);
  const targets = input.knowledgeBase
    ? all.filter((kb) => kb.id === input.knowledgeBase || kb.name === input.knowledgeBase)
    : all.slice(0, 5);
  if (targets.length === 0) {
    throw new Error(`找不到知识库 ${JSON.stringify(input.knowledgeBase)}；先用 ima_kb_list 看可用 id/名称`);
  }
  const hits = [];
  for (const kb of targets) {
    const data = await imaPost(config, 'openapi/wiki/v1/search_knowledge', {
      query: input.query,
      knowledge_base_id: kb.id,
      cursor: '',
    });
    for (const item of (Array.isArray(data?.info_list) ? data.info_list : [])) hits.push(imaHit(item, kb.name));
  }
  return { query: input.query, hits: hits.slice(0, topK), total: hits.length };
}

/**
 * ima preset：提问 = 检索 + 汇总（该 API 无问答生成能力，答案首行如实标注）。
 * @param {object} config - 已规范化配置。
 * @param {{question: string, knowledgeBase?: string, topK?: number}} input - 提问参数。
 * @returns {Promise<object>} `{answer, citations[], mode}`。
 */
async function imaAsk(config, input) {
  const result = await imaSearch(config, {
    query: input.question,
    knowledgeBase: input.knowledgeBase,
    topK: input.topK,
  });
  const lines = result.hits
    .map((hit, index) => `${index + 1}. ${hit.title || '(无标题)'}${hit.snippet ? `：${hit.snippet}` : ''}`)
    .join('\n');
  return {
    answer: result.hits.length
      ? `（ima 开放接口没有问答生成能力，以下是知识库检索结果）\n${lines}`
      : '（ima 知识库里没有检索到相关内容）',
    citations: result.hits.map((hit, index) => ({ title: hit.title, snippet: hit.snippet, index })),
    mode: 'retrieval',
    knowledgeBase: input.knowledgeBase || undefined,
  };
}

/**
 * ima preset：按 URL 写入知识库（import_urls；纯文本需走 note/v1 笔记接口，本工具不覆盖）。
 * @param {object} config - 已规范化配置。
 * @param {{url?: string, text?: string, knowledgeBase?: string}} input - 写入参数。
 * @returns {Promise<object>} `{id, status}`。
 */
async function imaImport(config, input) {
  if (!input.url) {
    throw new Error('ima 官方 OpenAPI 只支持按 URL 写入知识库（纯文本要走笔记接口）；请提供 url');
  }
  const kbId = input.knowledgeBase || config.knowledgeBase;
  if (!kbId) {
    throw new Error('ima 导入需要目标知识库：请给 knowledgeBase 参数，或在配置里设置 knowledgeBase（ima_kb_list 可查 id）');
  }
  const data = await imaPost(config, 'openapi/wiki/v1/import_urls', {
    knowledge_base_id: kbId,
    folder_id: kbId,
    urls: [input.url],
  });
  const entry = data?.results?.[input.url] || {};
  return {
    id: entry.media_id,
    status: entry.ret_code === 0 ? 'accepted' : `ret_code=${entry.ret_code}`,
  };
}
