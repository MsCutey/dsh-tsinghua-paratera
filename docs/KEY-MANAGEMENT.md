# 新建 / 删除密钥：认证根因与验收

修复版本：`1.0.5-windows.2`。日期：2026-11-07。

## 已确认根因

原插件把 `Ai-Authorization` 计算为 `Bearer SHA256(token)`，但官网实际使用的是 **`Bearer MD5(token)`，32 位小写十六进制**。方法、JSON 参数看起来相同，并不代表完整请求一致；上一版只核对方法和参数，漏查了打包器导入别名对应的真正哈希库。

公开调用链：

1. [主 bundle](https://ai.paratera.com/assets/js/index-CdbFYLD1.js) 导入 `S as $e`，认证中间层调用 `$e.hash(T)`。
2. [vendor bundle](https://ai.paratera.com/assets/js/.pnpm-ConQ38Y1.js) 将 **SparkMD5** 导出为 `S`；不是 SHA-256。
3. [UI 页面](https://ai.paratera.com/assets/js/index-CLU5W59i.js) 和 [LMS actions](https://ai.paratera.com/assets/js/lms-DoN-e3lZ.js) 走同一套认证中间层与原生 fetch：
   - 新建：`POST /lms/api/key/create`，`{tokenName,billingType:'PostPaid'}`。
   - 删除：`DELETE /lms/api/key/delete`，`{tokenUuid}`。
   - 仍发送原始 `token` header；JSON 内的 opaque ID 不做 URL 编码，也不应额外 AES/RSA 加密。

MD5 在这里仅为兼容平台既有认证协议，不是密码存储或新的密码学安全设计；没有把其他 SHA-256 用途（例如密钥指纹）改成 MD5。不复制浏览器 cookie、不放宽携带凭据的重定向限制。

## 证据不是 mock 自证

研究时从公开 JS 抽取了真实 SparkMD5 实现及 UI → action → HTTP middleware → JSON serializer → fetch 调用链，在隔离 VM 中用假 token 和内存 fetch 执行，然后与产品实现对照。POST 和 DELETE 的认证值与 body 完全一致；原 SHA-256 版本与官网不一致。

公开资源 SHA-256：

| 资源 | 原始字节数 | SHA-256 |
| --- | ---: | --- |
| 主 bundle | 85884 | `9eb3d1bfd2d0bab02934e4c5898467d96ccc2feddf66072464e6773670c058af` |
| vendor bundle | 6827293 | `d5a535934b80d883351e3f13d1c766c2bbb44e8cd507272fc362516ce5715005` |
| LMS action bundle | 1053 | `953c500289386a36bc5de078b480d0b4f5ccc93dca129368bd1af502c7eaa0ca` |

将下列公开假数据向量固定在测试中，避免测试仅重新调用产品使用的哈希函数自证：

| 假 token | 官网 SparkMD5 结果 |
| --- | --- |
| `abc` | `900150983cd24fb0d6963f7d28e17f72` |
| `FAKE.PUBLIC.RESEARCH.TOKEN` | `3568428af04729d163c4c1c87dab3d9a` |
| `FAKE-中文` | `6b9e80b09a1e69f6c286ce4f049a13b4` |
| `令牌-🔑` | `4f8326c0152c4d6220c53270be3a9c7d` |

## 真实平台验收：已通过

2026-11-07 21:13（Asia/Shanghai），用户明确允许复用本机插件既有登录态后执行一次生命周期验收：

1. 完整读取基线列表，不显示或导入任何完整密钥。
2. 创建一个随机专用名称、29 字符的测试密钥。
3. 完整读取列表，仅在名称唯一且 UUID 不属于基线时识别为本次新建。
4. 只对该新 UUID 执行一次删除。
5. 再次完整读取列表，确认该 UUID 与本次随机名称都不存在。

结果：**`ok:true`、`stage:complete`、`cleanupRequired:false`，真实新建与删除均成功。** 未删除已有密钥，未调用模型推理或创建付费订阅，没有自动重试变更请求；未重新登录、读取密码或输出 token/cookie/完整 API 密钥。包含本机信息的验收回执留在排除发布的开发产物目录，不随包发布。

这不是“所有平台错误都由 MD5 引起”的断言，只证明修正确定的协议错误后，该用户当前会话的新建和删除流程已经真实通过。

## 额外错误处理

- HTTP 200 但业务成功码缺失、格式错误或显式失败时，不再误报新建成功。
- 新建超时/网络中断/不明确响应提示结果未知，先刷新并按名称核实，不直接重复新建。
- 删除后仍执行完整分页核验；列表不完整、异常或目标仍存在时不会假报成功。
- 控件保留失败时的草稿和确认信息，操作中防重复提交。

## 平台改为“只显示一次”后的新流程

2026-11-12 起，控制台移除了列表行的“眼睛”：完整密钥只在**创建成功弹窗**里出现一次，列表只保留 `sk-...XXXX` 掩码。因此：

- **已有密钥无法再次读取**，任何客户端（包括官网）都取不回来。这不是插件缺陷，不能靠改选择器修复。
- 导入改为**新建并导入**：在插件里点「新建并导入」，名称默认是**本机设备名**（可改）；宿主创建后立即拿到一次性明文，直接写入 DSH 凭据并追加可用模型。明文不经过前端、不写日志、不进进度快照。
- 列表里的「导入」仍保留，但提交时会明确提示平台已取消查看，避免让人误以为还能读旧密钥。
- **删除功能保留**：删除后仍做完整分页核验，结果未知时提示先刷新，不自动重试。

跨设备使用时，推荐**每台设备各建一把独立密钥**（创建时即导入），不要尝试复制已有密钥；这样也能单独禁用或撤销某台设备。

关键实现事实（已用真实接口验证）：`POST /lms/api/key/create` 的 `data` 是**字符串**，官网 `showSecretKeyAfterCreate(e)` 直接取 `e.data` 显示；插件据此在宿主内部取明文。若创建被接受但未返回明文，返回 `key-create-secret-missing` 并提示到控制台按名称清理，绝不猜测或重复创建。

真实协议验证（2026-11-12，临时密钥，已删除）：创建返回一次性明文 → 公共模型列表校验通过（85 个模型）→ 列表按名称唯一识别 → 删除成功，无残留。

## 自行复验入口（默认禁用）

只在已连接控制台、可以创建一个临时密钥、没有并发密钥管理操作时使用。默认运行只输出说明，不读取会话，不做网络请求；必须同时提供两个开关：

```powershell
node scripts/verify-key-lifecycle.mjs --live --confirm-create-delete --receipt .artifacts/NEW-unique-receipt.json
```

入口不接受已有密钥的 UUID 或名称；只使用随机专用名称，并拒绝覆盖已有回执。任一步骤不确定就停止，不自动重试 create/delete。如果提示 `cleanupRequired:true`，请到官方控制台按输出的**本次测试名称**核实并清理，勿直接再运行。不要上传回执、会话文件或原始网络响应。

## 自动化验证

- 固定官网算法向量和完整官方链离线对照。
- 真正的回环 HTTP 服务验证 POST/DELETE 请求，拒绝旧 SHA-256 认证头、接受 MD5；完整新建、分页列表、删除、核验，并验证已有假密钥保留。
- 无业务成功码、认证过期、配额、超时、分页失败、opaque ID 换表示、同名歧义与回执失败等安全分支。
- 全量统计及宿主 SDK 检查见 [验证记录](VALIDATION.md)。
