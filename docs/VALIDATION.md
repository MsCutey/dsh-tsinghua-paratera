# Windows 修复版验证记录

日期：2026-11-07。版本：`1.0.5-windows.3`，基于上游 `1.0.4` / `90a6540a901f7a139727990833f12114cce7c14e`。

## 环境

- 实际 Windows 开发机；Windows PowerShell 5.1。
- DSH 宿主：`0.2.1-rc.5`；通过 Electron 的 Node 模式读取安装包 SDK，不启动另一个 GUI/server。
- Node.js 24；使用 DSH 附带 Node 与 pnpm 运行最终回归。
- 自动回归只用临时目录或内存假数据。用户明确授权的真实密钥生命周期验收由插件正常消费既有登录态，不读取或展示密码/完整 API 密钥，不读取浏览器 cookies，不修改 DSH 安装包。

## 已执行

| 验证 | 结果 | 边界 |
| --- | --- | --- |
| `pnpm test` | 351 项：346 通过，0 失败，5 跳过 | 隔离 DSH_HOME / LOCALAPPDATA |
| 新建并导入（创建时一次性明文） | 通过（单元/路由/回环） | 明文只在宿主内；缺明文、无模型、凭据失败、并发、名称默认值均有回归 |
| 真实创建协议探针 | **通过一次** | 2026-11-12：create 返回明文（25 字符）、verify 85 模型、按名称唯一识别、删除成功无残留 |
| 已安装 Windows DSH SDK 契约 | 4/4 通过 | 真实 React/slot/Settings/credentials 模块，虚构密钥及临时存储 |
| 临时 Unicode profile 的真实 pnpm 生命周期 | 通过 | 安装、verify、幂等重装、卸载、重复卸载；始终 `--no-task` |
| Windows PowerShell 5.1 脚本语法与任务行为 | 通过 | ScheduledTasks cmdlet 设 mock/guard，未操作真实任务 |
| Windows 密码状态与删除 | 通过 | 仅临时假 blob，不解密；覆盖窗口启动竞态与权限失败 |
| 真实平台新建→删除→核验 | **通过一次** | 用户明确授权；仅本次随机新建临时密钥，最终 UUID/名称均缺席，cleanupRequired:false；未操作已有密钥 |
| 官网认证链与固定向量 | 通过 | 抽取真实公开 SparkMD5/HTTP 调用链，假 token 离线复现，修后签名/body 一致 |
| 新建/分页/删除的回环 HTTP 集成 | 通过 | 真实本机 HTTP 服务，旧 SHA-256 拒绝、MD5 通过，验证已有假密钥保留 |
| 密钥未知结果与分页核验 | 通过 | 无成功码不误报创建；500 后已消失、仍存在、分页失败、超时/未知均区分；不重试变更 |
| 网络集成重复稳定性 | 10/10 次通过 | Windows Node 24.21.0；每轮 4 项，修正测试服务器 keep-alive/强制退出竞争后重复验证 |
| 卸载数据安全 | 通过 | 自定义 home、已知临时文件、活跃锁、共享 profile、无关 YAML、CRLF/引号、复杂 YAML 原样拒绝 |
| Windows 安装入口 | 通过 | 真实 PowerShell 调用隔离 Unicode home，仅预览不写入 |

普通回归跳过的 5 项：4 项已安装 SDK 检查（随后单独运行全部通过），以及 1 项仅适用于非 Windows 的 Chrome SingletonLock 检查。没有把跳过项算作通过。

最终全量回归命令：

```powershell
# 使用相应 DSH Node / pnpm 路径，或环境中已有的 pnpm
pnpm test
node scripts/verify-host-sdk.mjs --electron '<安装目录>\DeepSeek Harness.exe'
```

## 独立审查与额外修复

审查使用纯函数与临时假文件复现，发现并修复：

- 嵌套 `paratera` 键造成无关 provider 损坏；默认模型的嵌套 `provider` 引起误删。
- 同 home 多 profile 卸载共享数据误删，及 Windows profile 大小写误识别。
- Windows `pnpm.cmd` 不能直接被 spawnSync 执行的问题。
- 复杂 YAML 未识别却假报清理成功的问题：现在预检拒绝，不写配置或删除数据。
- TGZ 包装清单漏掉 Windows 新入口的问题。

## 未进行的验收

- 没有重新进行真实清华账号登录/二次认证；本次密钥真实验收复用经授权的既有会话，不涉及密码输入。
- 没有注册、停止或删除真实 Windows 计划任务。
- 没有在原生密码窗口输入真实密码，也没有真实密码 DPAPI protect/unprotect 测试。
- 没有重新实测 macOS，不保证所有宿主版本或 Windows 版本。
- 认证协议错误已修复且真实新建/删除通过，但不据此保证所有账号、权限、配额、网络故障或未来平台变更都不再失败。详细根因、公开证据及验收范围见 [密钥管理修复记录](KEY-MANAGEMENT.md)。

## 交付与清理边界

源码 ZIP 与插件 TGZ 均由明确允许的文件构建，不携带开发目录、node_modules、真实 profile/凭据/日志。构建使用独立干净提交元数据，不推送上游。归档检查与解包后隔离安装验证以交付时的实际工具输出为准。

卸载有意保留恢复备份、源码目录及 DSH 凭据服务中的密钥引用；不能把「插件已卸载」等同于「远端密钥已撤销或宿主所有凭据已删除」。详细步骤和边界见 [Windows 指南](WINDOWS.md)。
