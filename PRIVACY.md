# 隐私说明

## 数据流

| 操作 | 目的地 | 发送的数据 |
| --- | --- | --- |
| 清华账号登录 / 二次认证 | `https://id.tsinghua.edu.cn` | 用户主动保存或输入的账号、密码、验证码 |
| 会话与余额 | `https://easycompute.cs.tsinghua.edu.cn` | 平台会话 token / 控制台授权码 |
| 控制台与密钥管理 | `https://ai.paratera.com` | 控制台会话 token、选择的密钥标识及明确提交的管理参数 |
| API 密钥验证 | `https://llmapi.paratera.com/v1/models` | 所选 API 密钥，仅用于获取可用模型列表 |
| 开发者手动更新推荐目录 | 平台模型广场、`https://openrouter.ai/api/v1/models` | 公开目录请求，不携带本插件的登录凭据 |

宿主 HTTP 请求禁止携带凭据跟随重定向；密码/验证码只对固定 SSO 域名的执行上下文提交。新建、删除、导入密钥都需要用户在界面发起。

插件代码没有遥测、广告、崩溃上报或分析服务。浏览器、宿主及其他已安装插件仍可能有自身网络行为；这份说明不代替它们各自的隐私政策。

## 本地存储

- **登录密码**：可选。Mac 保存在当前用户 Keychain；Windows 用当前用户 DPAPI 加密保存。状态轮询仅检查存在性，不返回密码。自定义 `DSH_HOME` 使用独立命名空间/文件。
- **短期 token**：位于 `DSH_HOME/easycompute-session.json` 和 `paratera-console-session.json`；是 bearer token，不是匿名数据。Unix 新写文件为 `0600`，专用目录为 `0700`。普通缓存文件没有额外应用层加密，请保护 OS 用户账户和磁盘。
- **余额缓存**：`easycompute-state.json` 只保存必要数值、时间、固定错误码和操作布尔值；不保留院系、班级或用户 UUID。新版写入时会丢弃旧状态中的非白名单字段。
- **API 密钥**：导入后交给 DSH 凭据服务。宿主可能使用本地凭据文件，不能把“只在宿主保存”理解成硬件加密。插件不直接回传完整值，显示的指纹是哈希摘要。
- **Chrome profile**：与日常浏览器分开，仍包含登录 cookie、站点存储及浏览器历史。默认 Mac 路径是 `~/Library/Application Support/DSH Tsinghua Paratera/Chrome`；Windows 为 `%LOCALAPPDATA%/dsh-tsinghua-paratera-profile`。自定义 home 使用 `DSH_HOME/browser-profile`。

后台续期默认关闭，使用 `--task` 主动开启。信任浏览器默认不选中，用户可明确选择平台提供的长期信任。关闭插件/卸载并不自动注销平台会话。

## 清理与反馈

先退出专用 Chrome，再清理上述插件专属缓存/profile；不要删除整个 DSH_HOME。Mac 密码可在钥匙串访问中删除 `DSH 清华算力（Paratera）` 条目；Windows 可删除对应 DPAPI blob。导入的 API 密钥可能被多个模型使用，需要在 DSH 或平台中单独删除/撤销。

不要在公开 issue、日志、截图或打包文件中提供密码、验证码、完整密钥、cookie、token、个人 profile 或未脱敏账户信息。

## 安全边界

本插件、DSH 和同源插件属于同一个信任域。持有当前 OS 用户权限、DSH 已认证会话或本机调试权限的程序可能访问本地数据；不把本插件当作恶意程序隔离沙箱。
Chrome 自动化使用仅绑定回环地址的调试端口。无头进程在操作后关闭，二次认证等待有超时；用户保持打开的专用窗口会保留其调试能力，因此应在使用后退出专用 Chrome。
如果不能信任这台设备上其他本地程序或用户，请不要保存密码，并及时退出/注销专用会话。
