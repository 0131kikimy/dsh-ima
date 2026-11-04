// dsh-ima · 面向设置的配置 Schema
//
// 为什么要单独一个文件：纯对象 `~standard` 校验器（config.js 的 `Config`）能让非法配置
// 在加载期响亮失败，但宿主拿不到 **JSON Schema**，设置面板里就显示 `status: unsupported`
// ——用户没有表单可填（而本插件恰恰需要用户填 `http.baseUrl`）。
//
// 这里用宿主自带的 `@deepseek-ai/schemastery` 生成真正带默认值与描述的表单 schema。
// **动态 import + 失败回退**是刻意的：schemastery 在 pnpm 严格依赖下不保证可解析，
// 解析不到就退回纯对象校验器——插件功能不受影响，只是设置面板没有表单。

import { Config as PlainConfig } from './config.js';

/**
 * 尝试构造 schemastery 版 Config。
 * @returns {Promise<object>} schemastery schema；不可用时返回带 `~standard` 的纯对象。
 */
async function buildConfig() {
  let mod;
  try {
    mod = await import('@deepseek-ai/schemastery');
  } catch {
    return PlainConfig;
  }
  // schemastery 在不同打包形态下的导出位置不一样（CJS 直出 / default / 嵌套 default），
  // 逐个形态探一下，拿到第一个真正带 `.object()` 的对象。
  const candidates = [mod?.default, mod?.default?.default, mod?.schemastery, mod?.Schema, mod];
  let z;
  for (const candidate of candidates) {
    if (candidate && typeof candidate.object === 'function' && typeof candidate.string === 'function') {
      z = candidate;
      break;
    }
  }
  if (!z) return PlainConfig;
  try {
    return z.object({
      backend: z.union([z.const('auto'), z.const('http'), z.const('app')]).default('auto')
        .description('后端选择：auto = 配了 http.baseUrl 走 HTTP，否则走本机 ima 客户端 / auto | http | app'),
      knowledgeBase: z.string().default('')
        .description('默认知识库（id 或名称）；留空则不限定'),
      topK: z.number().min(1).max(50).default(8)
        .description('检索/提问默认条数'),
      quiet: z.boolean().default(false)
        .description('安静模式：不打印启动日志'),
      http: z.object({
        preset: z.union([z.const('generic'), z.const('ima')]).default('generic')
          .description('generic = 自填路径与字段映射；ima = 腾讯 ima 官方 OpenAPI'),
        clientId: z.string().default('')
          .description('ima 官方 OpenAPI 的 Client ID（在 ima.qq.com/agent-interface 获取）'),
        apiKey: z.string().default('')
          .description('ima 官方 OpenAPI 的 API Key（同上；只存本机配置）'),
        skillVersion: z.string().default('1.1.10')
          .description('作为 ima-openapi-ctx 上报的技能版本'),
        baseUrl: z.string().default('')
          .description('generic 预设的接口根地址；ima 预设留空即用 https://ima.qq.com'),
        token: z.string().default('')
          .description('接口鉴权 token（只存在本机配置里，不会回显到工具结果）'),
        authHeader: z.string().default('Authorization')
          .description('鉴权头名称'),
        authScheme: z.string().default('Bearer ')
          .description('鉴权前缀（Bearer 后带空格；不需要前缀就留空）'),
        timeoutMs: z.number().min(1000).max(600000).default(60000)
          .description('单次 HTTP 超时（毫秒）'),
        paths: z.object({
          ask: z.string().default('/v1/ask'),
          search: z.string().default('/v1/search'),
          kbList: z.string().default('/v1/knowledge_bases'),
          import: z.string().default('/v1/documents'),
        }).description('各接口路径（以 / 开头）'),
        mapping: z.object({
          answer: z.string().default('answer'),
          citations: z.string().default('citations'),
          hits: z.string().default('hits'),
          hitTitle: z.string().default('title'),
          hitSnippet: z.string().default('snippet'),
          hitUrl: z.string().default('url'),
          hitScore: z.string().default('score'),
        }).description('响应字段路径（支持 a.b[0].c；如 OpenAI 兼容写 choices[0].message.content）'),
      }).description('HTTP 后端配置'),
      app: z.object({
        executable: z.string().default('')
          .description('ima.copilot.exe 路径；留空自动探测'),
        launchTimeoutMs: z.number().min(1000).max(180000).default(20000)
          .description('拉起后等待主窗口的超时（毫秒）'),
        allowDelivery: z.boolean().default(false)
          .description('实验性：允许把问题「投递」到 ima 窗口（猜输入框位置+模拟击键，实测不可靠；默认关闭）'),
        debugPort: z.number().min(1024).max(65535).default(9333)
          .description('仅用于体检：该版本实测忽略 --remote-debugging-port，这里只报告端口是否恰好可达'),
      }).description('桌面客户端配置'),
    });
  } catch {
    return PlainConfig;
  }
}

export const Config = await buildConfig();

/** 设置面板是否拿到了真正的 schema（false = 退回纯对象校验器，只能改 YAML）。 */
export const hasSettingsForm = Config !== PlainConfig;
