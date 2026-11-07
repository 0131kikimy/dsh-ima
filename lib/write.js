// dsh-ima · 写入能力（笔记 / 知识库）
//
// 协议真源：官方 ima-skills 包（ima-skills-1.1.10）的 notes/knowledge-base 两份 references/api.md。
//
//  笔记（note/v1）
//    list_notebook   → 笔记本列表（cursor 首页传 "0"）
//    list_note       → 笔记列表
//    search_note     → 搜笔记（0=标题，1=正文）
//    get_doc_content → 读正文（target_content_format 0=纯文本）
//    import_doc      → 新建笔记（只收 Markdown，content_format 固定 1）
//    append_doc      → 追加到笔记末尾
//
//  知识库（wiki/v1）
//    add_knowledge   → 把笔记（media_type=11）或已上传文件加进知识库
//    create_media    → 上传文件第一步：拿 media_id + COS 临时凭证
//    （COS PUT 上传）
//
// **没有 create_knowledge_base**：官方接口不支持新建知识库，只能往已有且有权添加的库里写。

import { randomUUID } from 'node:crypto';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { imaPost } from './http.js';

/** 文件扩展名 → ima media_type。取自官方 MediaType 枚举。 */
const MEDIA_TYPE_BY_EXT = {
  pdf: 1,
  doc: 3, docx: 3,
  ppt: 4, pptx: 4,
  xls: 5, xlsx: 5, csv: 5,
  md: 7, markdown: 7,
  png: 9, jpg: 9, jpeg: 9, webp: 9,
  txt: 13,
  xmind: 14,
  mp3: 15, m4a: 15, wav: 15, aac: 15,
  html: 20, htm: 20,
  epub: 21,
};

/** 文件扩展名 → MIME。 */
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain',
  xmind: 'application/x-xmind',
  mp3: 'audio/mpeg',
  m4a: 'audio/x-m4a',
  wav: 'audio/wav',
  aac: 'audio/aac',
  html: 'text/html',
  htm: 'text/html',
  epub: 'application/epub+zip',
};

/**
 * 断言当前是 ima 官方后端。
 * @param {object} config - 已规范化配置。
 * @param {string} tool - 工具名（拼进错误信息）。
 * @returns {void}
 */
function requireIma(config, tool) {
  if (config.http.preset !== 'ima') {
    throw new Error(`${tool} 需要 http.preset: ima（腾讯 ima 官方 OpenAPI）；generic 后端没有等价接口`);
  }
}

/**
 * 解析知识库：支持 id 或名称，空则要求只有一个库。
 * @param {object} config - 已规范化配置。
 * @param {string} [hint] - id 或名称。
 * @returns {Promise<{id: string, name: string}>} 知识库。
 */
export async function resolveKb(config, hint) {
  const wanted = String(hint ?? config.knowledgeBase ?? '').trim();
  const data = await imaPost(config, 'openapi/wiki/v1/search_knowledge_base', { query: '', cursor: '', limit: 20 });
  const list = (Array.isArray(data?.info_list) ? data.info_list : []).map((kb) => ({ id: kb.kb_id, name: kb.kb_name }));
  const listing = list.map((kb) => `${kb.name}（${kb.id}）`).join('、') || '（无）';
  if (wanted) {
    const hit = list.find((kb) => kb.id === wanted || kb.name === wanted);
    if (!hit) throw new Error(`找不到知识库 ${JSON.stringify(wanted)}；可用：${listing}`);
    return hit;
  }
  if (list.length === 1) return list[0];
  throw new Error(`需要指定知识库（当前有 ${list.length} 个）：${listing}`);
}

// ── 笔记 ────────────────────────────────────────────────────────────────────

/**
 * 列笔记本。
 * @param {object} config - 已规范化配置。
 * @param {{limit?: number}} input - 参数。
 * @returns {Promise<{notebooks: Array<object>, isEnd: boolean}>} 笔记本列表。
 */
export async function listNotebooks(config, input = {}) {
  requireIma(config, 'ima_list_notebooks');
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 20);
  const data = await imaPost(config, 'openapi/note/v1/list_notebook', { cursor: '0', limit });
  const notebooks = (Array.isArray(data?.note_folder_infos) ? data.note_folder_infos : []).map((f) => ({
    id: f.folder_id,
    name: f.name,
    noteCount: Number(f.note_number) || undefined,
    parentId: f.parent_folder_id || undefined,
    type: f.folder_type,
  }));
  return { notebooks, isEnd: data?.is_end !== false };
}

/**
 * 列笔记。
 * @param {object} config - 已规范化配置。
 * @param {{folderId?: string, limit?: number}} input - 参数。
 * @returns {Promise<{notes: Array<object>, isEnd: boolean}>} 笔记列表。
 */
export async function listNotes(config, input = {}) {
  requireIma(config, 'ima_list_notes');
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 20);
  const body = { cursor: '', limit, sort_type: 0 };
  if (input.folderId) body.folder_id = input.folderId;
  const data = await imaPost(config, 'openapi/note/v1/list_note', body);
  const notes = (Array.isArray(data?.note_book_list) ? data.note_book_list : []).map((n) => ({
    noteId: n.note_id,
    title: n.title,
    summary: n.summary || undefined,
    folderId: n.note_ext_info?.folder_id || undefined,
    folderName: n.note_ext_info?.folder_name || undefined,
    modifyTime: Number(n.modify_time) || undefined,
  }));
  return { notes, isEnd: data?.is_end !== false };
}

/**
 * 读笔记正文（纯文本）。
 * @param {object} config - 已规范化配置。
 * @param {{noteId: string}} input - 参数。
 * @returns {Promise<{noteId: string, content: string}>} 笔记内容。
 */
export async function getNote(config, input = {}) {
  requireIma(config, 'ima_get_note');
  const noteId = String(input.noteId || '').trim();
  if (!noteId) throw new Error('ima_get_note 需要 noteId');
  const data = await imaPost(config, 'openapi/note/v1/get_doc_content', { note_id: noteId, target_content_format: 0 });
  return { noteId, content: String(data?.content ?? '') };
}

/**
 * 新建笔记（Markdown）。
 * @param {object} config - 已规范化配置。
 * @param {{content: string, folderId?: string, folderName?: string}} input - 参数。
 * @returns {Promise<{noteId: string, folderName?: string}>} 新笔记。
 */
export async function createNote(config, input = {}) {
  requireIma(config, 'ima_create_note');
  const content = String(input.content ?? '');
  if (!content.trim()) throw new Error('ima_create_note 需要非空 content（Markdown 文本）');
  const body = { content_format: 1, content };
  if (input.folderId) body.folder_id = String(input.folderId).trim();
  if (input.folderName) body.folder_name = String(input.folderName).trim();
  const data = await imaPost(config, 'openapi/note/v1/import_doc', body);
  return { noteId: data?.note_id, folderName: body.folder_name || undefined };
}

/**
 * 追加内容到笔记末尾。
 * @param {object} config - 已规范化配置。
 * @param {{noteId: string, content: string}} input - 参数。
 * @returns {Promise<{noteId: string}>} 目标笔记。
 */
export async function appendNote(config, input = {}) {
  requireIma(config, 'ima_append_note');
  const noteId = String(input.noteId || '').trim();
  const content = String(input.content ?? '');
  if (!noteId) throw new Error('ima_append_note 需要 noteId');
  if (!content.trim()) throw new Error('ima_append_note 需要非空 content');
  const data = await imaPost(config, 'openapi/note/v1/append_doc', { note_id: noteId, content_format: 1, content });
  return { noteId: data?.note_id || noteId };
}

// ── 知识库写入 ──────────────────────────────────────────────────────────────

/**
 * 把一条笔记加进知识库（media_type=11）。
 * @param {object} config - 已规范化配置。
 * @param {{noteId: string, title?: string, knowledgeBase?: string, folderId?: string}} input - 参数。
 * @returns {Promise<{mediaId: string, knowledgeBase: string, knowledgeBaseName: string}>} 结果。
 */
export async function addNoteToKb(config, input = {}) {
  requireIma(config, 'ima_add_note_to_kb');
  const noteId = String(input.noteId || '').trim();
  if (!noteId) throw new Error('ima_add_note_to_kb 需要 noteId（先用 ima_create_note 或 ima_list_notes 拿）');
  const kb = await resolveKb(config, input.knowledgeBase);
  const body = {
    media_type: 11,
    title: String(input.title || '').trim() || '未命名笔记',
    knowledge_base_id: kb.id,
    note_info: { content_id: noteId },
  };
  if (input.folderId) body.folder_id = String(input.folderId).trim();
  const data = await imaPost(config, 'openapi/wiki/v1/add_knowledge', body);
  return { mediaId: data?.media_id, knowledgeBase: kb.id, knowledgeBaseName: kb.name };
}

// ── 文件上传（create_media → COS PUT → add_knowledge）──────────────────────

/** COS 签名用的 HMAC-SHA1。 */
function hmacSha1(key, data) {
  return createHmac('sha1', key).update(data).digest('hex');
}

/** COS 签名用的 SHA1。 */
function sha1(data) {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * 构造 COS PUT 的 Authorization 头（官方算法，见腾讯云 COS 文档 436/7778）。
 * @param {object} options - 签名参数。
 * @returns {string} Authorization 头。
 */
function cosAuthorization({ secretId, secretKey, pathname, headers, startTime, expiredTime }) {
  const keyTime = `${startTime};${expiredTime}`;
  const signKey = hmacSha1(secretKey, keyTime);
  const headerKeys = Object.keys(headers).sort();
  const httpHeaders = headerKeys.map((k) => `${k.toLowerCase()}=${encodeURIComponent(headers[k])}`).join('&');
  const httpString = `put\n${pathname}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signature = hmacSha1(signKey, stringToSign);
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerKeys.map((k) => k.toLowerCase()).join(';')}`,
    'q-url-param-list=',
    `q-signature=${signature}`,
  ].join('&');
}

/**
 * 把文件 PUT 到腾讯云 COS。
 * @param {object} credential - create_media 返回的 cos_credential。
 * @param {Buffer} buffer - 文件内容。
 * @param {string} contentType - MIME。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<void>} 成功返回，失败抛错。
 */
function cosPut(credential, buffer, contentType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const hostname = `${credential.bucket_name}.cos.${credential.region}.myqcloud.com`;
    const pathname = `/${credential.cos_key}`;
    const signHeaders = { 'content-length': String(buffer.length), host: hostname };
    const authorization = cosAuthorization({
      secretId: credential.secret_id,
      secretKey: credential.secret_key,
      pathname,
      headers: signHeaders,
      startTime: String(credential.start_time || Math.floor(Date.now() / 1000)),
      expiredTime: String(credential.expired_time || Math.floor(Date.now() / 1000) + 3600),
    });
    const req = https.request({
      hostname,
      port: 443,
      path: pathname,
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        Authorization: authorization,
        'x-cos-security-token': credential.token,
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`COS 上传失败（HTTP ${res.statusCode}）：${body.slice(0, 300)}`));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`COS 上传超时（${timeoutMs}ms）`)); });
    req.on('error', (error) => reject(new Error(`COS 上传失败：${error?.message ?? error}`)));
    req.write(buffer);
    req.end();
  });
}

/**
 * 上传本地文件到知识库（create_media → COS → add_knowledge）。
 * @param {object} config - 已规范化配置。
 * @param {{filePath: string, title?: string, knowledgeBase?: string, folderId?: string}} input - 参数。
 * @returns {Promise<object>} `{mediaId, title, bytes, mediaType, knowledgeBase, knowledgeBaseName}`。
 */
export async function uploadFile(config, input = {}) {
  requireIma(config, 'ima_upload_file');
  const filePath = String(input.filePath || '').trim();
  if (!filePath) throw new Error('ima_upload_file 需要 filePath（本机文件路径）');
  let stat;
  try {
    stat = statSync(filePath);
  } catch (error) {
    throw new Error(`读不到文件 ${filePath}：${error?.code || error?.message}`);
  }
  if (!stat.isFile()) throw new Error(`不是文件：${filePath}`);

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mediaType = MEDIA_TYPE_BY_EXT[ext];
  if (!mediaType) {
    throw new Error(`不支持的文件类型 .${ext}；支持：${Object.keys(MEDIA_TYPE_BY_EXT).join(', ')}`);
  }
  const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
  const fileName = path.basename(filePath);
  const kb = await resolveKb(config, input.knowledgeBase);
  const buffer = readFileSync(filePath);

  const created = await imaPost(config, 'openapi/wiki/v1/create_media', {
    file_name: fileName,
    file_size: buffer.length,
    content_type: contentType,
    knowledge_base_id: kb.id,
    file_ext: ext,
  });
  const mediaId = created?.media_id;
  const credential = created?.cos_credential;
  if (!mediaId || !credential?.cos_key) {
    throw new Error(`create_media 没有返回 media_id / cos_credential：${JSON.stringify(created).slice(0, 200)}`);
  }

  await cosPut(credential, buffer, contentType, Math.max(config.http.timeoutMs, 300000));

  const body = {
    media_type: mediaType,
    media_id: mediaId,
    title: String(input.title || '').trim() || fileName,
    knowledge_base_id: kb.id,
    file_info: {
      cos_key: credential.cos_key,
      file_size: buffer.length,
      last_modify_time: Math.floor(stat.mtimeMs / 1000),
      file_name: fileName,
    },
  };
  if (input.folderId) body.folder_id = String(input.folderId).trim();
  const added = await imaPost(config, 'openapi/wiki/v1/add_knowledge', body);

  return {
    mediaId: added?.media_id || mediaId,
    title: body.title,
    bytes: buffer.length,
    mediaType,
    knowledgeBase: kb.id,
    knowledgeBaseName: kb.name,
    requestId: randomUUID().slice(0, 8),
  };
}
