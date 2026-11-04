// dsh-ima · 极简 CDP 客户端 + ima 桌面客户端启动器
//
// 为什么走 CDP：本机 `ima.copilot` 是 **Chromium 内核**桌面壳（同目录有 chrome.dll /
// chrome_pwa_launcher.exe，版本目录 150.0.7871.5493），且**默认不监听任何本地端口**。
// 想程序化驱动它，唯一稳定的通道是让它带 `--remote-debugging-port` 启动，然后用
// DevTools Protocol 操作它的页面（注入文本、按键、读回文本）。UIA/截图对 Chromium
// 画布内文本的识别率低，只作为最后手段。
//
// 本文件零第三方依赖：Node ≥22 自带全局 `fetch` 与 `WebSocket`。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/** 常见的 ima 安装位置（自动探测的兜底列表；首选仍是从运行中进程读真实路径）。 */
const KNOWN_WINDOWS_PATHS = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ima', 'ima.copilot.exe'),
  'C:\\Program Files\\Tencent\\ima\\ima.copilot.exe',
  'C:\\Program Files (x86)\\Tencent\\ima\\ima.copilot.exe',
];

const IMA_EXE_NAME = IS_WINDOWS ? 'ima.copilot.exe' : 'ima.copilot';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 跑一个短命令并收集 stdout（失败不抛，返回 `{code, stdout, stderr}`）。
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {number} timeoutMs - 超时毫秒。
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>} 执行结果。
 */
export function run(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ code: null, stdout, stderr: stderr + '\n[timeout]' });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 子进程环境：剥掉宿主为 Electron 设的 `ELECTRON_RUN_AS_NODE`，否则部分发行版
 * 会把继承来的这个变量误解读，导致被拉起的 GUI 应用退化成 node 模式。
 * @returns {NodeJS.ProcessEnv} 过滤后的环境变量。
 */
function childEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

/**
 * 列本机 ima 进程（Windows 用 PowerShell，其它平台用 pgrep）。
 * @returns {Promise<{names: string[], count: number, paths: string[]}>} 进程概况。
 */
export async function listImaProcesses() {
  if (IS_WINDOWS) {
    const ps = [
      '$ErrorActionPreference="SilentlyContinue"',
      `$p = Get-Process -Name 'ima.copilot' -ErrorAction SilentlyContinue`,
      'if (-not $p) { "NONE"; exit 0 }',
      '$p | ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.Path)" }',
    ].join('; ');
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 10000);
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 1 && lines[0] === 'NONE') return { names: [], count: 0, paths: [] };
    const rows = lines.map((line) => {
      const [id, name, path] = line.split('|');
      return { id, name, path };
    }).filter((row) => row.name);
    return {
      names: [...new Set(rows.map((row) => row.name))],
      count: rows.length,
      paths: [...new Set(rows.map((row) => row.path).filter(Boolean))],
    };
  }
  const result = await run('pgrep', ['-fl', IMA_EXE_NAME], 5000);
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { names: lines.length ? [IMA_EXE_NAME] : [], count: lines.length, paths: [] };
}

/**
 * 结束所有 ima 进程。仅在 `restartIfRunning` 打开、且调试端口不可达时调用。
 * @returns {Promise<boolean>} 是否成功发出结束动作。
 */
export async function killIma() {
  if (IS_WINDOWS) {
    const result = await run('taskkill', ['/F', '/T', '/IM', IMA_EXE_NAME], 15000);
    return result.code === 0 || /not found|没有找到/i.test(result.stdout + result.stderr);
  }
  const result = await run('pkill', ['-f', IMA_EXE_NAME], 10000);
  return result.code === 0;
}

/**
 * 探测某个调试端口是否已经在为 ima 提供 CDP。
 * @param {number} port - 调试端口。
 * @param {number} timeoutMs - 请求超时。
 * @returns {Promise<{ok: boolean, version?: object, error?: string}>} 探测结果。
 */
export async function probeCdp(port, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const version = await response.json();
    return { ok: true, version };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 列出调试端口上的页面目标。
 * @param {number} port - 调试端口。
 * @param {number} timeoutMs - 请求超时。
 * @returns {Promise<Array<object>>} CDP target 列表。
 */
export async function listTargets(port, timeoutMs = 3000) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`CDP /json/list 返回 HTTP ${response.status}`);
  return response.json();
}

/**
 * 从 target 列表里挑最像「ima 主界面」的页面。
 * @param {Array<object>} targets - CDP target 列表。
 * @returns {object|undefined} 选中的页面 target。
 */
export function pickAppPage(targets) {
  const pages = (targets || []).filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (pages.length === 0) return undefined;
  const scored = pages.map((page) => {
    const url = String(page.url || '');
    let score = 0;
    if (/ima\.(qq|tencent)\.com|ima\.copilot/i.test(url)) score += 60;
    if (/^https?:/i.test(url)) score += 20;
    if (/^(devtools|chrome-extension|about:)/i.test(url)) score -= 100;
    if (/\/chat|\/index|\/#\//i.test(url)) score += 10;
    if (page.title) score += 5;
    return { page, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.page;
}

/**
 * 找出 ima 可执行文件：优先用配置值，其次从正在运行的进程里读真实路径，
 * 最后回退已知安装位置。
 * @param {string} configured - 配置里写死的路径（可为空）。
 * @param {string[]} runningPaths - 从进程里读到的路径。
 * @returns {string|undefined} 可执行文件路径。
 */
export function resolveExecutable(configured, runningPaths = []) {
  if (configured) return existsSync(configured) ? configured : configured;
  for (const candidate of runningPaths) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  if (IS_WINDOWS) {
    for (const candidate of KNOWN_WINDOWS_PATHS) {
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  return undefined;
}

/**
 * 拉起 ima 并打开调试端口。
 * @param {string} executable - ima 可执行文件。
 * @param {{debugPort: number, userDataDir?: string, extraArgs?: string[]}} options - 启动选项。
 * @returns {{pid: number|undefined, args: string[]}} 启动结果（进程脱离父级，不阻塞宿主退出）。
 */
export function launchIma(executable, options) {
  const args = [`--remote-debugging-port=${options.debugPort}`];
  if (options.userDataDir) args.push(`--user-data-dir=${options.userDataDir}`);
  for (const extra of options.extraArgs || []) args.push(extra);
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: childEnv(),
  });
  child.unref();
  return { pid: child.pid, args };
}

/**
 * 保证调试端口可用：已开则复用；未开则（可选地）结束现有进程后重新拉起。
 * @param {object} config - 已规范化配置。
 * @param {(level: string, message: string) => void} log - 日志函数。
 * @returns {Promise<{port: number, executable?: string, launched: boolean, killed: boolean, version?: object}>} 就绪结果。
 */
export async function ensureCdp(config, log = () => {}) {
  const port = config.app.debugPort;
  const direct = await probeCdp(port);
  if (direct.ok) return { port, launched: false, killed: false, version: direct.version };

  const processes = await listImaProcesses();
  const executable = resolveExecutable(config.app.executable, processes.paths);
  if (!executable) {
    throw new Error(
      '找不到 ima.copilot 可执行文件。请在本插件配置里设置 app.executable，'
      + '例如 "C:\\\\Program Files\\\\Tencent\\\\ima\\\\ima.copilot.exe"（按你的实际安装位置填）。',
    );
  }

  let killed = false;
  if (processes.count > 0) {
    if (!config.app.restartIfRunning) {
      throw new Error(
        `ima 正在运行（${processes.count} 个进程）但没有开放调试端口 ${port}。`
        + 'ima 是 Chromium 壳，只有带 --remote-debugging-port 启动才可程序化驱动；'
        + '请把配置 app.restartIfRunning 设为 true 让插件重启它，或手动关闭 ima 后再调用一次。',
      );
    }
    log('info', `dsh-ima：ima 正在运行但未开放调试端口 ${port}，按配置重启它（会关闭当前 ima 窗口）`);
    killed = await killIma();
    // 等进程真正退出，否则新实例只会把窗口请求转交给旧实例。
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const now = await listImaProcesses();
      if (now.count === 0) break;
      await sleep(300);
    }
  }

  launchIma(executable, { debugPort: port, userDataDir: config.app.userDataDir, extraArgs: config.app.extraArgs });
  const startDeadline = Date.now() + config.app.launchTimeoutMs;
  let lastError = '';
  while (Date.now() < startDeadline) {
    await sleep(400);
    const probe = await probeCdp(port, 1500);
    if (probe.ok) return { port, executable, launched: true, killed, version: probe.version };
    lastError = probe.error || '';
  }
  throw new Error(
    `已拉起 ima 但 ${config.app.launchTimeoutMs}ms 内调试端口 ${port} 仍不可用`
    + (lastError ? `（最后一次错误：${lastError}）` : '')
    + '。若该版本忽略 --remote-debugging-port，请改用 HTTP 后端（配置 http.baseUrl）。',
  );
}

/** 极简 DevTools Protocol 连接：一个页面的 JSON-RPC 通道。 */
export class CdpConnection {
  /** @param {string} wsUrl - 页面级 webSocketDebuggerUrl。 */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.socket = undefined;
  }

  /**
   * 建立连接。
   * @param {string} wsUrl - 页面级 webSocketDebuggerUrl。
   * @param {number} timeoutMs - 连接超时。
   * @returns {Promise<CdpConnection>} 已连接的实例。
   */
  static async open(wsUrl, timeoutMs = 8000) {
    const connection = new CdpConnection(wsUrl);
    await connection.#connect(timeoutMs);
    return connection;
  }

  /**
   * @param {number} timeoutMs - 连接超时。
   * @returns {Promise<void>} 连接就绪。
   */
  #connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch { /* ignore */ }
        reject(new Error(`连接 CDP 超时（${timeoutMs}ms）：${this.wsUrl}`));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', (event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`CDP 连接失败：${event?.message || 'websocket error'}`));
      });
      socket.addEventListener('message', (event) => this.#onMessage(event.data));
      socket.addEventListener('close', () => {
        this.closed = true;
        for (const [, entry] of this.pending) entry.reject(new Error('CDP 连接已关闭'));
        this.pending.clear();
      });
    });
  }

  /**
   * @param {unknown} data - 原始帧。
   * @returns {void}
   */
  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${message.error.message || 'CDP error'}${message.error.data ? `: ${message.error.data}` : ''}`));
    else entry.resolve(message.result);
  }

  /**
   * 发一条 CDP 方法调用。
   * @param {string} method - 例如 `Runtime.evaluate`。
   * @param {object} params - 方法参数。
   * @param {number} timeoutMs - 调用超时。
   * @returns {Promise<any>} 方法结果。
   */
  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * 在页面里求值并返回 JSON 值。
   * @param {string} expression - 浏览器端表达式（最后一句的返回值即为结果）。
   * @param {{awaitPromise?: boolean, timeoutMs?: number}} options - 求值选项。
   * @returns {Promise<unknown>} 结果值（异常会抛成 Error）。
   */
  async evaluate(expression, options = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise === true,
      userGesture: true,
    }, options.timeoutMs ?? 30000);
    if (response?.exceptionDetails) {
      const detail = response.exceptionDetails;
      const text = detail.exception?.description || detail.text || 'evaluate 失败';
      throw new Error(text);
    }
    return response?.result?.value;
  }

  /** 关闭连接。 */
  close() {
    this.closed = true;
    try { this.socket?.close(); } catch { /* ignore */ }
  }
}
