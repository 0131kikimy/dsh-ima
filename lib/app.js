// dsh-ima · 桌面客户端后端
//
// 能力边界（全部经本机实测，不写推测）：
//   ✅ 进程/窗口体检（status）
//   ✅ 拉起与唤起（ensure / open），支持 ima 注册的 `imacopilot://` 深链接
//   ⚠️ 投递问题（ask）——实验性：点击输入区 + 粘贴 + 回车；**不读回答案**
//   ❌ 读回结构化答案 / 列知识库 / 写入知识库——该构建不暴露 DOM，也不开 CDP
//        （实测：干净环境 + 独立 user-data-dir + --remote-debugging-port，
//         29 个进程起来但端口与 DevToolsActivePort 都不存在）
//
// 需要读回数据的一律走 HTTP 后端；这里的失败信息必须明确指向那条路，不能让模型以为
// 「桌面后端能做问答」。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeCdp } from './cdp.js';

const SCRIPT_PATH = fileURLToPath(new URL('./ps/ima-app.ps1', import.meta.url));

/**
 * 调一次 PowerShell 动作脚本并解析它输出的单行 JSON。
 * @param {object} config - 已规范化配置。
 * @param {string} action - status | ensure | open | ask。
 * @param {{url?: string, question?: string}} extra - 动作附加参数。
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
  if (extra.question) args.push('-Question', extra.question);
  if (extra.dryRun) args.push('-DryRun');

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
 * 体检。
 * @param {object} config - 已规范化配置。
 * @returns {Promise<object>} 桌面后端状态。
 */
export async function health(config) {
  const cdp = await probeCdp(config.app.debugPort, 800);
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
      cdp: { port: config.app.debugPort, reachable: cdp.ok === true },
      readBack: false,
      note: status.hasWindow
        ? '桌面客户端可唤起、可投递问题，但**不能读回答案**（该构建不暴露 DOM、不开 CDP）。'
        : 'ima 在运行但没有可见主窗口（可能驻留托盘）；调用 ima_open 可拉起并唤起。',
    };
  } catch (error) {
    return {
      reachable: false,
      cdp: { port: config.app.debugPort, reachable: cdp.ok === true },
      readBack: false,
      error: String(error?.message ?? error),
      note: '桌面后端不可用；请检查 app.executable 配置，或改用 HTTP 后端（http.baseUrl）。',
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

/**
 * 把问题投递到 ima 输入框（不读回答案）。
 *
 * 安全模型：桌面端盲打键盘代价太高，所以脚本在**点击前**校验 `WindowFromPoint` 的归属 PID、
 * 在**每次击键前**校验 `GetForegroundWindow`，任一不满足就抛错而不是继续输入；
 * `dryRun` 只走校验与坐标计算，不点击、不输入。
 *
 * @param {object} config - 已规范化配置。
 * @param {{question: string, dryRun?: boolean}} input - 问题与是否演练。
 * @returns {Promise<object>} 投递结果（含校验事实）。
 */
export async function deliver(config, input) {
  const result = await runAction(config, 'ask', {
    question: input.question,
    dryRun: input.dryRun === true,
  }, 90000);
  return {
    delivered: result.delivered === true,
    readBack: false,
    dryRun: result.dryRun === true,
    foregroundVerified: result.foregroundVerified === true,
    pointPid: result.pointPid,
    deliveredWhileImaForeground: result.deliveredWhileImaForeground,
    click: result.click,
    rect: result.rect,
    note: result.dryRun === true
      ? '演练完成：坐标与归属校验通过，未点击、未输入。'
      : '已把问题投递到 ima 输入框并回车；该客户端不开放 DOM/CDP，无法读回答案。',
  };
}
