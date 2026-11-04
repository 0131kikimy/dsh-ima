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
