// dsh-ima · 本机设置存储
//
// 为什么要自己存一份：宿主把插件的 Config 投影成设置表单需要 schemastery 能被宿主进程解析，
// 而在 `link:` 安装方式下这一步不可靠（宿主报 status: unsupported）。与其依赖宿主内部机制，
// 本插件自带一个本地设置页（见 settings-route.js），把用户填的值写到 $DSH_HOME/dsh-ima/settings.json。
//
// 合并规则：**设置页保存的值优先于 cordis.patch.yml 里的 config**。
// 每次读取都按 mtime 判断是否需要重读，所以保存后不需要重启插件。

import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 设置目录：优先 $DSH_HOME/dsh-ima，回退 ~/.dsh/dsh-ima。 */
export function settingsDir() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  return path.join(home, 'dsh-ima');
}

/** 设置文件路径。 */
export function settingsFile() {
  return path.join(settingsDir(), 'settings.json');
}

const cache = { mtimeMs: 0, data: undefined, token: undefined };

/**
 * 读取设置文件（带 mtime 缓存）。
 * @returns {{data: object, token: string}} 已保存的设置与本地页面令牌；文件不存在时 data 为 {}。
 */
export function readSettings() {
  const file = settingsFile();
  let stat;
  try {
    stat = statSync(file);
  } catch {
    if (cache.token === undefined) cache.token = randomBytes(16).toString('hex');
    return { data: {}, token: cache.token };
  }
  if (stat.mtimeMs !== cache.mtimeMs) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      cache.data = parsed && typeof parsed === 'object' ? parsed : {};
      cache.token = typeof cache.data._token === 'string' && cache.data._token ? cache.data._token : randomBytes(16).toString('hex');
      cache.mtimeMs = stat.mtimeMs;
    } catch {
      cache.data = {};
      if (cache.token === undefined) cache.token = randomBytes(16).toString('hex');
    }
  }
  return { data: cache.data || {}, token: cache.token || (cache.token = randomBytes(16).toString('hex')) };
}

/**
 * 原子写入设置（含稳定的页面令牌）。
 * @param {object} next - 要保存的设置。
 * @returns {{data: object, token: string}} 落盘后的设置。
 */
export function writeSettings(next) {
  const dir = settingsDir();
  mkdirSync(dir, { recursive: true });
  const { token } = readSettings();
  const data = { ...(next && typeof next === 'object' ? next : {}) };
  delete data._token;
  const payload = { ...data, _token: token, _savedAt: new Date().toISOString() };
  const file = settingsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  cache.mtimeMs = 0;
  return readSettings();
}

/**
 * 深合并：把已保存设置叠到 cordis 传入的 config 上（保存值优先）。
 * @param {object} base - cordis 配置。
 * @param {object} saved - 设置页保存的值。
 * @returns {object} 合并结果。
 */
export function mergeSettings(base, saved) {
  const merge = (target, source) => {
    const out = { ...(target || {}) };
    for (const [key, value] of Object.entries(source || {})) {
      if (key.startsWith('_')) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = merge(out[key], value);
      } else if (value !== undefined && value !== '' && value !== null) {
        out[key] = value;
      }
    }
    return out;
  };
  return merge(base, saved);
}
