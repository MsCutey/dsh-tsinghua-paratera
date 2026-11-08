# macOS 使用与验收指南

适用版本：`1.0.5-macos.2`。该版本对应 Windows 修复版 `1.0.5-windows.2`，并补齐 macOS 的密码删除、卸载清理与安装器路径。

## 适用范围

仅适用于通过 `id.tsinghua.edu.cn` 登录、进入 `easycompute.cs.tsinghua.edu.cn` 的清华算力平台账号。Paratera 官方账号、其他高校或企业的 Paratera 接入不在支持范围，登录步骤无法通过。

## 环境

| 项目 | 要求 |
| --- | --- |
| macOS | 13 或更高；Apple Silicon 已实机验证，Intel 需目标环境验收 |
| DSH | 已初始化的 desktop profile；本次验证为 `0.2.1-rc.5` |
| 浏览器 | Google Chrome，安装在 `/Applications` 或 `~/Applications` |
| 构建工具 | Xcode Command Line Tools：`xcode-select --install` |
| Node | 22+；可直接使用 DSH 附带 Node |

## 安装

```sh
cd /path/to/dsh-tsinghua-paratera
node scripts/install.mjs --dry-run
node scripts/install.mjs
node scripts/install.mjs --verify
```

没有全局 Node 时：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" scripts/install.mjs
```

安装器会：

1. 备份 `~/.dsh/profiles/desktop/package.json`。
2. 追加 `dsh-tsinghua-paratera` 本地链接与 bundle，保留其他依赖和设置。
3. 用 DSH 附带或 PATH 中的 pnpm 安装 profile 依赖。
4. 编译并代码签名 Swift 钥匙串辅助程序，缓存到 `.artifacts/macos-<arch>/credentials`。
5. 默认不注册后台任务；只有 `--task` 才写入当前用户 LaunchAgent。

安装完成后**完全退出并重新打开 DSH**。仅关闭窗口可能不会重新加载宿主插件。

## 登录、余额与密码

打开「设置 → 清华算力余额 → 账号登录」。

- 「重新登录」：打开本插件专用 Chrome profile，完成清华 SSO 与二次认证；日常 Chrome 不受影响。
- 「保存凭据」：在 macOS 原生窗口输入账号和密码，保存到当前用户 Keychain。密码只通过辅助程序的 stdout 管道进入宿主，不写入 argv、环境变量或临时文件。
- 「删除已保存密码」：本版本新增。需要二次确认；只调用 `SecItemDelete` 删除本插件服务名下的条目，不读取/解密密码，不退出平台会话，不撤销 API 密钥。凭据窗口打开或保存中时拒绝删除。
- Keychain 服务名为 `cn.edu.tsinghua.dsh-tsinghua-paratera`；自定义 `DSH_HOME` 追加 16 位 SHA-256 命名空间，避免不同 home 共用密码。可见标签为 `DSH 清华算力余额`。

余额来自平台 `couponFree`。只有当前供应商为 `paratera` 时，输入栏才显示余额；切换其他供应商后隐藏。

## 控制台密钥

登录后进入「连接控制台 → 加载密钥 → 导入」。

本版本修正了控制台认证算法：官网使用 SparkMD5，`Ai-Authorization` 必须是 `Bearer MD5(token)` 的 32 位小写十六进制，而不是 SHA-256。新建、删除仍保持官方 JSON 契约：

- `POST /lms/api/key/create`，`{ tokenName, billingType: 'PostPaid' }`
- `DELETE /lms/api/key/delete`，`{ tokenUuid }`

删除只发一次请求，随后通过 `POST /lms/api/key/llmSk` 完整分页只读核验。列表不完整、目标仍存在或结果未知时不会显示成功，也不会自动重试。新建超时/断网时保留草稿并提示先按名称核实。

插件不再提供「禁用 / 启用」密钥操作。该操作曾调用平台 `api/key/update`，但平台返回成功后状态未变，容易误报；现在请在 `ai.paratera.com` 官网控制台启停密钥。已禁用密钥在插件中仍会显示，导入时会提示先到官网启用。

详细根因、固定向量和实机验收边界见 [密钥管理记录](KEY-MANAGEMENT.md)。

## 可选后台续期

```sh
node scripts/install.mjs --task
```

Mac 使用当前用户 LaunchAgent，每 6 小时检查一次；失败会返回非零退出码，便于 `launchctl` 识别。睡眠、断网、退出登录期间不保证执行。遇到二次认证时本次检查结束，回到 DSH 完成认证。

## 卸载

```sh
node scripts/install.mjs --uninstall
node scripts/install.mjs --uninstall --keep-data
node scripts/install.mjs --uninstall --keep-credentials
node scripts/install.mjs --uninstall --purge-profile
```

默认行为：

1. 停止并移除对应 LaunchAgent。
2. 从 profile 清单移除依赖与 bundle。
3. 从 `cordis.patch.yml` 删除直属 `paratera` provider 与默认模型指向；写入前备份，复杂 YAML 拒绝自动修改。
4. 删除 `easycompute-session.json`、`easycompute-state.json`、`paratera-console-session.json`、刷新锁及遗留 `.tmp`。
5. 删除 Keychain 中本插件服务名的条目。

`--keep-credentials` 保留密码；`--keep-data` 保留模型、会话和密码；`--purge-profile` 额外删除专用 Chrome profile。同一 `DSH_HOME` 仍有其他 profile 安装插件时，保留共享数据并拒绝 purge。卸载不会撤销平台上的 API 密钥，也不会删除 DSH 凭据服务中的 `PARATERA_API_KEY`。

## 本地数据位置

| 数据 | 默认位置 |
| --- | --- |
| profile 清单 | `~/.dsh/profiles/desktop/package.json` |
| 会话 / 状态 / 锁 | `~/.dsh/easycompute-session.json`、`easycompute-state.json`、`paratera-console-session.json`、`easycompute-refresh.lock` |
| 控制台会话 | `~/.dsh/paratera-console-session.json` |
| Chrome profile | `~/Library/Application Support/DSH Tsinghua Paratera/Chrome` |
| Keychain | 服务 `cn.edu.tsinghua.dsh-tsinghua-paratera`，账号 `easycompute` |
| 自定义 home | 会话在 `DSH_HOME`，浏览器在 `DSH_HOME/browser-profile`，Keychain 服务名带命名空间 |

## 故障排查

- `keychain-helper-build-failed`：安装 Xcode Command Line Tools 后重试；确认 `/usr/bin/xcrun` 可用。
- `chrome-not-found` / `chrome-not-ready`：安装 Google Chrome；先退出升级前遗留的专用 Chrome 窗口，再点「重新登录」。
- `chrome-profile-in-use`：旧版可见登录窗口仍占用专用 profile。完成登录后完全退出该专用 Chrome，再重试。
- `key-create-unconfirmed`：先刷新密钥列表，按刚填写的名称核实；不要直接重复新建。
- `key-delete-unconfirmed` / `key-delete-not-deleted`：先刷新列表；仍不确定时到 `ai.paratera.com` 控制台核实，不要连续重复删除。
- `credential-dialog-open`：先关闭原生凭据窗口，再删除已保存密码。
- `refresh-busy`：另一个刷新/登录操作正在运行，稍后再试。

## 验收边界

本次 macOS 验证覆盖：Swift 辅助程序编译与签名、Keychain 删除辅助命令、自动化回归、固定 MD5 向量与回环 HTTP 密钥生命周期、隔离 profile 的真实 pnpm 安装/校验/卸载、共享 profile 与 YAML 清理、LaunchAgent plist 语法。

未重新执行：真实清华账号登录/二次认证、真实密码保存与解密、真实平台密钥新建/删除、LaunchAgent 实际加载、Intel Mac 实机。不要把自动化结果等同于真实账号验收。详见 [验证记录](VALIDATION.md)。
