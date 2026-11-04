// 开发期探针：实测 listDocs / getDoc（用本机 settings.json 里的凭据，不写日志）
// 用法：node test/probe-docs.mjs [知识库名或id]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { listDocs, getDoc } from '../lib/http.js';

const settingsPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-ima', 'settings.json');
const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const config = resolveConfig({
  backend: 'http',
  http: { preset: 'ima', clientId: saved.http?.clientId, apiKey: saved.http?.apiKey },
});

const kbName = process.argv[2] || 'AI通识课';

console.log('=== listDocs(' + kbName + ') ===');
const listed = await listDocs(config, { knowledgeBase: kbName, limit: 50 });
console.log(JSON.stringify({
  kb: listed.knowledgeBase,
  kbName: listed.knowledgeBaseName,
  docs: listed.total,
  folders: listed.foldersScanned,
  pages: listed.pages,
  truncated: listed.truncated,
}, null, 2));
for (const d of listed.docs.slice(0, 8)) console.log('  -', d.title, '|', d.mediaType, '|', d.mediaId.slice(0, 24) + '…');

const pdf = listed.docs.find((d) => /\.pdf$/i.test(d.title || '')) || listed.docs[0];
if (!pdf) {
  console.log('没有可读文档，结束');
  process.exit(0);
}

console.log('\n=== getDoc(' + pdf.title + ') ===');
const doc = await getDoc(config, { mediaId: pdf.mediaId, maxChars: 1200 });
console.log(JSON.stringify({
  title: doc.title,
  bytes: doc.bytes,
  extractor: doc.extractor,
  textChars: doc.textChars,
  textTruncated: doc.textTruncated,
  extractError: doc.extractError,
  savedPath: doc.savedPath,
}, null, 2));
if (doc.text) {
  console.log('--- 正文前 500 字 ---');
  console.log(doc.text.slice(0, 500));
}
