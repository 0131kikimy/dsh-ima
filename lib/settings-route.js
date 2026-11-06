// dsh-ima · 本地设置页路由
//
// 挂在宿主的 webServer 上（与 DSH Web GUI 同一个监听地址），路径 /dsh-ima/settings。
// 只接受带令牌的请求，令牌保存在设置文件里（首次启动生成并持久化），因此 URL 跨重启稳定。

import { readSettings, writeSettings } from './store.js';
import { validateConfig } from './config.js';
import { renderSettingsPage } from './settings-page.js';

const PATH = '/dsh-ima/settings';

/**
 * 发送 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - JSON 可序列化的响应体。
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/**
 * 读取请求体（限制 256KB）。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @returns {Promise<string>} 文本体。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 注册设置页路由。
 * @param {object} options - 依赖注入。
 * @param {object} options.webServer - 宿主 webServer 服务。
 * @param {() => object} options.getConfig - 取当前生效配置。
 * @param {(input: object) => object} options.applySettings - 保存设置并返回生效配置。
 * @param {() => Promise<object>} options.testConnection - 测试两条通道。
 * @param {(level: string, message: string) => void} [options.log] - 日志。
 * @returns {{url: string, dispose: () => void}} 设置页 URL 与注销函数。
 */
export function registerSettingsRoute({ webServer, getConfig, applySettings, testConnection, log = () => {} }) {
  // 首次启动落一次文件，把令牌固定下来（不然每次重启 URL 都会变）。
  const initial = readSettings();
  if (!initial.data || Object.keys(initial.data).filter((k) => !k.startsWith('_')).length === 0) {
    writeSettings({});
  }
  const origin = webServer.getOrigin();
  const url = `${origin}${PATH}?token=${readSettings().token}`;

  // 浏览器端（左侧栏「ima」面板）需要知道设置页地址。这是一个只监听本机的引导接口：
  // 只回 `{url}`，且仅接受来自 127.0.0.1 / ::1 的请求；设置页本身仍然校验令牌。
  const disposePanel = webServer.register({
    kind: 'exact',
    path: '/dsh-ima/panel',
    handler(req, res) {
      const remote = req.socket?.remoteAddress || '';
      if (!/^(127\.|::1$|::ffff:127\.)/.test(remote)) {
        sendJson(res, 403, { ok: false, error: 'only localhost' });
        return;
      }
      sendJson(res, 200, { ok: true, url: `${origin}${PATH}?token=${readSettings().token}` });
    },
  });

  const dispose = webServer.register({
    kind: 'exact',
    path: PATH,
    async handler(req, res) {
      let urlObj;
      try {
        urlObj = new URL(req.url || PATH, origin);
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad url' });
        return;
      }
      if (urlObj.searchParams.get('token') !== readSettings().token) {
        sendJson(res, 403, { ok: false, error: '令牌无效：请用 ima_health 返回的 settingsUrl 打开本页' });
        return;
      }

      if (req.method === 'GET') {
        if (urlObj.searchParams.get('json') === '1') {
          const config = getConfig();
          sendJson(res, 200, { ok: true, config: { ...config, http: { ...config.http, apiKey: config.http.apiKey ? '***' : '' } } });
          return;
        }
        if (urlObj.searchParams.get('test') === '1') {
          try {
            const result = await testConnection();
            sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderSettingsPage(getConfig(), readSettings().token, { origin }));
        return;
      }

      if (req.method === 'POST') {
        let posted;
        try {
          posted = JSON.parse(await readBody(req));
        } catch (error) {
          sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${String(error?.message ?? error)}` });
          return;
        }
        if (!posted || typeof posted !== 'object' || Array.isArray(posted)) {
          sendJson(res, 400, { ok: false, error: '请求体必须是对象' });
          return;
        }
        // 先校验「base 配置 + 提交值」的合并结果，避免把非法值写进文件。
        const candidate = applySettings(posted, { dryRun: true });
        if (candidate.issues) {
          sendJson(res, 400, { ok: false, issues: candidate.issues });
          return;
        }
        const effective = applySettings(posted);
        log('info', 'dsh-ima: 设置页已保存配置');
        sendJson(res, 200, { ok: true, effective });
        return;
      }

      sendJson(res, 405, { ok: false, error: 'method not allowed' });
    },
  });

  return {
    url,
    dispose: () => {
      try { dispose(); } catch { /* 已随宿主撤销 */ }
      try { disposePanel(); } catch { /* 已随宿主撤销 */ }
    },
  };
}

export { PATH as SETTINGS_PATH };
