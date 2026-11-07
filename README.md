# DSH 清华算力 · Paratera

DeepSeek Harness（DSH）的非官方插件，打通**清华大学统一身份认证**与 **Paratera** 算力：
登录与续期、算力券余额、控制台 API 密钥、模型导入与模型参数设置。支持 **macOS / Windows**。

当前版本：**1.0.5-macos.1**，对应 Windows 修复版 `1.0.5-windows.2` 的功能线，并补齐 macOS 的密钥删除、密码清理与安装器行为。本项目不隶属于清华大学、Paratera 或 DeepSeek。

macOS 安装、钥匙串、卸载与验收边界见 [macOS 指南](docs/MACOS.md)；密钥认证根因与验证见 [密钥管理记录](docs/KEY-MANAGEMENT.md)。

> **适用范围**：仅适用于通过 `id.tsinghua.edu.cn` 登录的清华算力平台账号（`easycompute.cs.tsinghua.edu.cn`）。
> Paratera 官方账号或其他高校、企业的 Paratera 接入**不在支持范围**，登录步骤无法通过。

## 功能

- 输入栏显示算力券余额；设置页展示余额与会话状态。
- 专用 Chrome 会话登录与续期，不使用日常 Chrome profile。
- 可选保存登录密码：macOS Keychain / Windows 当前用户 DPAPI；两个平台都可在设置页二次确认后删除本机保存的密码。
- 短信、企业微信二次认证；验证码由用户输入。信任浏览器默认关闭，需主动选择。
- 控制台 API 密钥列表、新建、改名、启停、删除及所选密钥导入。
- 新建/删除密钥后核验真实结果：超时、网络中断或 HTTP 200 缺少业务成功码时不假报成功，也不自动重复破坏性请求。
- 模型导入、上下文/最大输出、输入类型、思考挡位设置；通过 DSH Settings 即时更新。
- 宿主兼容性诊断；后台续期为可选功能，安装时默认不注册。

余额来自清华算力平台的 `couponFree`，不是账单或实时结算保证。只有当前供应商为 `paratera` 时，输入栏才显示余额；其他供应商不显示这笔额度。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS 13+（Apple Silicon / Intel），或 Windows 10/11 |
| 运行时 | Node.js 22+；可使用 DSH 附带的 Node |
| 宿主 | 已初始化的 DSH desktop profile；本次 macOS 实机验证版本为 0.2.1-rc.5 |
| 浏览器 | Google Chrome |
| Mac 首次安装 | Xcode Command Line Tools（`xcode-select --install`） |

本次在 Apple Silicon Mac 上完成编译、自动化回归、隔离 profile 安装与卸载验证；未重新进行真实清华账号登录/二次认证，也未在 Intel Mac 或独立 Windows 设备完成整套验收。诊断中的兼容区间不代表区间内每个版本都逐一实测。

## 安装

从本仓库 Releases 下载插件 TGZ 或源码 ZIP，解压到长期保留的位置。

```sh
cd /path/to/dsh-tsinghua-paratera
node scripts/install.mjs --dry-run
node scripts/install.mjs
node scripts/install.mjs --verify
```

安装器会备份 profile 清单，追加本地链接和 bundle，保留其他配置；重复执行不会重复追加。安装成功后完全退出并重开 DSH。

没有全局 Node 时，Mac 可使用：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" scripts/install.mjs
```

Windows 可在 PowerShell 中运行相同 Node 命令，或使用安装目录中 `resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。可指定 `--dsh-home DIR`、`--profile NAME`；可用 `DSH_PNPM` 指定 pnpm 的 JavaScript 入口（`pnpm.cjs` / `pnpm.mjs`）。

## 登录与余额

打开「设置 → 清华算力余额 → 账号登录」。

1. 选择「重新登录」，在专用 Chrome 窗口中完成登录，再回到 DSH 刷新。
2. 如果需要自动登录，可选择「保存凭据」，在系统原生窗口输入密码；保存并关闭窗口后会尝试登录。
3. 二次认证时，自己选择接收渠道并输入验证码。默认不把浏览器设为长期可信。
4. 在「模型」中选择已导入的 Paratera 模型，输入栏模型名称旁会显示余额。

手动登录不会由插件保存登录密码，但浏览器会话与短期 token 仍会保存在本机。验证码及密码不要粘贴到对话中。

### 删除已保存的密码（macOS）

设置页「账号登录」会显示「删除已保存密码」，需要二次确认。它只删除钥匙串中本插件写入的条目，不读取或解密密码，不退出平台会话，也不撤销 API 密钥。凭据窗口打开或正在保存时拒绝删除，避免与保存操作竞态。

## 密钥与模型

在完成平台登录后，选择「连接控制台 → 加载密钥 → 导入」。

- 「导入并添加」保存所选密钥并追加所选模型；「仅保存密钥」不添加模型。
- 密钥导入前先验证模型列表，不发送计费的模型推理；旧密钥在覆盖前交由 DSH 备份。
- 完整 API 密钥不返回设置页；显示的是 SHA-256 摘要指纹，不包含密钥首尾字符。
- 新建/删除使用控制台实际协议：`Ai-Authorization: Bearer MD5(token)`，并保留 `POST /lms/api/key/create` 与 `DELETE /lms/api/key/delete` 的 JSON 契约。MD5 仅用于兼容平台既有认证，不是密码存储方式。
- 删除只发一次 DELETE，随后完整分页只读核验；目标仍存在、列表不完整或结果未知时给出明确提示，不自动重试。新建结果未知时按名称核实，不直接重复创建。
- 模型设置可以调整名称、上下文、最大输出、文本/图片输入及思考挡位；新模型默认 low / high / max。
- 创建密钥不等于购买订阅，后续模型调用仍受平台计费规则约束。

平台模型广场和公开目录用于生成推荐值，不能保证每个路由实际支持声明的上限；请按目标模型验证。

## 可选后台续期

```sh
node scripts/install.mjs --task
```

Windows 使用当前用户计划任务；Mac 使用当前用户 LaunchAgent。每 6 小时检查一次，只在相应用户会话和设备可运行时工作；不保证睡眠、断网或退出登录期间续期。
自定义 DSH_HOME 使用独立浏览器目录和后台任务名称。后台任务遇到二次认证时结束本次检查，请回到 DSH 完成认证。

## 卸载与本地数据

```sh
node scripts/install.mjs --uninstall                    # 同时移除模型、会话与已保存密码
node scripts/install.mjs --uninstall --keep-data        # 只摘除插件，保留模型、会话与密码
node scripts/install.mjs --uninstall --keep-credentials # 清理数据但保留已保存密码
node scripts/install.mjs --uninstall --purge-profile    # 另外删除专用 Chrome profile
```

卸载会：从 profile 清单移除依赖与 bundle；从 `cordis.patch.yml` 删除插件写入的 `paratera` provider（以及指向它的默认模型条目，如果有），改动前自动备份；删除会话与状态文件（`easycompute-session.json`、`easycompute-state.json`、`paratera-console-session.json`、刷新锁）；macOS 默认删除钥匙串中的 `DSH 清华算力余额` 条目，Windows 默认删除 DSH_HOME 内的 `easycompute-credentials.bin`。清理只删除插件专属数据，失败会返回非零退出码，不静默假报成功。

同一 DSH_HOME 仍有其他 profile 安装本插件时，会保留共享的会话、密码、浏览器数据与后台任务，并拒绝 `--purge-profile`。Mac 默认先停止对应 LaunchAgent 再移除插件；Windows 的后台任务可在任务计划程序中删除。导入到 DSH 的 API 密钥归宿主所有，删除 provider 不会撤销平台上的密钥，必要时先去平台撤销。卸载后重新安装并导入即可恢复模型配置。

## 隐私与安全

请先阅读 [PRIVACY.md](PRIVACY.md)、[SECURITY.md](SECURITY.md) 和 [发布前审计摘要](docs/SECURITY-AUDIT.md)。

本插件不含遥测或分析服务代码。账号登录、余额和密钥操作会访问指定平台；DSH 与 Chrome 自身的联网行为另受它们的设置控制。
不必要的院系、班级、用户标识不写入余额缓存或返回界面，未知上游字段和原始异常不直接下发。
本机 bearer token 缓存不等于硬件隔离；请勿在不可信共享系统中保存密码或保持登录窗口打开。

问题反馈只需提供版本号、错误码和复现步骤。不要上传账号密码、完整 API 密钥、cookie、会话文件、整个 profile 或未脱敏截图。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run verify:host-sdk -- --electron "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
pnpm run verify:macos
pnpm run verify:chrome
pnpm run verify:auth
pnpm run verify:launchd
pnpm run verify:keys:live -- --help
```

普通测试通过 `scripts/run-tests.mjs` 隔离 `DSH_HOME`，使用假数据，不读取真实登录凭据；安装包 SDK / 浏览器渲染测试需要本机 DSH，并默认从普通测试中跳过。
额外验证使用独立 DOM、临时配置或 Chrome profile。`verify:launchd` 会短暂注册独立的测试任务并清理。
密钥生命周期实机验收入口默认禁用，只有 `--live --confirm-create-delete` 双开关才会读取既有会话并创建/删除一个随机临时密钥；没有明确授权不要运行。

参考 [架构说明](docs/ARCHITECTURE.md)、[macOS 指南](docs/MACOS.md)、[验证记录](docs/VALIDATION.md)；许可证为 [MIT](LICENSE)。
