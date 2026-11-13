# Architecture

## 当前在线路径

- `lib/index.js` 注册经 `connection.requestRejection` 鉴权的路由，服务跟随宿主注入/销毁；`lib/client.js` 提供输入栏余额和设置页，不接收密码、token 或完整密钥。
- `lib/create-session.mjs` 是每个插件实例独立的三步导入控制器：创建/校验 → 等待模型选择 → 保存密钥和所选模型。一个实例最多一个未完成操作，requestId 防重复 CREATE；状态和响应均白名单投影。
- `lib/import.mjs` 复用密钥校验、凭据备份/保存和模型追加逻辑；提交前校验选择，失败不提前消耗一次性密钥，部分成功不撤销已保存凭据。旧眼睛流程不再作为在线入口。
- `lib/keys.mjs` 负责固定控制台接口的新建、列表、改名、启停、删除；`lib/console.mjs` 完成控制台会话交换及官网兼容的 MD5 认证。DELETE 最多一次，随后完整分页读取核验。
- `lib/models.mjs` 使用修订号 Settings 更新单个供应商，追加导入不覆盖用户已有模型参数。

## 一次性密钥的生命周期

完整密钥只进入当前实例内存和宿主凭据服务。内存最长保留10分钟，真实定时器到期丢弃明文引用，dispose 清理但不产生网络删除；状态恢复只发元数据和候选模型。没有新的磁盘 vault、浏览器存储或云同步。页面刷新可恢复未完成操作，宿主重启不恢复明文。

取消不是按名称删行：只有完整基线和创建后完整列表证明是本次唯一新 UUID，且密钥未保存到宿主时，显式二次确认才允许删除；无法证明则提示手动核实。创建/删除不因超时盲目重试。

## 既有独立功能

`refresh.mjs` 管理专用 Chrome、动态回环 CDP、刷新锁和登录状态机。`browser-security.mjs` 将密码/验证码绑定到验证后的 SSO frame 与隔离上下文；`privacy.mjs` 管理响应和缓存投影。Windows 密码窗口使用 DPAPI，Mac 使用 Security/Keychain；后台任务均为可选项。

## 测试

普通回归使用隔离 DSH_HOME、假网络和假凭据。额外 SDK 验证使用已安装宿主的真实 React/Settings/credentials 模块、临时文件与 jsdom，不启动替代服务器、不改用户 profile。可选截图由假数据 DOM 生成静态 HTML，再交独立无头 Chrome 渲染，不表示真实账号验收或当前 GUI 已热更新。
