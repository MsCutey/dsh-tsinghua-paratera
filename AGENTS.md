# AGENTS.md — 安装与维护协议（给 AI 代理）

本文件是机器可执行的安装说明。人类用户说"帮我装一下这个插件"时，按下面步骤执行，不要即兴发挥。

## 目标

把 `dsh-paratera-balance` 链接进 DSH 的 `desktop` profile，使设置页出现「清华算力余额」，
并在输入栏显示算力券余额。

## 前置条件（先检查，缺一即停）

| 条件 | 检查命令 | 不满足时 |
| --- | --- | --- |
| Windows 10/11 | `uname -s` 或 `$env:OS` | 停止，说明仅支持 Windows |
| Node ≥ 22 | `node --version` | 停止，或改用 DSH 自带 node |
| DSH profile 存在 | `Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\package.json"` | 停止，请用户先启动一次 DSH |
| Chrome 已安装 | `Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe"` | 警告：静默登录不可用，仍可手动登录 |
| git 可用 | `git --version` | 改用下载 zip 的方式 |

## 安装（标准路径，二选一）

**A. 从仓库克隆（推荐）**

```text
git clone https://git.tsinghua.edu.cn/bbc26/dsh-paratera-balance.git "%USERPROFILE%\.dsh\plugins\dsh-paratera-balance"
node "%USERPROFILE%\.dsh\plugins\dsh-paratera-balance\scripts\install.mjs"
```

**B. 已经有本地目录**

```text
node <插件目录>\scripts\install.mjs
```

脚本做的事（不要手工重复）：

1. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dependencies` 写入
   `"dsh-paratera-balance": "link:<插件绝对路径>"`（幂等）
2. 在 `dsh.profile.bundles` 追加 `"dsh-paratera-balance"`（幂等）
3. 用 DSH 自带的 pnpm 执行 `pnpm install --dir <profile>`
4. 输出 JSON 摘要

## 成功判据（必须逐条核对）

```text
node <插件目录>\scripts\install.mjs --verify
```

期望输出 `"ok": true`，且 `linked`、`bundleListed`、`moduleLinked` 均为 `true`。

然后提示用户（不要代替用户操作）：

1. 完全退出并重启 DSH（托盘退出）
2. 设置 →「清华算力余额」→「保存凭据」，输入一次清华账号密码

## 凭据边界（硬性）

- **不要**读取、打印、复制或修改 `~/.dsh/easycompute-credentials.bin`
- **不要**向用户索要密码；密码只能由用户在本机对话框输入
- **不要**在命令行参数、环境变量或日志里传递密码

## 后台续期（可选）

```text
powershell -NoProfile -ExecutionPolicy Bypass -File <插件目录>\scripts\setup-windows-task.ps1
```

注册任务 `DSH Tsinghua Balance Refresh`，每 6 小时静默续期。注册后可用
`Start-ScheduledTask -TaskName 'DSH Tsinghua Balance Refresh'` 立即验证，
`LastTaskResult` 应为 `0`。

## 失败处理

| 现象 | 处理 |
| --- | --- |
| `profile-not-found` | 让用户先启动并退出一次 DSH，再重试 |
| `pnpm-failed` | 设 `DSH_PNPM=<DSH安装目录>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs` 后重试 |
| `--verify` 里 `moduleLinked=false` | 重新执行安装（会重跑 pnpm） |
| 重启后设置页没有条目 | 检查 bundles 是否包含插件名，再看 DSH 启动日志 |
| 界面显示「需登录」 | 正常：让用户点「重新登录」，或检查 `~/.dsh/easycompute-state.json` 的 `lastError` |

## 卸载

```text
node <插件目录>\scripts\install.mjs --uninstall
```

仅移除 manifest 条目并重跑 pnpm；不删除凭据、会话和日志文件。
