# macOS 1.0.5 验证记录

日期：2026-11-07。版本：`1.0.5-macos.1`，基于本地 `1.0.4`（`36b946d`）并对照公开 Windows 修复版 `1.0.5-windows.2` 移植共享修复。

## 环境

- Apple Silicon Mac（arm64），macOS 27.2。
- DSH 宿主：`0.2.1-rc.5`；Node.js `24.21.0`，使用 DSH 附带运行时与 pnpm。
- Xcode Command Line Tools 可用；Swift 辅助程序本机编译并通过 `codesign --verify --strict`。
- 自动回归使用临时隔离 `DSH_HOME` / `LOCALAPPDATA`，只使用虚构 token、假密钥、假密码与临时目录。
- 未启动第二个 DSH GUI/server，未修改 DSH 安装包。

## 已执行

| 验证 | 结果 | 边界 |
| --- | --- | --- |
| `node scripts/run-tests.mjs` | 332 项：325 通过，0 失败，7 跳过 | 隔离 home；约 1 秒 |
| 已安装 DSH SDK 契约 | 4/4 通过 | 真实 React/slot/Settings/credentials 模块，虚构数据 |
| 隔离真实 DSH 宿主 | 通过 | `verify-dsh-macos`：插件加载、客户端代码下发、鉴权、模型设置往返、旧 revision 拒绝；未使用真实账号 |
| 固定官网 MD5 向量 | 通过 | `abc`、英文、中文、emoji 四组，POST/DELETE 各一次 |
| 旧 SHA-256 反例 | 通过 | 回环 HTTP 服务拒绝旧认证头，接受 MD5 |
| 回环 HTTP 新建/分页/删除 | 通过 | 新建一次、完整分页、删除一次、目标 UUID/名称缺席、已有假密钥保留 |
| 新建未知结果 | 通过 | 超时/断网/无效响应不重试、不泄漏上游文本、保留草稿提示 |
| 删除未知结果 | 通过 | 只发一次 DELETE；列表失败/目标仍存在/结果未知分别提示；不假报成功 |
| macOS 路径 | 通过 | 默认 home 使用 `~/Library/Application Support/DSH Tsinghua Paratera/Chrome`；自定义 home 使用 `browser-profile`；Windows 路径断言按 win32 语义 |
| Swift 辅助程序 | 通过 | `--check` 输出 `macOS Keychain`；`delete` 幂等返回 `{"ok":true}`；签名有效 |
| Keychain 删除逻辑 | 通过 | 优先 helper，缺失时回退 `/usr/bin/security`；`errSecItemNotFound` 视为成功；不读取密码 |
| 凭据窗口竞态 | 通过 | 窗口打开时拒绝删除；启动期不会留下错误 open 状态 |
| 凭据删除路由 | 通过 | 只接受 `DELETE` + `{confirm:true}`；未授权先于解析；响应不含密码/token/原始异常 |
| 隔离 profile 安装/卸载 | 通过（自动化） | 临时中文/空格路径，真实 pnpm；安装、verify、幂等重装、卸载、重复卸载、`--purge-profile` |
| 交付 TGZ 安装/卸载 | 通过 | 从 93 KB 插件包解压、真实 pnpm 链接、`--verify` 通过、卸载恢复原 manifest；使用临时 home 的 Keychain 命名空间 |
| 共享 profile | 通过 | 同 home 第二个 profile 存在时保留共享数据并拒绝 purge |
| YAML 清理 | 通过 | CRLF、引号、嵌套 provider、默认模型；复杂 YAML 原样拒绝 |
| 活跃刷新锁 | 通过 | 拒绝清理且不终止锁持有进程 |
| LaunchAgent plist | 通过 | `plutil -lint`，Unicode/空格/XML 转义；未实际注册 |
| Chrome 专用 profile | 通过（先前记录） | 新版刷新与登录窗口复用；本次未重新启动真实 Chrome |

普通回归跳过的 7 项：4 项已安装 DSH SDK 检查（需单独运行）、2 项 Windows 专属测试、1 项非 Windows 的 Chrome SingletonLock 检查。未把跳过项算作通过。

## 未进行的验收

- 没有重新执行真实清华账号登录、二次认证或真实密码保存/解密。
- 没有在 macOS 上真实新建/删除平台 API 密钥；真实生命周期验收记录来自 Windows 修复版，macOS 仅共用协议实现并通过回环 HTTP 与固定向量。
- 没有注册、加载或触发真实 LaunchAgent。
- 没有在 Intel Mac 或独立 Windows 设备重新完成整套流程。
- 没有验证所有 DSH 宿主版本；诊断兼容区间不代表逐一实测。

## 重要操作说明

Swift 辅助程序的 `delete` 曾在开发 smoke test 中直接执行；该命令对不存在的条目也返回成功，未读取或输出密码内容。任何需要保留的已保存密码应在升级/验证前确认，或之后在设置页重新保存。测试与卸载路径使用独立 `DSH_HOME` 命名空间；真实默认 Keychain 条目只受显式「删除已保存密码」或 `--uninstall`（未加 `--keep-credentials`）影响。

## 交付边界

插件 TGZ 只包含 `package.json` 允许的文件；不携带 `.git`、`.artifacts`、`node_modules`、真实 profile、日志、截图或密钥。源码 ZIP 与 TGZ 的哈希以构建输出为准。卸载不会撤销远端 API 密钥，也不会删除 DSH 凭据服务中的 `PARATERA_API_KEY`。
