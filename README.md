# DSH 清华算力 · Paratera

DeepSeek Harness（DSH）的非官方插件，打通**清华大学统一身份认证**与 **Paratera** 算力：
登录与续期、算力券余额、控制台 API 密钥、模型导入与模型参数设置。支持 **macOS / Windows**。

当前修复版：**1.0.6-windows.1**（基于上游 **1.0.4**，保留相同功能线）。本项目不隶属于清华大学、Paratera 或 DeepSeek。

Windows 安装、完整卸载、删除修复的实际边界与验证范围，见 [Windows 指南](docs/WINDOWS.md)。这是独立源码修复版，未自动安装或发布到上游。

> **适用范围**：仅适用于通过 `id.tsinghua.edu.cn` 登录的清华算力平台账号（`easycompute.cs.tsinghua.edu.cn`）。
> Paratera 官方账号或其他高校、企业的 Paratera 接入**不在支持范围**，登录步骤无法通过。

## 功能

- 输入栏显示算力券余额；设置页展示余额与会话状态。
- 专用 Chrome 会话登录与续期，不使用日常 Chrome profile。
- 可选保存登录密码：macOS Keychain / Windows 当前用户 DPAPI。
- 短信、企业微信二次认证；验证码由用户输入。信任浏览器默认关闭，需主动选择。
- 每台设备创建独立 API 密钥，先筛选模型再导入；支持列表、改名、启停和删除。
- 模型导入、上下文/最大输出、输入类型、思考挡位设置；通过 DSH Settings 即时更新。
- 宿主兼容性诊断；后台续期为可选功能，安装时默认不注册。

余额来自清华算力平台的 `couponFree`，不是账单或实时结算保证。只有当前供应商为 `paratera` 时，输入栏才显示余额；其他供应商不显示这笔额度。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS 13+，或 Windows 10/11 |
| 运行时 | Node.js 22+；可使用 DSH 附带的 Node |
| 宿主 | 已初始化的 DSH desktop profile；本次实机验证版本为 0.2.1-rc.5 |
| 浏览器 | Google Chrome |
| Mac 首次安装 | Xcode Command Line Tools（`xcode-select --install`） |

上游已实机验证 Apple Silicon Mac。Windows 安装/卸载、PowerShell 5.1、宿主 SDK 和三步筛选导入的验证范围见 [验证记录](docs/VALIDATION.md)。历史真实平台新建/删除及一次性返回密钥协议已验证；本次界面与状态机更新采用隔离假数据验证，不冒充新一轮真实账号验收。没有重新进行真实账号登录/二次认证、后台任务注册、密码加解密或 Mac 实机验收。

## 安装

从本仓库 GitHub Releases 下载源码 ZIP 或插件 TGZ，解压到长期保留的位置。

```sh
cd /path/to/dsh-tsinghua-paratera
node scripts/install.mjs --dry-run
node scripts/install.mjs
node scripts/install.mjs --verify
```

Windows 可在 PowerShell 中运行相同 Node 命令，或使用会自动寻找 Node 的专用入口（默认仅预览）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows.ps1 -Action Install
```

安装器会备份 profile 清单，追加本地链接和 bundle，保留其他配置；重复执行不会重复追加。

没有全局 Node 时，Mac 可使用：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" scripts/install.mjs
```

Windows 使用安装目录中 `resources\runtime\primary-runtime\dependencies\node\bin\node.exe`，或把该运行时加入当前终端 PATH。

可指定 `--dsh-home DIR`、`--profile NAME`；可用 `DSH_PNPM` 指定 pnpm.cjs。安装成功后完全退出并重开 DSH。

## 登录与余额

打开「设置 → 清华算力余额 → 账号登录」。

1. 选择「重新登录」，在专用 Chrome 窗口中完成登录，再回到 DSH 刷新。
2. 如果需要自动登录，可选择「保存凭据」，在系统原生窗口输入密码；保存并关闭窗口后会尝试登录。
3. 二次认证时，自己选择接收渠道并输入验证码。默认不把浏览器设为长期可信。
4. 在「模型」中选择已导入的 Paratera 模型，输入栏模型名称旁会显示余额。

手动登录不会由插件保存登录密码，但浏览器会话与短期 token 仍会保存在本机。验证码及密码不要粘贴到对话中。

## 密钥与模型

完成登录并连接控制台后，按三步操作：

1. **创建设备密钥**：名称默认本机设备名，可编辑；只创建一次，不自动导入全部模型。
2. **筛选模型**：默认空选。支持搜索、对当前筛选结果全选/取消，最多选 200 个；候选超过 200 时仍能搜索后面的模型。
3. **导入所选模型**：保存密钥，并仅追加你勾选的模型；「仅保存密钥」则不改模型列表。

- **平台只在创建时返回一次完整密钥**。旧列表里的眼睛导入不再适用，已移除无效入口；既有密钥仍可改名、启停和删除。
- 一次性密钥只在当前宿主内存中短暂保留，最长 10 分钟，不发给页面、不写日志；刷新页面可恢复候选和待处理步骤（未提交的勾选需重选），但**重启宿主无法恢复明文**。请在此期间完成导入。
- 取消须二次确认；只有能用创建前后完整列表证明是本次新 UUID 时才删除，不按名称猜测。删除失败/身份不明/过期会说明需要手动清理，绝不假称删除成功。
- 凭据写入失败可在有效期内重试同一操作，不重新创建；已保存凭据后的部分模型失败不会删除该密钥。
- 跨设备请**每台设备各建一把密钥**，这样可以单独撤销某台设备。
- 密钥导入前先验证模型列表，不发送计费的模型推理；旧密钥在覆盖前交由 DSH 备份。
- 完整 API 密钥不返回设置页；显示的是 SHA-256 摘要指纹，不包含密钥首尾字符。
- 模型设置可以调整名称、上下文、最大输出、文本/图片输入及思考挡位；新模型默认 low / high / max。
- 删除密钥会影响使用该密钥的应用；请仔细确认。新版已修复请求认证算法差异，并完成真实新建/删除验收；单次 DELETE 后完整分页核验，结果未知时先刷新检查，不盲目重复删除。新建结果未知也须先按名称核实，避免重复创建。详见 [根因与验收](docs/KEY-MANAGEMENT.md)。
- Windows 账号登录页可二次确认「删除已保存密码」，不解密文件，不会注销会话或撤销 API 密钥。
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
node scripts/install.mjs --uninstall              # 同时移除已导入的模型与会话
node scripts/install.mjs --uninstall --keep-data  # 只摘除插件，保留模型与会话
node scripts/install.mjs --uninstall --purge-profile  # 另外删除专用 Chrome profile
```

卸载会做三件事：从 profile 清单移除依赖与 bundle；从 `cordis.patch.yml` 删除插件写入的 `paratera` provider（以及指向它的默认模型条目，如果有），改动前自动备份；删除会话与状态文件（`easycompute-session.json`、`easycompute-state.json`、`paratera-console-session.json`、刷新锁）。

Mac / Windows 默认先停止并移除对应后台任务，再摘除插件。Windows 默认删除 DSH_HOME 内的 `easycompute-credentials.bin`，`--keep-credentials` 可保留；Mac 密码仍需在「钥匙串访问」中按 `DSH 清华算力余额` 查找并自行删除。`--purge-profile` 使用实际浏览器路径，包括自定义 home。请先手动退出 DSH、专用 Chrome 和凭据窗口。

同一 home 其他 profile 仍安装插件时，保留共享任务和数据，拒绝 purge，避免破坏其他 profile。清理失败会返回非零退出码；复杂手改 YAML 会拒绝自动修改，不假报清理成功。备份、源码与宿主持有的 `PARATERA_API_KEY` / `PARATERA_API_KEY_BACKUP` 有意保留，需分别确认后清理；删除 provider 不会撤销平台密钥。完整范围及限制见 [Windows 卸载指南](docs/WINDOWS.md#卸载)。

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
```

普通测试使用假数据，不读取真实登录凭据；安装包 SDK / 浏览器渲染测试需要本机 DSH，并默认从普通测试中跳过。
额外验证使用独立 DOM、临时配置或 Chrome profile。`verify:launchd` 会短暂注册独立的测试任务并清理。
Windows 的宿主 SDK 检查同样支持 `--electron <安装目录中的 DSH 可执行文件>`。

参考 [架构说明](docs/ARCHITECTURE.md)；许可证为 [MIT](LICENSE)。
