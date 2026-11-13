# 与 DSH 宿主的耦合评估

评估日期：2026-11-13。被测宿主：DSH `0.2.1-rc.5`（`D:\DSH\resources\app.asar\dsh`）。
方法：枚举插件对宿主的全部引用，逐个对照安装包内的类型声明与官方 README，而不是仅凭“现在能跑”判断。

## 结论

插件**不 import 任何 DSH 包**，全部通过宿主注入的服务对象和前端模块加载协议通信。这避免了编译期耦合，但运行期仍依赖一批**方法名、对象形状和插槽名**。其中：

- 公开文档可查：`webServer.register`、`credentials.resolve/set`、`llm.listProviders/listModels`、`settings.section` 插槽、`dsh.bundle.patch`、`dsh.manifestVersion`、`engines.dsh`。
- 存在但**未进文档**：`connection.requestRejection`、`dsh.client.inject`、`__ModuleLoader__.load`、`settings.describe/update`、`slots.inject/register`、`modelDirectories.directoryFor`。
- **完全无文档**：`conversation.input.right` 插槽名；`llm-pi-ai` 命名空间下 `providers.paratera` 的字段结构。

因此 DSH 升级时最可能的失效顺序是：输入栏余额消失 → 设置页按钮无响应 → 整个设置页不出现。三者有不同原因，诊断页现在会区分。

## 耦合点分级

| 级别 | 依赖 | 位置 | 依据 | 失效表现 | 现有防护 |
| --- | --- | --- | --- | --- | --- |
| A 公开 | `dsh.bundle.patch` / `manifestVersion` | `package.json`、`cordis.patch.yml` | `dsh-package-manifest` README | 插件不加载 | 安装器校验 |
| A 公开 | `webServer.register({kind,path,handler})` | `lib/index.js` | `dsh-host-webserver` README | 路由不存在 | 路由注册抛错即失败 |
| A 公开 | `credentials.resolve/set` | `lib/import.mjs` | `dsh-credentials` README | 无法保存/备份密钥 | 方法缺失返回 `credentials-unavailable` |
| A 公开 | `llm.listProviders/listModels` | `lib/import.mjs` | `dsh-llm` README | 无法确认模型目录 | 缺失降级为部分成功 |
| A 公开 | `settings.section` 插槽 | `lib/client.js` | `dsh-client-ui-settings` README | 设置页无本插件 | 注册失败仅 warn |
| B 未文档化 | `connection.admit` / `requestRejection` | `lib/index.js` | README 只写 `admit`；`requestRejection` 为实现里的包装 | 路由鉴权失效或 503 | 已改为 `admit` 优先、回退包装、两者皆无时 **fail-closed** |
| B 未文档化 | `dsh.client.inject` | `package.json` | 仅 `dsh-client-modules` 实现读取，manifest 公开类型未列 | 前端模块解析失败 | 与 `require` 同时缺失才会失败 |
| B 未文档化 | `__ModuleLoader__.load({id,factory})` + 手写 `lib/client.js` | `lib/client.js` | 官方要求前端为构建产物；协议未公开 | 整个前端不出现 | 无（见下文建议） |
| B 未文档化 | `settings.describe()/update(ns,patch,revision)` | `lib/import.mjs`、`lib/models.mjs` | README 只提“revisioned descriptors” | 无法读写模型配置 | 方法缺失返回 `settings-unavailable`；诊断显示 `contract.settings` |
| B 未文档化 | `slots.inject/register`、`modelDirectories.directoryFor(sessionId).store` | `lib/client.js` | 无公开说明 | 余额不显示 | 已只把 `modelDirectories` 设为必需依赖 |
| C 内部 | `conversation.input.right` 插槽名 | `lib/client.js` | 全部官方 README 均未出现 | 输入栏余额静默消失 | 注册失败 warn；建议加显式提示 |
| C 内部 | `llm-pi-ai` ns 的 `providers.paratera` 结构 | `lib/import.mjs`、`lib/models.mjs` | 属内置 provider 插件私有 schema | 模型列表写入失败 | 写入前校验形状；冲突返回 `config-conflict` |
| C 内部 | profile `package.json` 的 `dependencies`/`dsh.profile.bundles` | `scripts/install.mjs` | 用户数据格式，非插件 API | 安装后不生效 | 安装器预检 + 备份 + JSON 校验 |

## 本次已落地的解耦改动

1. **鉴权 fail-closed**：优先用文档化的 `connection.admit(req)`，回退到仍存在的 `requestRejection(req)`；两者都没有、抛错或返回畸形结果时一律 503，**不再静默放行**。这是原实现里唯一可能变成安全问题的耦合。
2. **实测确认的传递依赖**：曾尝试把输入栏注入精简为只保留 `modelDirectories`，真实宿主 SDK 测试立即显示余额标记消失，恢复四个服务后通过。结论是 `modelDirectories` 的目录存储要经由 `sessions`/`remote` 链路才就绪，它们不是“未使用的冗余”，而是传递依赖；因此保留现状，并在代码注释中写明。这让“改哪个服务会让标记消失”从猜测变成已知。
3. **声明兼容范围**：`package.json` 增加 `engines.dsh: ">=0.2.1-rc.5 <0.3.0"`。宿主用 `semver.satisfies(..., {includePrerelease:true})` 校验并给出兼容性提示，升级到 0.3 时会明确报告，而不是静默异常。
4. **诊断可自证**：`/api/diagnostics` 增加 `contract` 字段，报告实际找到的是 `admit` 还是 `requestRejection`，以及 `credentials`/`settings`/`llmDirectory` 方法是否齐全。升级后先看这里，能区分“服务没注入”和“方法改名”。

## 建议的后续改造（按收益排序）

1. **前端改用官方构建产物**：把 `lib/client.js` 改写为 TypeScript 源并接入 DSH 的 client 构建流程（`dsh-client-modules` 期望 `lib/client.js` 由构建生成）。这能消除 `__ModuleLoader__` 手写协议风险，但改动大、需要宿主构建链，建议单独排期。
2. **模型配置改用 Config 引用**：DSH 文档提到“插件直接读自己的 Config 引用”，而我们直接写 `llm-pi-ai` 的 provider 子结构。若 `dsh-llm-pi-ai` 提供注册 API，应改用它；否则保留现状并在升级时优先核对 schema。
3. **插槽降级提示**：`conversation.input.right` 注册失败时，在设置页顶部显示“当前 DSH 版本可能改变了插槽名，余额标记不可用”，而不是只写 console。
4. **契约快照测试**：把 `contract` 字段、服务方法集与插槽名写成快照断言，升级 DSH 后跑一次即可定位第一个不匹配项。
5. **对 `settings.update` 增加形状探测**：若返回结构与预期不符（例如 revision 语义变化），返回专门的 `settings-api-changed` 而不是笼统失败。

## 升级 DSH 后的自查顺序

1. 打开设置页看插件是否出现；不出现 → 检查 `dsh.client.inject`、`__ModuleLoader__`、`dsh.bundle.patch`。
2. 出现但诊断 `contract.*` 为 false → 对应服务方法改名，按 A/B 表定位。
3. 余额 chip 消失 → 检查 `conversation.input.right` 与 `modelDirectories`。
4. 保存密钥/模型报错 → 检查 `credentials.*`、`settings.*`，再看 `llm-pi-ai` schema 是否变化。
5. 卸载后重装 → 检查 profile manifest 格式与 `cordis.patch.yml` 清理规则。

## 验证

本轮新增 `tests/host-contract.test.mjs`（5 项）覆盖：无鉴权方法时 503、异常/畸形 admission 不放行、`admit` 优先、`requestRejection` 回退、诊断契约字段。全量回归与宿主 SDK 结果见 [验证记录](VALIDATION.md)。本轮没有连接真实账号，也没有重启正在运行的 DSH。
