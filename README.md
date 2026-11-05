# dsh-paratera-balance

DSH 原生模型栏余额插件：在输入栏模型左侧显示**清华算力平台（easycompute）算力券余额**。
版本 0.3.2，仅支持清华口径。凭据保存在本机（DPAPI 加密），token 到期后可静默重登。

## 数据来源

| 项 | 说明 |
| --- | --- |
| 会话 | `easycompute.cs.tsinghua.edu.cn` 的 `localStorage.token`，24 小时滑动续期 |
| 余额接口 | `GET /auth/userInfo/query`（`token` 头），取 `couponFree / couponUsed / couponTotal` |
| 续期 | 无头访问 `/home` 一次即自动续到 24 小时；插件每 5 分钟检查，剩余不足 1 小时则续期 |
| 计划任务 | `DSH Paratera Token Refresh`，每 6 小时，DSH 关闭时也维持会话 |

密码以 DPAPI 加密保存在本机（仅当前 Windows 账户可解密）；登录态保存在独立 Chrome 配置目录
`%LOCALAPPDATA%\dsh-paratera-profile`，与日常浏览器互不影响。插件不绕过验证码：
一旦出现验证码即中止自动登录并提示人工处理。

## 自动登录

- 账号密码通过 Windows DPAPI（CurrentUser 作用域）加密存于 `~/.dsh/easycompute-credentials.bin`，
  文件 ACL 收紧到当前用户；配置文件里没有明文密码。
- token 失效时，插件用无头 Chrome 打开控制台，自动跳清华 SSO、填写账号密码并提交，
  全程约 10–20 秒，无需人工。
- 若登录页出现图形验证码（通常只在多次失败后触发），插件立即中止并显示「需登录」，
  不会尝试绕过验证码。
- 冷启动实测：清空 session/state/localStorage/cookies 后，13 秒完成静默登录并取回余额。

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
- 「保存凭据」：打开本机凭据对话框，更新账号密码（DPAPI 加密）

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
5. 注册后台续期任务（可选，DSH 关闭时也生效）：
   ```text
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-windows-task.ps1
   ```
6. 自检：
   ```text
   node lib\scheduled.mjs
   ```
   期望输出 `{"ok":true,...}` 并写入 `~/.dsh/easycompute-session.json`。

## 目录结构

```text
lib/index.js      宿主插件：路由、余额映射、后台检查
lib/refresh.mjs   会话刷新、静默登录、DPAPI 凭据读取、浏览器控制
lib/client.js     客户端：输入栏小标 + 设置页
lib/scheduled.mjs 计划任务入口
scripts/          凭据对话框、解密脚本、计划任务安装
tests/            隔离测试（网络/浏览器/凭据全 mock）
```

## 开发

```text
npm test        # 11 项隔离测试（网络、凭据、浏览器全部 mock）
tests/live.mjs  # 显式真实探测：需 PARATERA_LIVE_TEST=1 与 PARATERA_CONSOLE_TOKEN
```

测试用 `--test-force-exit` 运行：插件按设计保留后台定时器，测试结束时不等事件循环清空。

## 许可

MIT
