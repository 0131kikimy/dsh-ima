// dsh-ima 自检（不依赖宿主）：
//   1) 配置校验：合法/非法都能给出确定结论
//   2) HTTP 后端：起一个本地 mock 接口，真跑通 ask / search / kb_list / import 四条路径
//   3) 桌面后端：真调一次 PowerShell status（只读，不改任何状态）
// 用法：node test/selfcheck.mjs
import http from 'node:http';
import { resolveConfig, getByPath, maskSecret } from '../lib/config.js';
import * as httpBackend from '../lib/http.js';
import * as appBackend from '../lib/app.js';

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? `：${detail}` : ''}`); }
}

console.log('── 1. 配置校验 ───────────────────────────────');
{
  const good = resolveConfig({ backend: 'http', http: { baseUrl: 'http://127.0.0.1:1/', token: 'abc' } });
  check('合法配置被规范化', good.http.baseUrl === 'http://127.0.0.1:1' && good.topK === 8, JSON.stringify(good.http));
  check('默认后端解析', resolveConfig({}).backend === 'auto');

  const badIssues = resolveConfig({}).constructor; void badIssues; // 占位，避免误用
  let threw = false;
  try { resolveConfig({ backend: 'nope' }); } catch { threw = true; }
  check('非法 backend 在 resolveConfig 抛错', threw);
  threw = false;
  try { resolveConfig({ http: { baseUrl: 'ftp://x' } }); } catch { threw = true; }
  check('非法 baseUrl 在 resolveConfig 抛错', threw);
  check('getByPath 支持下标', getByPath({ choices: [{ message: { content: 'hi' } }] }, 'choices[0].message.content') === 'hi');
  check('maskSecret 不打全码', maskSecret('sk-1234567890').includes('***'));
}

console.log('── 2. HTTP 后端（本地 mock）──────────────────');
const TOKEN = 'test-token-123';
const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad token' }));
      return;
    }
    const payload = body ? JSON.parse(body) : {};
    received.push({ method: req.method, url: req.url, payload });
    const send = (value) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/v1/ask' && req.method === 'POST') {
      send({ answer: `关于「${payload.question}」的答案`, citations: [{ title: '文档A', url: 'https://example.com/a', snippet: '片段A' }] });
    } else if (req.url === '/v1/search' && req.method === 'POST') {
      send({ hits: [{ title: '命中1', snippet: '内容1', url: 'https://example.com/1', score: 0.9 }, { title: '命中2', snippet: '内容2' }] });
    } else if (req.url === '/v1/knowledge_bases' && req.method === 'GET') {
      send({ knowledge_bases: [{ id: 'kb1', name: '我的知识库', doc_count: 12 }] });
    } else if (req.url === '/v1/documents' && req.method === 'POST') {
      send({ id: 'doc-9', status: 'accepted' });
    } else {
      res.writeHead(404); res.end('{}');
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const config = resolveConfig({
  backend: 'http',
  http: { baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 5000 },
  knowledgeBase: 'kb1',
  topK: 3,
});

try {
  const health = await httpBackend.health(config);
  check('health 报告可达', health.reachable === true, JSON.stringify(health));

  const ask = await httpBackend.ask(config, { question: '什么是知识库' });
  check('ask 返回答案', ask.answer.includes('什么是知识库'), JSON.stringify(ask));
  check('ask 解析出引用', ask.citations.length === 1 && ask.citations[0].title === '文档A', JSON.stringify(ask.citations));
  check('ask 带上默认知识库', received.find((r) => r.url === '/v1/ask').payload.knowledge_base === 'kb1');

  const search = await httpBackend.search(config, { query: '检索词' });
  check('search 返回 2 条命中', search.hits.length === 2, JSON.stringify(search.hits));
  check('search 字段映射正确', search.hits[0].score === 0.9 && search.hits[0].url === 'https://example.com/1');

  const kb = await httpBackend.kbList(config);
  check('kb_list 返回知识库', kb.knowledgeBases.length === 1 && kb.knowledgeBases[0].count === 12, JSON.stringify(kb));

  const imported = await httpBackend.importItem(config, { url: 'https://example.com/new' });
  check('import 返回 id/status', imported.id === 'doc-9' && imported.status === 'accepted', JSON.stringify(imported));

  const wrong = resolveConfig({ backend: 'http', http: { baseUrl: `http://127.0.0.1:${port}`, token: 'wrong', timeoutMs: 3000 } });
  let authError = '';
  try { await httpBackend.kbList(wrong); } catch (error) { authError = String(error.message); }
  check('鉴权失败报清晰错误', authError.includes('401'), authError);

  const dead = resolveConfig({ backend: 'http', http: { baseUrl: 'http://127.0.0.1:9', timeoutMs: 1500 } });
  let connError = '';
  try { await httpBackend.kbList(dead); } catch (error) { connError = String(error.message); }
  check('连接失败报清晰错误', /无法连接|fetch|ECONN/i.test(connError), connError);
} finally {
  server.close();
}

console.log('── 3. 桌面后端（真实调用，只读）──────────────');
try {
  const appConfig = resolveConfig({ backend: 'app' });
  const appHealth = await appBackend.health(appConfig);
  check('桌面后端返回体检结果', typeof appHealth === 'object' && 'reachable' in appHealth, JSON.stringify(appHealth).slice(0, 200));
  check('桌面后端明确声明不能读回', appHealth.readBack === false);
  console.log(`     进程=${appHealth.processCount ?? '?'} 窗口=${appHealth.hasWindow ?? '?'} 可见=${appHealth.visible ?? '?'} 可执行=${appHealth.executable || '未找到'}`);
} catch (error) {
  check('桌面后端体检不抛错', false, String(error.message));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
