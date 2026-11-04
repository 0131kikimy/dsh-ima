# CHANGELOG

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
