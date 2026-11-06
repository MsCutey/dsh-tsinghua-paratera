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
- 账号若启用二次认证，密码通过后会停在「二次认证」页：插件把浏览器保活，设置页给出
  「企业微信」「短信」两种方式和验证码输入框；码通过后还会遇到「是否记为信任浏览器」，
  插件选「是」（180 天）再继续，这样后续静默续期不再需要验证码。
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

## API 密钥与模型导入

在「清华算力余额」页完成清华登录后，依次选择「连接控制台」→「加载密钥」→ 对应密钥的「导入」。
主按钮「导入并添加到模型列表」会保存密钥并添加所选模型，成功后在「模型 → Paratera」及聊天模型选择器中查看。
已知模型默认不勾选；可用「全选 / 取消全选」一次选中当前筛选结果（最多 200 个），或过滤后逐个勾选。列表为空时，从验证接口自动发现模型再添加（超过 200 个需先明确选择）。
导入只追加，不会移除已有模型；需要删除或改值请到「模型设置」页逐条处理。
次按钮「仅保存密钥（不添加模型）」不会创建模型供应商条目，不能用它判断模型导入成功；禁用密钥需先启用。
API 密钥不是付费订阅，本插件不会创建“Codex 订阅”等其他插件的独立页面。

导入时按平台模型广场的「上下文长度」写入上下文窗口（内置 `lib/model-catalog.mjs`，80 个对话/多模态模型），
视觉模型按广场标签与简介自动勾选「图片」输入；名称直接使用模型 ID，不再带「待校准」。
最大输出优先用匹配到的在线模型目录（OpenRouter 公开目录，38 个模型有 `max_completion_tokens`），
未收录时取窗口一半、上限 128K；均可在「模型设置」调整或一键重算。
控制台可授权的模型未必都在公网 `/v1/models` 中（例如已下线的 ERNIE、Qwen3-Max），这类模型会被跳过并在提示里给出数量，不再让整次导入失败。
上下文与输出上限都可用 `node scripts/scan-model-catalog.mjs` 联网重新抓取（模型广场 + OpenRouter）。

## 模型设置

「清华算力余额」页内有两个页签：「账号登录」和「模型设置」，不额外占用设置菜单。
「模型设置」顶部是操作按钮，「一键最大值」把每行设成该模型的最大上下文与最大输出并立即保存，
旁边是「保存模型设置」「重新读取」。
下面每行可调整名称、上下文窗口、最大输出、输入类型（文本/图片）和思考挡位：
挡位就是 low / medium / high / xhigh / max 几个复选，第一次勾选默认带出 low / high / max（点中间的挡位会再加一个），
勾选后写入 `{ off: null, … }`，全部不勾选则跟随模型原生（不写 `reasoningEfforts`）。
这里刻意没有“关闭思考”这一档：输入栏的 Off 只是不指定挡位，模型若本身总是思考，Off 也停不下来，所以不做一个名不副实的开关。
保存走宿主修订号 Settings 接口，只替换 `llm-pi-ai.providers.paratera.models`，
不会请求平台、不会重新读取密钥，也不会把 `modelOverrides: {}` 等解析默认值写回 profile。

「改名」「新建」「删除」均在插件页面内填写/确认，不依赖 Electron 不支持的 `window.prompt()`。
改名后点击「保存名称」或在表单内按回车；失败时保留输入并显示局部错误，不再静默无效。

- 按 UUID 选择密钥；跨页查找不会用名称子串误选。同名且页面无法提供可靠身份时会拒绝读取，先在控制台重命名后重试。
- 完整密钥只在宿主中验证、写入，不返回设置页。验证仅请求模型列表，不发起计费的模型推理。
- 写入 `PARATERA_API_KEY` 前先备份旧值到 `PARATERA_API_KEY_BACKUP`；读取或备份失败时不覆盖旧值。
- 选中的模型必须出现在密钥验证返回的可用列表中；不在列表里的会被跳过并计数，全部不可用才报错。模型写入使用 DSH 的修订号 Settings 接口，只提交 `models` 等需要变更的字段（不会把宿主解析出的 `modelOverrides: {}` 等默认值写回），保留其他供应商、`modelOverrides` 及已有模型元数据；不会修改遇到的第一个 `models:` 文本块。
- 缺失的 Paratera 路由会补齐 OpenAI-compatible 协议和官方 API 地址。新模型的上下文长度取平台模型广场，最大输出默认 8192，可在「模型设置」里微调；这些值不代表已验证的推理能力。
- 模型配置通过宿主即时更新。若提示「密钥已保存，但模型导入失败」，密钥部分已经完成，可修复模型配置后重试；不会笼统报告全部成功。
- 浏览器认证可能较慢；连接控制台最多等待 4 分钟、导入最多等待 5 分钟。页面超时/关闭**不保证取消宿主已开始的写入**，请先确认状态，不要立即重复导入。
- 控制台授权前会清掉浏览器里残留的 `PARA_TOKEN`，只接受本次交换得到的 token；若密钥页仍未落到控制台，会自动再授权一次而不是直接在错误页面上取数（因此不会再出现 `untrusted-console-page`；平台拒绝授权时提示的是登录失败）。

更新插件代码后仍须从托盘完全退出并重启 DSH；上述即时更新指模型配置，不是插件代码热替换。
当前自动化验证使用隔离数据与已安装宿主 SDK；真实账号的控制台页面和导入结果仍需用户在重启后验收。

## 宿主路由

```
GET  /paratera-balance/api/balance
GET  /paratera-balance/api/status
POST /paratera-balance/api/refresh
POST /paratera-balance/api/login
POST /paratera-balance/api/credentials
GET  /paratera-balance/api/console/status
POST /paratera-balance/api/console/connect
GET  /paratera-balance/api/keys
POST /paratera-balance/api/keys/create
POST /paratera-balance/api/keys/update
POST /paratera-balance/api/keys/delete
POST /paratera-balance/api/keys/import
POST /paratera-balance/api/keys/refresh-models
GET  /paratera-balance/api/models
POST /paratera-balance/api/models
```

全部先过 `connection.requestRejection`；token 和完整 API 密钥只在宿主进程内使用，不下发浏览器。
余额请求发往 `easycompute.cs.tsinghua.edu.cn`，控制台请求发往 `ai.paratera.com`，
密钥验证请求发往 `llmapi.paratera.com`；宿主 HTTP 请求禁止携带凭据跟随重定向。
导入接口接受 `uuid`（优先）或兼容的 `name`，可选 `models: string[]` 和 `dryRun: true`。
`dryRun` 仍会读取并验证所选密钥，但不写入凭据或模型配置；它不是匿名探测接口。

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

在源码仓库的 Windows 环境中，可额外运行已安装 SDK 契约测试（按实际安装位置替换可执行文件）：

```powershell
npm run verify:host-sdk -- --electron "D:\DSH\DeepSeek Harness.exe"
```

该检查使用 Electron 的 Node 模式，不启动另一个 GUI/服务器；只在随机临时目录写入假凭据，
执行已安装宿主的凭据存储、Settings 修订号校验、配置验证及模型目录读取，并清理临时目录。
没有提供 SDK 路径时，普通 `npm test` 会跳过此可选测试；不会把 mock 通过当作真实账号登录成功。

测试用 `--test-force-exit` 运行：插件按设计保留后台定时器，测试结束时不等事件循环清空。

## 许可

MIT
