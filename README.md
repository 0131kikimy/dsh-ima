# dsh-ima

让 **DeepSeek Harness** 能调用 **腾讯 ima 知识库**：把 ima 的检索、问答、知识库能力暴露成模型可直接调用的原生工具。

DSH 插件（bundle）形态，零第三方运行时依赖，装上即用。

```bash
# 在 DSH 里让模型调用，或直接：
plugin_manager(action: "install_bundle", target: "<本仓库的绝对路径>")
```

---

## 工具

| 工具 | 作用 | 需要什么 |
| --- | --- | --- |
| `ima_health` | 体检两条通道，回报**当前哪些能力真的可用**。排障第一步 | 无 |
| `ima_open` | 唤起 ima 桌面客户端（必要时拉起、把托盘窗口显示出来、摆回屏幕内），可让它打开一个网址 | 本机 ima |
| `ima_ask` | 提问：配了 HTTP 接口 → 返回**答案 + 引用**；否则桌面"投递"（默认关闭的实验能力） | HTTP（推荐） |
| `ima_search` | 在知识库里检索片段（title / snippet / url / score） | HTTP |
| `ima_kb_list` | 列知识库（id / 名称 / 文档数） | HTTP |
| `ima_import` | 把 URL 或纯文本写入知识库（**写操作**） | HTTP |

---

## 能力边界

不同通道能做什么差别很大，这里按实测结论列清楚，避免调用方误以为"投递成功 = 问到了"。

| 通道 | 结论 | 说明 |
| --- | --- | --- |
| **HTTP 接口** | ✅ 能读回 | 问答、检索、列库、写入。路径与响应字段全可配；本地 mock 全链路 18 项自检通过 |
| **桌面 · 唤起** | ✅ 可用 | `EnumWindows` 按 PID 找到 `Chrome_WidgetWin_1` 真窗口 → `ShowWindow`。注意 `Get-Process.MainWindowHandle` 对托盘态返回 0，不能用 |
| **桌面 · 读回内容** | ❌ 不可用 | 该客户端忽略 `--remote-debugging-port`（干净环境实测无 `DevToolsActivePort`），且渲染器 DOM 不向 UIA 暴露，只到浏览器外壳 |
| **桌面 · 投递问题** | ⚠️ 实验，默认关闭 | 靠窗口矩形比例猜输入框位置 + 模拟击键，不同布局下可能点不中。`app.allowDelivery` 默认 `false` |

**结论：要答案和检索结果，必须配 HTTP 后端；桌面端只保证"唤起"。**

---

## 安装

```bash
plugin_manager(action: "install_bundle", target: "<本仓库绝对路径>")
```

DSH 会把 `dsh-ima` 写进 profile 的 bundle 列表，工具立即出现在模型侧。
卸载：`plugin_manager(action: "remove_bundle", target: "dsh-ima")`。

自检（不依赖宿主）：

```bash
node test/selfcheck.mjs
```

---

## 可视化设置（推荐）

装好之后直接对模型说「打开 ima 设置」/ 调用 `ima_settings`，它会给你一个**本机设置页地址**：

```
http://127.0.0.1:<dsh端口>/dsh-ima/settings?token=<一次性令牌>
```

页面上可以直接填写 **Client ID / API Key / 接口地址 / 默认知识库 / 检索条数 / ima 客户端路径**，
点「保存」**立即生效**（写入 `$DSH_HOME/dsh-ima/settings.json`，无需重启），点「测试连接」会同时探测
HTTP 接口与桌面客户端两条通道并回显真实状态。

- 页面只监听本机，且必须带令牌才能读写（令牌首次启动生成并持久化，URL 跨重启稳定）。
- 设置页保存的值**优先于** `cordis.patch.yml` 里的 `config`。
- 若宿主没有 `webServer` 服务（非 Web 部署），设置页不出现，此时用下面的 YAML 方式配置。

## 配置（YAML 方式）

> 目前设置面板会显示 `unsupported`（本包用纯对象校验器，不依赖宿主包；以 `link:` 方式安装时也解析不到 schemastery）。
> 请直接在 **profile 的 `cordis.patch.yml` 末尾追加**下面这段（`$DSH_PROFILE_DIR` 是当前 profile 目录）。

### 方式一：接 ima 官方 OpenAPI（推荐，能读回你账号里的知识库）

在 <https://ima.qq.com/agent-interface> 领取 **API Key**（页面会给 `Client ID` 与 `API Key`），然后：

```yaml
- id: dsh-ima
  config:
    http:
      preset: ima                 # 走腾讯 ima 官方 OpenAPI
      clientId: 'YOUR_CLIENT_ID'  # 32 位十六进制
      apiKey: 'YOUR_API_KEY'
      skillVersion: 1.1.10        # 作为 ima-openapi-ctx 上报，按官方客户端默认值即可
    knowledgeBase: ''             # 可选：默认知识库 id（ima_kb_list 可查）
    topK: 8
```

协议来自官方 `ima-skills` 包里的 `ima_api.cjs`：`POST https://ima.qq.com/<apiPath>`，
请求头 `ima-openapi-clientid` / `ima-openapi-apikey` / `ima-openapi-ctx: skill_version=…`。

**能力边界（重要）**：ima 官方 OpenAPI 只有**知识库与笔记**接口，**没有问答生成接口**。
所以接上之后：`ima_kb_list` / `ima_search` 返回真实数据；`ima_ask` 会退化为**检索汇总**，
并在答案首行标注「ima 开放接口没有问答生成能力」。要真正的问答，需要另接带 LLM 的问答服务。

### 方式二：接你自己的 REST 接口

```yaml
- id: dsh-ima
  config:
    backend: auto          # auto | http | app；auto = 配了 http.baseUrl 就走 HTTP，否则走桌面
    knowledgeBase: ''      # 可选：默认知识库 id 或名称
    topK: 8                # 可选：检索条数
    http:
      preset: generic
      baseUrl: 'https://your-ima-endpoint.example.com'
      token: 'YOUR_TOKEN'
      authHeader: Authorization     # 默认 Authorization
      authScheme: 'Bearer '         # 默认 'Bearer '；不需要前缀就留空
      headers:                      # 可选：任意附加请求头（非 Bearer 鉴权用得上）
        X-Client-Id: 'YOUR_CLIENT_ID'
        X-Api-Key: 'YOUR_API_KEY'
      paths:
        ask: /v1/ask
        search: /v1/search
        kbList: /v1/knowledge_bases
        import: /v1/documents
      mapping:                      # 响应字段路径，支持 a.b[0].c
        answer: answer
        citations: citations
        hits: hits
        hitTitle: title
        hitSnippet: snippet
        hitUrl: url
        hitScore: score
      timeoutMs: 60000
    app:
      executable: ''        # 留空 = 自动探测（运行中进程路径 / 常见安装位置）
      launchTimeoutMs: 20000
      allowDelivery: false  # 桌面投递（实验），默认关闭
```

配置非法会在**加载期**响亮失败，不会静默回落默认值。

### HTTP 接口契约

插件按"你填的路径 + 字段映射"发请求，不绑定某一家 API 形状：

```
POST {baseUrl}{paths.ask}      {"question","knowledge_base","top_k"}    → {answer, citations[]}
POST {baseUrl}{paths.search}   {"query","knowledge_base","top_k"}       → {hits[]}
GET  {baseUrl}{paths.kbList}                                           → {knowledge_bases[]}
POST {baseUrl}{paths.import}   {"url"|"text","title","knowledge_base"}  → {id, status}
```

`mapping.answer` 也可以写成 `choices[0].message.content`——OpenAI 兼容的 `/chat/completions` 直接能接。

---

## 安全设计

桌面端做键盘输入时，任何一步失误都可能把内容打进别的应用。因此脚本里是**先验证、再动作**：

1. `SetProcessDPIAware()` 在任何坐标计算之前执行——否则拿到的是逻辑像素，算出的点击点会偏；
2. **点击前**用 `WindowFromPoint` + `GetWindowThreadProcessId` 校验该点属于 ima 进程，不属于就报错、不点；
3. **每次击键前**用 `GetForegroundWindow` 校验前台是 ima，不是就报错、不打；
4. 返回值如实回报 `foregroundVerified` / `pointPid` / `deliveredWhileImaForeground`，并提供 `dryRun: true` 只演练不动作。

`ima_ask` 在桌面形态下会先用 `dryRun` 探一次；`app.allowDelivery` 未打开时直接拒绝并说明原因，而不是假装成功。

---

## 已知限制 / Roadmap

1. **桌面读回**：唯一可行方向是截图 OCR（定位占位符 + 读答案），本版未做——误读成本高，没有可靠判据不如不做。
2. **桌面投递**：启发式定位，默认关闭；打开后建议先 `ima_ask({ dryRun: true })` 看坐标与归属再小步试。
3. **深链接**：`imacopilot://open?url=<encoded>` 是 ima 注册的唤起路由（只开窗、不返结果），`ima_open` 用它把网页丢给 ima。
4. **HTTP 后端**：无重试、无流式；按需再加。

---

## 许可

MIT。图标为本项目原创 SVG。
