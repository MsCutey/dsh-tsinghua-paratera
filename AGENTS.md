# Agent maintenance protocol

本项目是 DSH 的非官方插件，维护 Windows / macOS 兼容实现。

- 修改前读 README.md、PRIVACY.md、SECURITY.md；遵守用户的具体授权。
- 不读取、打印、复制真实登录密码、DPAPI 文件、钥匙串密码、API 密钥或浏览器 cookie。不要运行原生助手的 read 模式进行人工调试。
- 凭据仅由用户在本机原生窗口输入；验证码由用户输入，不通过聊天索要。
- 测试使用虚构数据和隔离目录；安装到测试 profile 时使用 --no-task，不注册真实登录项。
- 普通回归运行 pnpm test；宿主 SDK、真实 Chrome、隔离 DSH 和 launchd 验证范围见 README.md，不能以 mock 结果冒充真实账号验收。
- 插件代码更新后提示用户完全退出并重开 DSH，不擅自退出正在运行的用户应用。
- Windows 密码使用当前用户 DPAPI；Mac 使用 Keychain。状态检查不得解密密码。
- 页面传递密码/验证码必须使用受信任域名与固定执行上下文；不得扩大认证域名或自动选择长期信任。
- 所有宿主路由先经过 connection.requestRejection。响应与缓存按白名单投影，不回传完整密钥、token、原始异常或无关个人信息。
- 新网络目的地、凭据处理方式或后台行为必须更新隐私说明。
- 打包仅使用明确允许的文件；不带 .git、.local、.artifacts、node_modules、真实 profile、日志、截图或本机密钥。
- 公开发布必须扫描实际归档文件及公开提交元数据；不要把内部开发历史直接推到公开仓库。
- 优先使用 Git、CLI 和 API；只有无法通过相应接口完成的必要步骤才使用浏览器。
