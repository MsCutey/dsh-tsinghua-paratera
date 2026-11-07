# Changelog

## 1.0.5-macos.1

对应 Windows 修复版 `1.0.5-windows.2` 的 macOS 版本，并补齐 macOS 独有路径。

- 修复控制台密钥认证根因：`Ai-Authorization` 由 `Bearer SHA256(token)` 改为官网实际使用的 SparkMD5 `Bearer MD5(token)`（32 位小写十六进制）。保留 `POST /lms/api/key/create`、`DELETE /lms/api/key/delete` 的 JSON 契约与 opaque 标识原样传输；MD5 仅用于兼容平台协议，不改变密码存储或密钥指纹。
- 新建/删除结果不再凭 HTTP 200 假报成功：缺少明确业务成功码视为无效响应；删除只发一次请求，随后完整分页只读核验，区分「已消失」「仍存在」「结果未知」，不自动重试破坏性请求。
- 新建超时/断网/未知响应在界面保留草稿并提示先按名称核实，不鼓励重复新建；新增 `key-create-unconfirmed`、`key-delete-not-deleted`、`key-delete-unconfirmed` 等中文错误提示。
- macOS 设置页新增「删除已保存密码」：二次确认后只删除 Keychain 条目，不读取/解密密码，不退出会话或撤销 API 密钥；凭据窗口打开时拒绝删除。Swift 辅助程序新增 `delete` 命令，无需重新编译即可由安装版使用。
- macOS 卸载默认清理钥匙串条目与插件会话/状态；`--keep-credentials` 保留密码，`--keep-data` 保留全部插件数据。共享 profile、活跃刷新锁、复杂 YAML、失败清理均显式处理，不再静默成功。
- 安装器采用更严格的 `cordis.patch.yml` 清理：只定位直属 provider/default，保留 CRLF、引号与无关设置；复杂 YAML 在写入前拒绝。pnpm 解析支持 DSH 附带运行时与 `DSH_PNPM` 的 `.cjs/.mjs` 入口。
- 平台路径按目标平台语义解析；自定义 DSH_HOME 的 macOS 浏览器目录与钥匙串命名空间保持隔离，默认 home 继续使用 `~/Library/Application Support/DSH Tsinghua Paratera/Chrome`。
- 新增固定官网 MD5 向量、回环 HTTP 新建/分页/删除、密钥未知结果、Keychain 删除、卸载清理与客户端交互回归；`pnpm test` 通过隔离 `DSH_HOME` 运行。
- 文档新增 [macOS 指南](docs/MACOS.md)、[密钥管理记录](docs/KEY-MANAGEMENT.md)、[验证记录](docs/VALIDATION.md)。本版本未在 macOS 重新执行真实账号登录/二次认证或真实密钥生命周期验收。

## 1.0.4

- 修复 1.0.3 在 Windows 上失败的路径断言：`pluginDataPaths` 对 macOS 用 POSIX 分隔符、对 Windows 用反斜杠，测试不再受运行主机影响。产品行为不变。

## 1.0.3

- 卸载现在会清理插件写入的配置：移除 `cordis.patch.yml` 中 `paratera` provider 与指向它的默认模型条目（带备份），并删除会话/状态文件；`--keep-data` 可保留，`--purge-profile` 额外删除专用 Chrome profile。
- 「删除密钥」失败时给出明确原因：控制台对 DELETE 请求体返回 500「解析数据失败」属平台侧问题，与插件请求格式无关；提示改用控制台网页删除或先「禁用」。

## 1.0.2

- 设置侧边栏标题恢复为「清华算力余额」：带括号的长标题会被侧栏截断成「清华算力（Para…」，并加入标题长度回归断言。
- 补齐导入与凭据相关错误码的中文提示，避免界面直接显示 `操作失败（ambiguous-key-row）` 这类原始代码。

## 1.0.1

- 修复控制台密钥标识改为不透明 base64 后「API 密钥」加载报「无效的密钥列表」：标识校验接受 base64 字符，仍限制长度、拒绝空白/控制字符和 `sk-` 明文前缀。

## 1.0.0

首次公开正式版，整合 Windows / macOS 的余额、登录、二次认证、控制台密钥管理、模型导入及设置功能。项目更名为 `dsh-tsinghua-paratera`：名称覆盖清华统一身份认证到 Paratera 的完整接入，不再局限于余额。

- 修复模型目录依赖和不稳定快照导致的输入栏标记缺失，加入实际安装包 React/插槽渲染回归。
- 密码与验证码改为固定受信任 frame 的隔离执行上下文，增加页面跳转和调试连接边界测试。
- 状态与响应白名单化；移除不必要身份字段和原始异常回传；密钥指纹改为 SHA-256 摘要。
- 后台任务与长期浏览器信任默认关闭；保存密码为可选操作。二次认证等待超时自动清理。
- Mac Keychain / Windows DPAPI 状态检查不解密密码，自定义 home 隔离 profile 和凭据命名空间。
- 准备干净的公开历史、发布文件允许列表、隐私说明、安全策略和测试工作流。
