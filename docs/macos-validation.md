# macOS 开发验证记录

日期：2026-11-05（Asia/Shanghai）。源码基于 GitLab `main` 的下载快照，页面所示提交
`fbac4f16ba5b7f3eed3fe2a0491169c320c3e92f`，原 package 版本 `0.4.2`。
本地分支为 `macos-support`，已通过用户确认的项目专用 Deploy Key 拉取 Git 历史，
基线确认为上述提交。Mac 开发分支基于该基线维护。
用户已授权这台设备保留本项目的读写权限，用于后续普通分支维护；原有 `main` 分支保护保持有效。
密钥有效期至 2027-11-05；私钥只保存在本机被忽略的 `.local/gitlab-auth/`，Git 配置仅作用于本仓库。

## 已验证

- 本机 Apple Silicon，使用 DSH 附带 Node `24.21.0`。
- Swift + AppKit + Security 辅助程序本机编译成功，`--check` 成功；编译缓存放在忽略的 `.artifacts/`。
- 33 项测试通过，包括既有前端/宿主测试、Mac 路径与钥匙串调用分流、验证码停止、SSO 域名检查和表单填充、真实 plist 语法检查、跨进程锁和状态文件权限，以及后台任务卸载失败保护和替换失败回滚。
- 临时中文/空格路径 DSH profile 的真实 pnpm 安装、校验、幂等重复安装、卸载通过，保留非插件配置。
- LaunchAgent `--dry-run` 可生成本机绝对路径配置；未实际注册到用户登录项。
- 本机实际 DSH 为 `0.2.1-rc.5`。用安装包自带 CLI 创建全新隔离 Web profile，真实加载本插件成功，插件客户端代码已在页面模块清单注册并可取回。
- 真实宿主接口验证：隔离实例已登录测试会话的 `/api/status` 返回 200，未登录返回 401，跨来源返回 403；登录/保存凭据/刷新路由拒绝 GET（405），未执行这些操作。
- `node scripts/verify-dsh-macos.mjs` 已通过，结果保存于本机忽略目录 `.artifacts/dsh-runtime-check-0WK3n1/result.json`；脚本自动关闭测试实例，有 45 秒进程看门狗，不会等待 5 分钟的自动刷新计时器。
- 编译后的钥匙串辅助程序已通过 `codesign --verify --strict`，使用固定的本地签名标识。
- 开发版已实际链接进本机 `desktop` profile，已备份原清单；`scripts/install.mjs --verify` 返回 `ok/linked/bundleListed/moduleLinked` 全部为 true。
- 用户截图已确认 Desktop 设置页正常加载。第一次刷新报 `chrome-not-ready`；进程核对发现专用 profile 被旧版可见登录窗口占用。新版登录窗口启用专用的回环调试端口，刷新可直接复用，不关闭用户窗口；已增加旧版进程占用检查和中文操作提示。
- 用户已确认「保存凭据」能够打开 macOS 原生窗口，并可正常输入保存；重试后用户确认「已显示余额」。本机状态核对：会话已生成，`lastRefreshAt` 非空、余额字段为数值、`lastError` 为 null，会话和状态文件权限均为 `0600`。本记录不保存账号、密码、token 或实际金额。
- `node scripts/verify-chrome-macos.mjs` 已以真实 Chrome 和全新临时 profile 通过：新进程启动、连接复用、附着连接关闭后保留浏览器、最后一个页面关闭而进程仍驻留时恢复为新无头浏览器。只访问 `about:blank`，未使用真实账号。
- 自动化测试使用虚构账号、mock 或临时空白 Chrome；真实登录与余额刷新由用户在 Desktop 界面完成，代理仅核对状态元数据。
- Desktop 模型菜单当前只有 DeepSeek 账号；已核对输入栏按原版规则隐藏 Paratera 余额标记。Paratera 供应商的显示/隐藏条件和金额展示通过前端测试，未在本机新增供应商配置。

## 尚未验证

- 实际 Paratera 模型的输入栏余额标记（本机未配置该供应商）。
- 会话彻底失效后的静默 SSO 冷启动，以及跨 24 小时的长期续期；未清空用户会话来强制制造过期。
- LaunchAgent 实际加载、DSH 关闭时续期和休眠恢复。
- Intel Mac，以及本次改动后的 Windows 实机回归。

## 实机验收步骤

1. 检查实际 DSH 版本与 profile，安装插件并运行 `scripts/install.mjs --verify`。
2. 用户完全退出并重开 DSH；确认「清华算力（Paratera）」设置页。
3. 用户在原生窗口保存凭据，或在新版专用 Chrome 手动登录（窗口可以保持打开）。升级前已打开的旧版专用 Chrome 需先退出一次。
4. 点「立即刷新」，与清华算力平台页面核对 `couponFree`；确认 provider 为 `paratera` 时显示余额，切换其它 provider 后隐藏。
5. 确认无真实 token/密码下发给客户端；真实探测输出不得包含 token/密码。
6. 用户选择启用后台续期后，注册 LaunchAgent，检查 `launchctl print` 和一次实际执行；确认任务失败不会报退出码 0。

## 验收结论

本机 Apple Silicon + DSH `0.2.1-rc.5` 的核心 Mac 流程已通过：安装与真实加载、原生凭据窗口、专用 Chrome 刷新、真实余额显示。
交付版本为 `0.5.0-macos.1`。可选 LaunchAgent 保持未启用；上列其它平台、供应商与长期运行范围可在对应环境中另行验收。
