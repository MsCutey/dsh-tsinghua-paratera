# Windows 修复版：安装、清理与验证

## 版本与范围

- 修复版：`1.0.5-windows.3`，基于上游 `1.0.4` / commit `90a6540a901f7a139727990833f12114cce7c14e`。
- 保留余额、登录、二次认证、密钥管理、模型导入和模型设置功能；没有改动 DSH 安装包，也没有自动安装到开发者正在使用的 profile。
- Windows 10/11、Node.js 22+、Google Chrome；已安装且初始化过 DSH desktop profile。
- 这是可测试的源码/插件修复包，不是 DSH 的 Windows EXE 安装器，也未代替上游公开发布。

## 安装

解压源码 ZIP 到长期保留的目录，在该目录打开 PowerShell。以下 `ExecutionPolicy Bypass` 只用于本次进程，不修改系统执行策略，不需要管理员权限。

```powershell
# 默认仅预览，不改任何配置；自动寻找 DSH 用户运行时或 PATH 中的 Node
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows.ps1

# 安装；默认不注册后台任务
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows.ps1 -Action Install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows.ps1 -Action Verify
```

安装器备份 profile 清单，只增加本插件依赖和 bundle，保留其他配置。安装完成后**手动完全退出并重新打开 DSH**；不要删除或移动源码目录，本地依赖链接会失效。本次开发没有重启或替换你的 DSH，也不承诺当前 GUI 自动热更新。

自动寻找失败时，明确指定运行时、DSH_HOME 或 profile：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows.ps1 -Action Install -NodeExecutable 'D:\your-runtime\node.exe' -DshHome 'D:\your-dsh-home' -Profile desktop
# 如需覆盖 pnpm，指向 JavaScript 入口，不是 pnpm.cmd
$env:DSH_PNPM = 'D:\your-runtime\pnpm\bin\pnpm.mjs'
```

同时支持原有 Node 命令。Windows 安装器优先使用 DSH 的 `pnpm.mjs` / `pnpm.cjs`，也能解析常见全局 npm pnpm.cmd 对应的 JS 入口；不会把路径和参数拼成 cmd.exe 命令。只有无法解析的自定义 shim 时，需要显式设置 `DSH_PNPM`。

## 密钥与密码删除

这两类操作不同：

1. **控制台 API 密钥**：在 API 密钥列表选择删除并确认。现在只发送一次删除请求，再完整分页读取列表；目标消失才确认成功。仍存在则明确提示；请求或核验结果未知时提示先刷新确认，不自动重试 DELETE。
2. **Windows 已保存登录密码**：账号登录页新增「删除已保存密码」，需要第二次确认。只移除当前 DSH_HOME 下的 DPAPI 文件，不读取或解密；凭据窗口打开/启动中时禁止删除。不会退出已有会话、清理 cookie 或撤销 API 密钥。其他 profile 使用相同 DSH_HOME 时也共享这份密码。

### 不能由客户端保证的边界

2026-11-07 的完整调用链核对发现：原插件认证头误用 SHA-256，而官网使用 SparkMD5/MD5。`1.0.5-windows.3` 已修正为 `Bearer MD5(token)`，用户授权后真实新建→删除验收通过。DELETE 方法及 `{tokenUuid}` JSON 参数保持不变。根因证据、真实验收与复验入口见 [密钥管理修复记录](KEY-MANAGEMENT.md)。公开来源：

- [平台入口](https://ai.paratera.com/)
- [API 密钥页面脚本](https://ai.paratera.com/assets/js/index-CLU5W59i.js)
- [LMS action 脚本](https://ai.paratera.com/assets/js/lms-DoN-e3lZ.js)
- [通用传输脚本](https://ai.paratera.com/assets/js/index-CdbFYLD1.js)

本次不再把该失败归因于平台拒绝：已定位并修正客户端认证错误，真实新建及删除已通过。仍不改用猜测的 POST/query/form、不自动重试破坏性请求；账号过期、权限、配额或未知网络结果等其他失败仍应按实际错误处理，而不是声称所有平台错误都已消失。

## 卸载

先手动退出 DSH、专用 Chrome 和凭据窗口，防止仍运行的进程重新写入数据。不要删除整个 DSH_HOME。

```powershell
# 先预览卸载范围
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows.ps1 -Action Uninstall -PurgeProfile -DryRun
# 移除插件、当前 profile 的模型/默认模型引用、会话、Windows 密码和专用浏览器数据
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows.ps1 -Action Uninstall -PurgeProfile
# 只摘除插件，保留所有数据
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows.ps1 -Action Uninstall -KeepData
```

原有命令等价：

```powershell
node .\scripts\install.mjs --uninstall --purge-profile
node .\scripts\install.mjs --uninstall --keep-data
node .\scripts\install.mjs --uninstall --keep-credentials
```

- 默认卸载会停止并移除当前 home 的 Windows 后台任务，清理本插件会话、状态、刷新锁和残留的原子写入临时文件，并删除 Windows 保存密码。`--keep-credentials` 可单独保留密码。
- 普通 `--uninstall` 保留浏览器 cookies；`--purge-profile` 才删除实际使用的专用 Chrome 目录，包括自定义 DSH_HOME 的 `browser-profile`。不会删除日常 Chrome 数据，不会强杀浏览器。
- 发现同一 home 的其他 profile 仍安装插件时，默认保留共享后台任务、会话、密码和浏览器数据；此时拒绝 `--purge-profile`。先卸载其他 profile，再执行完整清理。
- 清理失败返回非零退出码和 `cleanup.errors`，不会吞错假报成功；活跃刷新锁返回 EBUSY，需结束刷新后再试。
- 自动修改 YAML 限于可证明安全的 block mapping 子集。flow map、anchor/alias、merge、tag、转义标量或多行标量等复杂手改配置会在任何卸载写入前拒绝自动清理；错误码 `patch-cleanup-unsupported`。请手动移除 Paratera provider/默认模型引用，或先用 `--keep-data` 摘除插件，不会冒险损坏无关设置。
- **有意保留**：恢复用的 `.balance-backup-*`、解压的源码目录，以及 DSH 凭据服务持有的 `PARATERA_API_KEY` / `PARATERA_API_KEY_BACKUP`。它们不是继续运行的插件残留；宿主密钥可能被其他模型使用，需通过 DSH 支持的凭据管理方式单独删除。卸载不撤销平台密钥、不注销服务端会话。确认不需恢复后，可自行删除明确的备份和源码目录。

`--keep-data` 与 `--purge-profile` 互斥。`--no-task` 是给隔离测试/手动管理任务使用的选项，会跳过后台任务移除，不应用它冒充完整卸载。

## 可选后台续期

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows.ps1 -Action Install -Task
```

只为当前用户注册任务，每 6 小时检查。自定义 DSH_HOME 使用独立任务名称；任务显式携带 home、Node 路径、工作目录，正确处理中文、空格和 PowerShell 特殊字符。卸载任务不依赖旧 Node 或插件入口仍存在。

## 验证范围

实际 Windows 开发机，DSH `0.2.1-rc.5`：

- 全量假数据回归、真实 pnpm 的临时 Unicode profile 安装 → 验证 → 重装 → 卸载 → 重复卸载。
- Windows PowerShell 5.1 语法、模拟计划任务安装/移除、编码任务只执行独立假入口；不会注册/删除真实任务。
- 假 DPAPI blob 的状态/删除、不读取或解密，及窗口启动期删除竞态。
- 已安装 Windows DSH 的真实 React/slot/Settings/credentials SDK 契约测试（隔离 DOM/目录，使用虚构密钥）。

最终测试统计见随包 [验证记录](VALIDATION.md)。用户授权复用既有会话后，**真实新建临时密钥→删除→列表确认已通过一次**。仍未重新验证清华登录/二次认证、真实计划任务注册、真实密码输入与 DPAPI 加解密，不把这些范围的 mock 测试称为真实验收。
