# Paratera / 清华算力 余额 for DSH

在输入栏模型左侧显示账户余额；默认数据源为清华算力平台（easycompute）的算力券余额，
可选回退到并行智算云（Paratera）控制台。版本 0.3.0。

## 数据源与自动续期

| 数据源 | 会话 | 有效期 | 续期方式 |
| --- | --- | --- | --- |
| 清华算力平台 `easycompute.cs.tsinghua.edu.cn`（**默认**） | `localStorage.token` | 24 小时滑动 | 无头访问 `/home` 即自动续到 24 小时 |
| 并行智算云控制台 `ai.paratera.com`（`source: paratera`） | `localStorage.PARA_TOKEN` | 60 分钟 | 无刷新接口，过期只能重新登录 |

默认走清华侧，因为它有滑动续期，登录一次后可以长期免维护；Paratera 控制台的 1 小时 token
不适合作为主力，仅在需要核对控制台金额时启用。

余额接口：

- 清华：`GET /auth/userInfo/query`（`token` 头），取 `couponFree / couponUsed / couponTotal`
- 并行：`GET /platform/paraUser/getPrice`，`chargeFree + creditFree`（旧口径，仍标注为估算）

## 配置

```yaml
config:
  source: easycompute   # 或 paratera
  cacheMs: 5000
```

## 设置页

设置 → 并行智算云：

- 登录状态、会话有效期、券余额/已用/总额
- 最近自动刷新时间、最近错误
- 「立即刷新」：用专用浏览器会话重新取数
- 「重新登录」：打开专用浏览器窗口，走一次清华 SSO

## 凭据与隐私

- 不保存密码。登录态保存在独立 Chrome 配置目录 `%LOCALAPPDATA%\dsh-paratera-profile`，
  由 Chrome 自身加密，与日常浏览器互不影响。
- 宿主只向上述两个固定域名发请求，禁止重定向；token 不下发到浏览器页面。
- 唯一宿主路由：`GET /paratera-balance/api/balance`、`GET /paratera-balance/api/status`、
  `POST /paratera-balance/api/refresh`、`POST /paratera-balance/api/login`，全部先过
  `connection.requestRejection`。

## 计划任务

`DSH Paratera Token Refresh`（每 6 小时）调用 `~/.dsh/paratera-token-refresh.cmd`，
在 DSH 关闭时也能维持会话；DSH 打开时插件自身的 5 分钟检查会先接管。

## 验证

```text
npm test          # 17 项隔离测试
node tests/smoke.mjs
```
