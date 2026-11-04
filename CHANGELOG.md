# CHANGELOG

## 0.3.0

### 新增

- **`ima_list_docs`**：列知识库内文档/文件夹（递归、分页、mediaId / 所在路径），补上"能看见库里有什么"的缺口。
- **`ima_get_doc`**：按 mediaId 取正文 —— `get_media_info` 拿签名链接 → 下载原件 → 落临时文件 →
  `pdftotext` 抽 PDF 文本；抽不出时如实回报 `extractor: unavailable` / `extractError`（扫描版需要 OCR），
  签名 URL 不进工具输出。非 PDF 只下载原件，不自作解析。
- 这两个工具让「必须引用原文」的任务（知识卡片、备课摘要、逐字核对引用）真正能由插件完成；
  此前 `ima_search` 只返回标题，这类任务只能手工绕过插件。
- 依赖 `pdftotext`（poppler / xpdf），可用环境变量 `DSH_IMA_PDFTOTEXT` 指定可执行文件路径；缺失时降级为"只下载原件"。

### 修复

- `lib/http.js` 缺失 4 组 `node:` 内置模块 import，导致上述两个函数在调用时抛 `ReferenceError`。

## 0.2.0

### 新增

- **可视化设置页**：`ima_settings` 返回本机设置页地址，可在浏览器里填写 Client ID / API Key /
  baseUrl / 默认知识库 / topK / 客户端路径；保存即生效（写 `$DSH_HOME/dsh-ima/settings.json`），
  并带「测试连接」（同时探测 HTTP 与桌面两条通道）。令牌鉴权，仅本机可访问。
- `http.preset: ima` —— 直接接**腾讯 ima 官方 OpenAPI**（协议取自官方 `ima-skills` 包里的
  `ima_api.cjs`：`POST https://ima.qq.com/<apiPath>`，头 `ima-openapi-clientid` /
  `ima-openapi-apikey` / `ima-openapi-ctx`）。
  - `ima_kb_list` → `openapi/wiki/v1/search_knowledge_base`
  - `ima_search` → `openapi/wiki/v1/search_knowledge`（未指定知识库时按前 5 个库检索后合并）
  - `ima_ask` → 检索汇总（官方接口**无问答生成**，答案首行如实标注）
  - `ima_import` → `openapi/wiki/v1/import_urls`
- `http.headers` —— 任意附加请求头，非 Bearer 鉴权（`X-Client-Id` / `X-Api-Key` 等）无需改代码。
- `http.clientId` / `http.apiKey` / `http.skillVersion` 配置项。

## 0.1.0

首个可用版本：把腾讯 ima 知识库暴露为 DSH 原生工具。

### 新增

- 六个工具：`ima_health` / `ima_open` / `ima_ask` / `ima_search` / `ima_kb_list` / `ima_import`。
- HTTP 后端：问答、检索、列库、写入；路径与响应字段全部可配（`http.paths` / `http.mapping`），
  兼容 `choices[0].message.content` 这类 OpenAI 形状。
- 桌面后端：进程/窗口体检、托盘窗口唤起（`EnumWindows` + `ShowWindow`）、
  窗口跑出屏幕外时自动摆回、`imacopilot://` 深链接打开网址。
- 桌面键盘输入的三道前置校验（DPI 感知 / 点击点归属 / 击键前台）+ `dryRun` 演练。
- 工具返回值统一深剪枝，避免 `undefined` 字段触发宿主"非无损 JSON"校验失败。
- 自检脚本 `test/selfcheck.mjs`（本地 mock HTTP 全链路 + 真实桌面体检，18 项）。

### 说明

- `app.allowDelivery` 默认 `false`：桌面投递靠窗口矩形比例猜输入框位置，不同布局下可能点不中，
  因此默认只保留体检与唤起；需要实验性投递请显式打开。
- 桌面端无法读回内容（该客户端不开调试端口、渲染器 DOM 不暴露），数据面请走 HTTP 后端。
- 设置面板显示 `unsupported`（纯对象校验器 + `link:` 安装时解析不到 schemastery），
  配置请改 profile 的 `cordis.patch.yml`。
