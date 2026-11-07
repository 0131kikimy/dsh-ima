// dsh-ima · 正文抽取（零第三方依赖）
//
// ima_get_doc 下载到原件后，按扩展名抽文字：
//   pdf            → 外部 pdftotext（见 http.js）
//   docx/pptx/xlsx → 自己解 ZIP 再读 XML（本文件）
//   md/txt/csv     → 直接读文本
//   html/htm       → 去标签
//   图片等         → 不解析，如实回报
//
// 为什么自己解 ZIP：docx/pptx/xlsx 本质是 ZIP + XML，Node 自带 zlib 就够；
// 引一个 npm 依赖会把「零依赖、装上即用」这条卖点弄丢。

import { inflateRawSync } from 'node:zlib';

/** ZIP 中央目录条目签名。 */
const SIG_CENTRAL = 0x02014b50;
/** ZIP 本地文件头签名。 */
const SIG_LOCAL = 0x04034b50;
/** ZIP 结束记录签名。 */
const SIG_EOCD = 0x06054b50;

/**
 * 解析 ZIP，返回「条目名 → Buffer」的读取器（按需解压）。
 * @param {Buffer} buffer - 整个 zip 文件。
 * @returns {(name: string) => Buffer|undefined} 取条目内容的函数。
 */
export function zipReader(buffer) {
  // 从尾部往前找 EOCD（最多回退 66KB，注释上限 65535）
  let eocd = -1;
  const minPos = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minPos; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到中央目录结尾）');

  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  const entries = new Map();
  let p = centralOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== SIG_CENTRAL) break;
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return (name) => {
    const entry = entries.get(name);
    if (!entry) return undefined;
    const lo = entry.localOffset;
    if (buffer.readUInt32LE(lo) !== SIG_LOCAL) return undefined;
    const nameLen = buffer.readUInt16LE(lo + 26);
    const extraLen = buffer.readUInt16LE(lo + 28);
    const start = lo + 30 + nameLen + extraLen;
    const raw = buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`ZIP 压缩方式 ${entry.method} 不支持`);
  };
}

/** 列 ZIP 里的条目名。 */
export function zipNames(buffer) {
  const out = [];
  const reader = zipReader(buffer);
  // reader 只按名取；这里为了列名，重新解析一次条目表
  let eocd = -1;
  const minPos = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minPos; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== SIG_CENTRAL) break;
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    out.push(buffer.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  void reader;
  return out;
}

/** 解 XML 实体。 */
function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

/**
 * 把 XML 里的文本节点拼出来（段落换行）。
 * @param {string} xml - XML 文本。
 * @param {string} textTag - 文本标签名（如 `w:t` / `a:t` / `t`）。
 * @param {string} paraTag - 段落结束标签（如 `w:p` / `a:p`）。
 * @returns {string} 纯文本。
 */
function collectXmlText(xml, textTag, paraTag) {
  const withBreaks = xml
    .replace(new RegExp(`</${paraTag}>`, 'g'), '\n')
    .replace(new RegExp(`<${paraTag}[^>]*/>`, 'g'), '\n');
  const re = new RegExp(`<${textTag}[^>]*>([\\s\\S]*?)</${textTag}>`, 'g');
  let out = '';
  let m;
  let lastIndex = 0;
  // 保留段落换行：把标签之间的换行标记也带上
  const parts = [];
  while ((m = re.exec(withBreaks)) !== null) {
    const between = withBreaks.slice(lastIndex, m.index);
    const breaks = (between.match(/\n/g) || []).length;
    if (breaks) parts.push('\n'.repeat(breaks));
    parts.push(unescapeXml(m[1]));
    lastIndex = m.index + m[0].length;
  }
  out = parts.join('');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** docx：读 word/document.xml。 */
function extractDocx(buffer) {
  const read = zipReader(buffer);
  const xml = read('word/document.xml');
  if (!xml) throw new Error('docx 里没有 word/document.xml（可能不是真正的 docx）');
  return collectXmlText(xml.toString('utf8'), 'w:t', 'w:p');
}

/** pptx：按页码顺序读每张幻灯片的文本。 */
function extractPptx(buffer) {
  const read = zipReader(buffer);
  const names = zipNames(buffer)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  if (names.length === 0) throw new Error('pptx 里没有幻灯片 XML');
  const slides = [];
  for (const name of names) {
    const xml = read(name);
    if (!xml) continue;
    const text = collectXmlText(xml.toString('utf8'), 'a:t', 'a:p');
    if (text.trim()) slides.push(`【第 ${slides.length + 1} 页】\n${text}`);
  }
  return slides.join('\n\n');
}

/** xlsx：读 sharedStrings + 各 sheet 的单元格文本。 */
function extractXlsx(buffer) {
  const read = zipReader(buffer);
  const shared = read('xl/sharedStrings.xml');
  const pool = [];
  if (shared) {
    const xml = shared.toString('utf8');
    const re = /<si[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1]));
      pool.push(texts.join(''));
    }
  }
  const names = zipNames(buffer).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/sheet(\d+)/)[1]) - Number(b.match(/sheet(\d+)/)[1]));
  const lines = [];
  for (const name of names) {
    const xml = read(name);
    if (!xml) continue;
    const src = xml.toString('utf8');
    const rows = [...src.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<c[^>]*?(?:t="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)].map((cell) => {
        const type = cell[1];
        const value = (cell[2].match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        const inline = (cell[2].match(/<is[^>]*>([\s\S]*?)<\/is>/) || [])[1];
        if (type === 's' && value !== undefined) return pool[Number(value)] ?? '';
        if (inline) return unescapeXml((inline.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
        return value !== undefined ? unescapeXml(value) : '';
      });
      const line = cells.filter((c) => c !== '').join('\t');
      if (line.trim()) lines.push(line);
    }
  }
  if (!lines.length && pool.length) return pool.join('\n');
  return lines.join('\n');
}

/** HTML：去脚本样式与标签。 */
function extractHtml(text) {
  const stripped = String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return unescapeXml(stripped).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 按扩展名抽正文。
 * @param {Buffer} buffer - 文件内容。
 * @param {string} ext - 扩展名（含点号，小写）。
 * @param {number} maxChars - 返回字数上限。
 * @returns {{extractor: string, text?: string, textChars?: number, textTruncated?: boolean, extractError?: string}} 抽取结果。
 */
export function extractByExtension(buffer, ext, maxChars) {
  const lower = String(ext || '').toLowerCase();
  let text = '';
  try {
    if (lower === '.docx') text = extractDocx(buffer);
    else if (lower === '.pptx') text = extractPptx(buffer);
    else if (lower === '.xlsx') text = extractXlsx(buffer);
    else if (lower === '.html' || lower === '.htm') text = extractHtml(buffer.toString('utf8'));
    else if (lower === '.md' || lower === '.markdown' || lower === '.txt' || lower === '.csv') {
      text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    } else {
      return { extractor: 'skipped', extractError: `不解析 ${lower || '(无扩展名)'}；原件已保存，请自行查看` };
    }
  } catch (error) {
    return { extractor: 'failed', extractError: `解析 ${lower} 失败：${error?.message ?? error}` };
  }
  if (!text || !text.trim()) {
    return { extractor: lower.replace('.', ''), extractError: '抽到 0 字（可能是纯图片/扫描件，需要 OCR）' };
  }
  return {
    extractor: lower.replace('.', ''),
    text: text.slice(0, maxChars),
    textChars: text.length,
    textTruncated: text.length > maxChars,
  };
}
