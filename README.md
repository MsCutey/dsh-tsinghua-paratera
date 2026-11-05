# dsh-paratera-balance

DSH 原生模型栏余额插件：在输入栏模型左侧显示**清华算力平台（easycompute）算力券余额**。
版本 `0.5.0-macos.1`，增加 macOS 适配：Chrome 应用探测、钥匙串凭据窗口和可选 LaunchAgent。
余额仍使用清华算力口径；Windows 继续使用 DPAPI。当前验证范围见 [Mac 验证记录](docs/macos-validation.md)。

## Mac 安装

前置：macOS、Google Chrome、Node 22+、已初始化的 DSH desktop profile。
首次编译钥匙串辅助程序需要 Xcode Command Line Tools（`xcode-select --install`）。
DSH 接口基线沿用上游要求 `0.2.1-rc.5+`；安装后的设置页与真实账号登录需在目标 DSH 中验收。

Mac 开发版位于 `macos-support` 分支；使用该分支安装：

```sh
git clone --branch macos-support https://git.tsinghua.edu.cn/bbc26/dsh-paratera-balance.git
cd dsh-paratera-balance
```

已有本地目录时直接进入该目录：

```sh
cd /path/to/dsh-paratera-balance
node scripts/install.mjs --dry-run
node scripts/install.mjs
node scripts/install.mjs --verify
```

没有全局 Node 时，可直接使用 DSH 附带的运行时：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" scripts/install.mjs
```

安装器自动发现 DSH 的 pnpm，备份 profile 清单，再添加链接依赖与 bundle；重复安装不会重复追加。
pnpm 失败会恢复清单备份，但不会回滚 pnpm 可能已产生的依赖目录变化，可修复错误后重试。
`--dsh-home DIR` 和 `--profile NAME` 用于非默认 profile。

安装成功后，完全退出并重开 DSH，在「设置 → 清华算力余额」选择：

- 「保存凭据」：在本机原生窗口输入账号密码，存到登录钥匙串中的 `DSH 清华算力余额` 项目；然后点「立即刷新」。后台读取不会弹出钥匙串解锁窗口，钥匙串锁定时需手动解锁或重新保存。
- 「重新登录」：不保存密码，手动完成专用 Chrome 窗口中的登录；完成后返回 DSH 点「立即刷新」，窗口可以保持打开。验证码始终由用户处理。

升级前已经打开的旧版专用 Chrome 需要先退出一次，再用「重新登录」打开新窗口。
macOS 仅关闭窗口可能仍保留进程；旧进程未退出时，设置页会给出具体提示。
新版会复用自己的专用浏览器，最后一个窗口关闭后如进程仍驻留，会自动恢复为无头刷新。

Mac 的专用浏览器目录为 `~/Library/Application Support/DSH Paratera Balance/Chrome`，
不会使用日常 Chrome 的 profile。会话和状态位于 `$DSH_HOME`（默认 `~/.dsh`），文件权限为 `0600`。
钥匙串辅助程序在插件的 `.artifacts/macos-<架构>/` 中编译；更新或重编译后如系统要求授权，需由用户在本机确认。

可选后台续期（仅当前用户登录期间运行，每 6 小时检查；睡眠和退出登录期间不保证运行）：

```sh
node scripts/setup-macos-task.mjs --dry-run
node scripts/setup-macos-task.mjs
launchctl print "gui/$(id -u)/cn.edu.tsinghua.dsh-paratera-balance.refresh"
```

卸载：

```sh
node scripts/setup-macos-task.mjs --remove
node scripts/install.mjs --uninstall
```

不删除钥匙串项目、会话和浏览器 profile；需要时用户可自行在「钥匙串访问」中删除凭据。

## 数据来源

| 项 | 说明 |
| --- | --- |
| 会话 | `easycompute.cs.tsinghua.edu.cn` 的 `localStorage.token`，24 小时滑动续期 |
| 余额接口 | `GET /auth/userInfo/query`（`token` 头），取 `couponFree / couponUsed / couponTotal` |
| 续期 | 无头访问 `/home` 一次即自动续到 24 小时；插件每 5 分钟检查，剩余不足 1 小时则续期 |
| 计划任务 | Windows `DSH Tsinghua Balance Refresh` / Mac LaunchAgent，每 6 小时检查，DSH 关闭时也可维持会话 |

Windows 密码以 DPAPI 加密保存在本机（仅当前 Windows 账户可解密）；登录态保存在独立 Chrome 配置目录
`%LOCALAPPDATA%\dsh-paratera-profile`，与日常浏览器互不影响。插件不绕过验证码：
一旦出现验证码即中止自动登录并提示人工处理。

## 自动登录

- 账号密码通过 Windows DPAPI（CurrentUser 作用域）加密存于 `~/.dsh/easycompute-credentials.bin`，
  文件 ACL 收紧到当前用户；配置文件里没有明文密码。
- token 失效时，插件用无头 Chrome 打开控制台，自动跳清华 SSO、填写账号密码并提交，
  正常情况下不需人工；网络、SSO 和浏览器状态可能影响耗时或要求重新登录。
- 若登录页出现图形验证码（通常只在多次失败后触发），插件立即中止并显示「需登录」，
  不会尝试绕过验证码。
- 上游 Windows 曾记录冷启动登录耗时 13 秒；该结果不代表 Mac 真实登录已通过。

## 显示逻辑

- 仅在当前模型的 provider 为 `paratera` 时显示（DSH 的模型供应商 id，与余额数据源无关）
- 金额为算力券剩余额度 `couponFree`，悬停显示已用/总额、院系、会话有效期
- 会话失效时显示「需登录」，不再静默变成空白或 0

## 设置页

设置 → 清华算力余额：

- 登录状态、会话有效期、券余额/已用/总额
- 最近自动刷新时间、最近错误
- 「立即刷新」：用专用浏览器会话重新取数
- 「重新登录」：打开专用浏览器窗口，手动走一次清华 SSO（验证码或改密后使用）
- 「保存凭据」：打开本机凭据对话框，更新账号密码（Windows DPAPI / macOS 钥匙串）

## 宿主路由

```
GET  /paratera-balance/api/balance
GET  /paratera-balance/api/status
POST /paratera-balance/api/refresh
POST /paratera-balance/api/login
POST /paratera-balance/api/credentials
```

全部先过 `connection.requestRejection`；token 只在宿主进程内使用，不下发浏览器；
请求仅发往 `easycompute.cs.tsinghua.edu.cn`，禁止重定向。

## 配置

```yaml
config:
  cacheMs: 5000   # 余额缓存毫秒数，上限 60000
```

## Windows 一句话安装（人类或 AI）

```text
git clone https://git.tsinghua.edu.cn/bbc26/dsh-paratera-balance.git "%USERPROFILE%\.dsh\plugins\dsh-paratera-balance"
node "%USERPROFILE%\.dsh\plugins\dsh-paratera-balance\scripts\install.mjs"
```

脚本会按**当前设备的系统**自动选择实现，并在结尾输出 JSON 摘要；重复执行安全：

| 平台 | 凭据存储 | 后台续期 |
| --- | --- | --- |
| Windows 10/11 | DPAPI（`~/.dsh/easycompute-credentials.bin`） | 计划任务 `DSH Tsinghua Balance Refresh` |
| macOS 13+ | Keychain（Swift 助手，需 Xcode Command Line Tools） | launchd agent |
| 其他 | 不支持，安装器会直接报 `unsupported-platform` | — |

后台任务默认随安装注册；不想注册用 `--no-task`。

校验：

```text
node scripts\install.mjs --verify   # 期望 "ok": true
```

给 AI 代理的完整协议见 [AGENTS.md](AGENTS.md)（含前置检查、成功判据、失败处理、凭据边界）。

## 在另一台设备安装（Windows）

前置：Windows 10/11、已安装 Chrome、Node 22+（DSH 自带即可）、DSH 0.2.1-rc.5 及以上。

1. 克隆到任意目录（路径含空格也没问题）：
   ```text
   git clone https://git.tsinghua.edu.cn/bbc26/dsh-paratera-balance.git
   ```
2. 作为本地链接装进 DSH profile，编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：
   - `dependencies` 增加 `"dsh-paratera-balance": "link:<克隆路径>"`
   - `dsh.profile.bundles` 追加 `"dsh-paratera-balance"`
   然后在 profile 目录执行 `pnpm install`（用 DSH 自带的 pnpm）。
3. 完全退出并重启 DSH，设置里应出现「清华算力余额」页签。
4. 点「保存凭据」，输入一次账号密码（DPAPI 加密保存在本机）。
5. 后台续期任务由安装器按系统自动注册（Windows 计划任务 / macOS launchd），无需手动执行。
   如需跳过：`node scripts\install.mjs --no-task`。
6. 自检：
   ```text
   node lib\scheduled.mjs
   ```
   期望输出 `{"ok":true,...}` 并写入 `~/.dsh/easycompute-session.json`。

## 目录结构

```text
lib/index.js      宿主插件：路由、余额映射、后台检查
lib/refresh.mjs   会话刷新、静默登录、浏览器控制
lib/platform.mjs  Mac / Windows 路径
lib/macos-credentials.mjs 原生钥匙串辅助程序构建与调用
lib/client.js     客户端：输入栏小标 + 设置页
lib/scheduled.mjs 计划任务入口
scripts/          Swift / PowerShell 凭据窗口、各平台后台任务安装
tests/            隔离测试及临时 Mac profile 的真实 pnpm 安装测试
```

## 开发

```text
npm test                         # 不读取真实凭据，不请求真实余额
npm run verify:macos              # 隔离启动已安装 DSH，验证真实宿主/客户端/鉴权后自动退出
npm run verify:chrome             # 临时空白 Chrome：验证启动、复用及窗口关闭后的恢复
EASYCOMPUTE_LIVE_TEST=1 node tests/live.mjs  # 用户明确授权后进行真实账号探测
```

测试用 `--test-force-exit` 运行：插件按设计保留后台定时器，测试结束时不等事件循环清空。

## 许可

MIT
