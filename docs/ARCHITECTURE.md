# Architecture

`lib/index.js` 注册经过宿主鉴权的路由；`lib/client.js` 提供输入栏标记与设置页。前端不接收密码、会话 token 或完整 API 密钥。

`refresh.mjs` 管理专用 Chrome、动态回环调试连接、跨进程刷新锁和登录状态机。`browser-security.mjs` 把敏感操作绑定到验证后的 SSO frame 与隔离执行上下文。`privacy.mjs` 管理磁盘/API 数据投影。

`console.mjs` 在固定平台间完成控制台授权；`keys.mjs` 执行明确的密钥管理操作；`reveal.mjs` 仅读取用户选择的密钥；`import.mjs` 验证并交给宿主保存；`models.mjs` 通过修订号 Settings 修改单个供应商的模型配置。

原生密码窗口分别使用 Windows DPAPI 和 macOS Security/Keychain。后台任务为可选项，使用当前用户计划任务或 LaunchAgent。

普通测试隔离文件、网络和凭据；额外验证使用本机安装包的 SDK、浏览器 React 与插槽，或临时 Chrome / loopback server / 独立测试任务。它们与真实账号验收分开。
