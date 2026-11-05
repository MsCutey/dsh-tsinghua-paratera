# dsh-paratera-balance

DSH 原生模型栏余额插件：在输入栏模型左侧显示**清华算力平台（easycompute）算力券余额**。
版本 0.3.1，仅支持清华口径，不再读取并行智算云控制台。

## 数据来源

| 项 | 说明 |
| --- | --- |
| 会话 | `easycompute.cs.tsinghua.edu.cn` 的 `localStorage.token`，24 小时滑动续期 |
| 余额接口 | `GET /auth/userInfo/query`（`token` 头），取 `couponFree / couponUsed / couponTotal` |
| 续期 | 无头访问 `/home` 一次即自动续到 24 小时；插件每 5 分钟检查，剩余不足 1 小时则续期 |
| 计划任务 | `DSH Paratera Token Refresh`，每 6 小时，DSH 关闭时也维持会话 |

不保存密码，不做验证码绕过。登录态保存在独立 Chrome 配置目录
`%LOCALAPPDATA%\dsh-paratera-profile`，由 Chrome 自身加密，与日常浏览器互不影响。

## 显示逻辑

- 仅在当前模型的 provider 为 `paratera` 时显示（DSH 的模型供应商 id，与余额数据源无关）
- 金额为算力券剩余额度 `couponFree`，悬停显示已用/总额、院系、会话有效期
- 会话失效时显示「需登录」，不再静默变成空白或 0

## 设置页

设置 → 清华算力余额：

- 登录状态、会话有效期、券余额/已用/总额
- 最近自动刷新时间、最近错误
- 「立即刷新」：用专用浏览器会话重新取数
- 「重新登录」：打开专用浏览器窗口，走一次清华 SSO

## 宿主路由

```
GET  /paratera-balance/api/balance
GET  /paratera-balance/api/status
POST /paratera-balance/api/refresh
POST /paratera-balance/api/login
```

全部先过 `connection.requestRejection`；token 只在宿主进程内使用，不下发浏览器；
请求仅发往 `easycompute.cs.tsinghua.edu.cn`，禁止重定向。

## 配置

```yaml
config:
  cacheMs: 5000   # 余额缓存毫秒数，上限 60000
```

## 开发

```text
npm test        # 11 项隔离测试（网络、凭据、浏览器全部 mock）
tests/live.mjs  # 显式真实探测：需 PARATERA_LIVE_TEST=1 与 PARATERA_CONSOLE_TOKEN
```

测试用 `--test-force-exit` 运行：插件按设计保留后台定时器，测试结束时不等事件循环清空。

## 许可

MIT
