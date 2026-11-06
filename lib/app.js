// dsh-ima · 桌面客户端后端（只做能稳定做到的事）
//
// 能力边界（实测结论）：
//   ✅ 进程/窗口体检（status）
//   ✅ 拉起与唤起（ensure / open），支持 ima 注册的 `imacopilot://` 深链接
//   ❌ 读回答案 / 列知识库 / 写入——该客户端不开放 DOM，也不开 CDP
//      （干净环境 + 独立 user-data-dir + --remote-debugging-port 实测仍无 DevToolsActivePort）
//
// 所以：**要数据（检索结果、正文、知识库列表）一律走 HTTP 后端**；
// 桌面端只负责"把 ima 打开给你看"。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(new URL('./ps/ima-app.ps1', import.meta.url));

/**
 * 调一次 PowerShell 动作脚本并解析它输出的单行 JSON。
 * @param {object} config - 已规范化配置。
 * @param {string} action - status | ensure | open。
 * @param {{url?: string}} extra - 动作附加参数。
 * @param {number} timeoutMs - 子进程超时。
 * @returns {Promise<object>} 脚本返回的 JSON。
 */
export function runAction(config, action, extra = {}, timeoutMs = 45000) {
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT_PATH,
    '-Action', action,
    '-LaunchTimeoutMs', String(config.app.launchTimeoutMs),
  ];
  if (config.app.executable) args.push('-Executable', config.app.executable);
  if (extra.url) args.push('-Url', extra.url);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('powershell.exe', args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: (() => { const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; return env; })(),
      });
    } catch (error) {
      reject(new Error(`无法启动 PowerShell：${error?.message ?? error}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出 */ }
      reject(new Error(`ima 桌面操作超时（${timeoutMs}ms，action=${action}）`));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`PowerShell 启动失败：${error?.message ?? error}`));
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean).pop();
      if (!line) {
        reject(new Error(`ima 桌面操作没有返回 JSON（action=${action}）${stderr ? `：${stderr.slice(0, 300)}` : ''}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        reject(new Error(`ima 桌面操作返回了非 JSON 输出：${line.slice(0, 300)}`));
        return;
      }
      if (parsed.ok === false) {
        reject(new Error(parsed.error || `ima 桌面操作失败（action=${action}）`));
        return;
      }
      resolve(parsed);
    });
  });
}

/**
 * 体检桌面端：进程、窗口、可执行文件。
 * @param {object} config - 已规范化配置。
 * @returns {Promise<object>} 桌面后端状态。
 */
export async function health(config) {
  try {
    const status = await runAction(config, 'status', {}, 30000);
    return {
      reachable: status.running === true,
      executable: status.executable,
      running: status.running,
      processCount: status.processCount,
      hasWindow: status.hasWindow,
      visible: status.visible,
      title: status.title,
      windowHandle: status.windowHandle,
      rect: status.rect,
      note: status.running
        ? (status.hasWindow ? 'ima 已打开。' : 'ima 在跑但窗口在托盘；ima_open 可以把它叫出来。')
        : 'ima 没在运行；ima_open 会自动拉起它。',
    };
  } catch (error) {
    return {
      reachable: false,
      error: String(error?.message ?? error),
      note: '桌面端不可用；不影响 HTTP 通道（知识库/检索/正文都能用）。',
    };
  }
}

/**
 * 唤起 ima（必要时拉起），可选打开一个 URL。
 * @param {object} config - 已规范化配置。
 * @param {{url?: string}} input - 唤起参数。
 * @returns {Promise<object>} 唤起结果。
 */
export async function open(config, input = {}) {
  const result = await runAction(config, 'open', { url: input.url }, 60000);
  return {
    opened: true,
    url: result.url || '',
    visible: result.visible === true,
    windowHandle: result.windowHandle,
    title: result.title,
  };
}
