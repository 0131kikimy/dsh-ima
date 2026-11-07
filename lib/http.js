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

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getByPath, maskSecret } from './config.js';
import { extractByExtension } from './extract.js';

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
export async function imaPost(config, apiPath, body = {}) {
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

// ─────────────────────────────────────────────────────────────────────────────
// ima preset：列文档 / 取正文
//
// 为什么必须有：`search_knowledge` 实际只返回**标题**（官方实现的 `highlight_content` 恒为空串），
// `ima_ask` 因此退化成"标题级检索"；而知识库的正文要经
//   `get_knowledge_list`（列文件夹内文档） → `get_media_info`（取签名下载链接） → 下载 → 抽文本
// 才能拿到。0.2.0 之前这两步没接线，导致「必须引用原文」的任务（知识卡片、备课摘要、
// 逐字核对引用）只能手工绕过插件。

/** ima 媒体类型：99 = 文件夹，其余按文档处理。 */
const MEDIA_FOLDER = 99;
/** 单个文件夹最多翻多少页，避免异常响应把工具卡死。 */
const MAX_LIST_PAGES = 20;

/** 把可能是名称或 id 的知识库标识解析成确定的库。 */
async function resolveKnowledgeBase(config, hint) {
  const wanted = String(hint ?? config.knowledgeBase ?? '').trim();
  const all = await imaKbListRaw(config);
  const listing = all.map((kb) => `${kb.name || '(无名)'}（${kb.id}）`).join('、') || '（无）';
  if (wanted) {
    const hit = all.find((kb) => kb.id === wanted || kb.name === wanted);
    if (!hit) throw new Error(`找不到知识库 ${JSON.stringify(wanted)}；可用：${listing}`);
    return hit;
  }
  if (all.length === 1) return all[0];
  throw new Error(`需要指定 knowledgeBase（当前有 ${all.length} 个库）：${listing}`);
}

/**
 * ima preset：列知识库内的文档（默认递归展开文件夹）。
 *
 * @param {object} config - 已规范化配置。
 * @param {{knowledgeBase?: string, folderId?: string, limit?: number, recursive?: boolean}} input - 参数。
 * @returns {Promise<object>} `{knowledgeBase, knowledgeBaseName, docs[], folders[], total, truncated}`。
 */
export async function listDocs(config, input = {}) {
  if (config.http.preset !== 'ima') {
    throw new Error(
      'ima_list_docs 需要 http.preset: ima（腾讯 ima 官方 OpenAPI）；'
      + 'generic 后端没有等价的「列文档」契约——请直接调你自己的接口，或把盘点逻辑放在调用方',
    );
  }
  const kb = await resolveKnowledgeBase(config, input.knowledgeBase);
  const limit = Math.min(Math.max(Number(input.limit) || 200, 1), 500);
  const recursive = input.recursive !== false;
  const startFolder = String(input.folderId || '').trim() || kb.id;

  const docs = [];
  const folders = [];
  let truncated = false;
  let pages = 0;
  const queue = [{ folderId: startFolder, path: '' }];

  while (queue.length > 0) {
    const { folderId, path } = queue.shift();
    let cursor = '';
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      pages += 1;
      const data = await imaPost(config, 'openapi/wiki/v1/get_knowledge_list', {
        knowledge_base_id: kb.id,
        folder_id: folderId,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of (Array.isArray(data?.knowledge_list) ? data.knowledge_list : [])) {
        const entry = {
          title: item?.title,
          mediaId: item?.media_id,
          mediaType: item?.media_type,
          parentFolderId: item?.parent_folder_id,
          folder: path || undefined,
        };
        if (item?.media_type === MEDIA_FOLDER) {
          folders.push(entry);
          if (recursive && entry.mediaId) {
            queue.push({
              folderId: entry.mediaId,
              path: path ? `${path}/${entry.title || entry.mediaId}` : String(entry.title || entry.mediaId),
            });
          }
          continue;
        }
        if (docs.length >= limit) { truncated = true; continue; }
        docs.push(entry);
      }
      const next = data?.next_cursor;
      if (data?.is_end !== false || !next || next === cursor) break;
      cursor = next;
    }
  }

  return {
    knowledgeBase: kb.id,
    knowledgeBaseName: kb.name,
    docs,
    folders,
    total: docs.length,
    foldersScanned: folders.length,
    truncated,
    note: truncated ? `已达 limit=${limit} 上限，结果被截断` : undefined,
    pages,
  };
}

/** 从签名 URL 里取标题与扩展名（`get_media_info` 只给链接，不给标题）。 */
function guessFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const base = decodeURIComponent((u.pathname.split('/').pop() || '').trim());
    const ext = (base.match(/\.[a-z0-9]{1,6}$/i) || [''])[0].toLowerCase();
    return { title: u.searchParams.get('media_title') || base, ext };
  } catch {
    return { title: '', ext: '' };
  }
}

/** 下载二进制（带超时与清晰报错）。 */
async function fetchBytes(url, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error?.cause?.code || error?.name || 'fetch failed';
    throw new Error(`下载文档失败（${reason}）`);
  }
  if (!response.ok) throw new Error(`下载文档失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** 文件名消毒：去掉路径分隔符与非法字符。 */
function safeFileName(name) {
  return String(name || '').replace(/[\\\\/:*?"<>|\\r\\n]/g, '_').trim().slice(0, 120);
}

/**
 * 用 pdftotext（poppler）抽 PDF 文本：零 npm 依赖的 best-effort。
 * 找不到可执行文件时**不抛错**，而是如实回报 `extractor: 'unavailable'`——PDF 里也可能是纯扫描件，抽不出字不代表取正文失败。
 */
/**
 * 找出可用的 pdftotext。
 *
 * 为什么不能只靠 PATH：这个二进制常常只存在于某个插件的自带工具链里
 * （例如 dsh-ops 的 @dsh-ops/bash-win32-x64/ucrt64/bin/pdftotext.exe），
 * 而宿主进程的 PATH 与交互式 shell 不同，于是"明明装了却 ENOENT"。
 * 注意：这里一律用 path.join 拼路径，避免手写反斜杠带来的转义陷阱。
 */
function resolvePdftotext() {
  if (process.env.DSH_IMA_PDFTOTEXT) return [process.env.DSH_IMA_PDFTOTEXT];
  const candidates = ['pdftotext'];
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const dshHome = process.env.DSH_HOME || (home ? path.join(home, '.dsh') : '');
    const profileDir = process.env.DSH_PROFILE_DIR || (dshHome ? path.join(dshHome, 'profiles', 'desktop') : '');
    if (profileDir) {
      for (const toolchain of ['ucrt64', 'mingw64']) {
        candidates.push(path.join(profileDir, 'node_modules', '@dsh-ops', 'bash-win32-x64', toolchain, 'bin', 'pdftotext.exe'));
      }
    }
    candidates.push(path.join('C:', 'Program Files', 'poppler', 'bin', 'pdftotext.exe'));
    candidates.push(path.join('C:', 'Program Files', 'xpdf-tools', 'bin64', 'pdftotext.exe'));
  }
  return candidates.filter((bin) => bin === 'pdftotext' || existsSync(bin));
}

/**
 * 用 pdftotext（poppler）抽 PDF 文本：零 npm 依赖的 best-effort。
 * 找不到可执行文件时**不抛错**，而是如实回报 `extractor: 'unavailable'`——PDF 里也可能是纯扫描件，抽不出字不代表取正文失败。
 */
/**
 * 用 pdftotext（poppler / xpdf）抽 PDF 文本：零 npm 依赖的 best-effort。
 * 找不到可执行文件时**不抛错**，而是如实回报 `extractor: 'unavailable'` 与试过的位置——
 * PDF 里也可能是纯扫描件，抽不出字不代表取正文失败。
 */
function extractPdfText(filePath, maxChars) {
  const candidates = resolvePdftotext();
  const tried = [];
  let result;
  let bin;
  for (const candidate of candidates) {
    tried.push(candidate);
    bin = candidate;
    result = spawnSync(candidate, ['-enc', 'UTF-8', '-layout', filePath, '-'], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error && result.error.code === 'ENOENT') continue;
    break;
  }
  if (!result || (result.error && result.error.code === 'ENOENT')) {
    return {
      extractor: 'unavailable',
      extractError: `找不到 pdftotext；试过：${tried.join(' | ') || '(无候选)'}。`
        + '可用环境变量 DSH_IMA_PDFTOTEXT 指定路径；已保留下载文件，可自行抽取',
    };
  }
  if (result.error) {
    return { extractor: 'pdftotext', extractError: `${bin} 启动失败：${result.error.code || result.error.message}` };
  }
  if (result.status !== 0) {
    return { extractor: 'pdftotext', extractError: `pdftotext 退出码 ${result.status}：${String(result.stderr || '').slice(0, 200)}` };
  }
  const text = String(result.stdout || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) {
    return { extractor: 'pdftotext', extractError: 'pdftotext 抽出 0 字（可能是扫描版 PDF，需要 OCR）' };
  }
  return {
    extractor: 'pdftotext',
    extractorPath: bin,
    text: text.slice(0, maxChars),
    textChars: text.length,
    textTruncated: text.length > maxChars,
  };
}

/**
 * ima preset：取单篇文档的正文（下载原件 + 尽力抽文本）。
 *
 * @param {object} config - 已规范化配置。
 * @param {{mediaId?: string, maxChars?: number, saveTo?: string}} input - 参数。
 * @returns {Promise<object>} `{mediaId, title, mediaType, url, bytes, savedPath, extractor, text, textChars, textTruncated}`。
 */
export async function getDoc(config, input = {}) {
  if (config.http.preset !== 'ima') {
    throw new Error(
      'ima_get_doc 需要 http.preset: ima（腾讯 ima 官方 OpenAPI）；'
      + 'generic 后端没有等价的「取签名下载链接」契约',
    );
  }
  const mediaId = String(input.mediaId || '').trim();
  if (!mediaId) throw new Error('ima_get_doc 需要 mediaId（先用 ima_list_docs 或 ima_search 取到）');
  const maxChars = Math.min(Math.max(Number(input.maxChars) || 20000, 200), 200000);

  const info = await imaPost(config, 'openapi/wiki/v1/get_media_info', { media_id: mediaId });
  const url = info?.url_info?.url;
  if (!url) throw new Error(`get_media_info 没返回下载链接：${JSON.stringify(info).slice(0, 200)}`);
  const guessed = guessFromUrl(url);
  const buffer = await fetchBytes(url, config.http.timeoutMs);
  const ext = guessed.ext || '.pdf';

  // 先落临时文件：抽文本需要一个路径，用户也可能想直接拿走原件。
  const tempDir = path.join(tmpdir(), 'dsh-ima');
  mkdirSync(tempDir, { recursive: true });
  const tempFile = path.join(tempDir, `${safeFileName(mediaId).slice(-60)}${ext}`);
  writeFileSync(tempFile, buffer);
  let savedPath = tempFile;

  if (String(input.saveTo || '').trim()) {
    const dir = String(input.saveTo).trim();
    mkdirSync(dir, { recursive: true });
    const base = safeFileName(guessed.title) || safeFileName(mediaId) || 'ima-doc';
    const target = path.join(dir, base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`);
    copyFileSync(tempFile, target);
    savedPath = target;
  }

  const extracted = ext === '.pdf' ? extractPdfText(tempFile, maxChars) : extractByExtension(buffer, ext, maxChars);

  return {
    mediaId,
    title: guessed.title || undefined,
    mediaType: info?.media_type,
    url,
    bytes: buffer.length,
    savedPath,
    ...extracted,
    note: 'url 为 ima 签名链接，会过期；正文以 savedPath 的文件为准',
  };
}
