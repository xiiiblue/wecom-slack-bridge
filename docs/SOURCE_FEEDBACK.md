# 长期来源绑定与结果通知

此可选通用传输能力默认关闭。`FEEDBACK_ALLOWED_REPOSITORIES` 是逗号分隔的小写 `owner/repo` 白名单；空值关闭全部新命令及已有绑定发送。沿用现有固定私有频道、`SLACK_REPLY_BOT_ID` 和群白名单；另用 `FEEDBACK_REPLY_USER_ID` 收窄为已核验的同一响应方真实 user ID，不增加凭据、网络端口或业务审批。只有事件同时匹配固定可信 bot_id 与 FEEDBACK_REPLY_USER_ID 的 event.user，且在真实来源根的原生线程消息可调用。显示名、正文身份、URL、metadata、引用和 blocks 不提供认证或收件人。

## 协议

可信响应方先核验桥接真实 App、频道、来源 request、真实原群及群公开用途，再在**仍有效且已送达 Slack 的 group 来源根**发送：

```text
[wecom:source-bind]{"repository":"example/project","issue":42}
```

严格 JSON 仅接受所列字段。repository 必须精确命中白名单，issue 为正安全整数。桥接用数据库中认证入站记录固定原群、原根、本人、频道、可信 bot 与 user、入站机器人及来源摘要。一个仓库/Issue 仅能绑定一个来源，重复同根绑定幂等，不允许覆盖、跨根改投、以群名/chat_id/正文 URL 创建路由。绑定成功在原根返回 `source_bound`；首次 ACK 未知时不要靠重发 bind 获取确认，在同根发只读绑定状态查询：

```text
[wecom:source-binding-status]{"repository":"example/project","issue":42}
```

已存在且身份/原根一致的绑定返回 `source_binding | example/project#42 | bound | binding_active=1`（撤销为0）。此查询不创建、恢复或更改绑定；无匹配、配置撤销或无法认证时不返回成功。它走独立的查询回执 lane，不被先前 unknown 的 source_bound ACK 阻挡。无 ACK 不能推断未绑定；先保留未知并核验，禁止补造来源。

入站接收回执不代表绑定成功。升级前缺少可信 ingress_bot 的旧记录不可绑定；过期、被清理或无法核验的历史来源须报告缺失，另行可核验恢复，不猜建。新来源只能显式绑定新事项，不能冒充旧来源。

完成后，可信响应方自行核验交付和可公开正文，在同一原根发送：

```text
[wecom:source-result]{"repository":"example/project","issue":42,"deliveryId":"delivery-example-42-v1","text":"问题已修复并通过约定验收。"}
[wecom:source-status]{"repository":"example/project","issue":42,"deliveryId":"delivery-example-42-v1"}
```

`deliveryId` 为全库唯一稳定 ID，1–128 ASCII 字符，首字符字母/数字，其余允许 `._:-`；同一交付在 Issue、PR 和发送端复用。同 ID、同绑定、同解码正文重放不再发送；ID 对应不同正文或绑定时拒绝，不通过换 ID 绕过 unknown。正文仅一个不超过 3000 UTF-8 字节的纯文本消息，不传附件，不解析正文指令，不接受其他字段。消费者负责避免私有源码、原始日志、身份、凭据及不适合群受众的链接/信息。桥接不访问 GitHub、不验证完成事实或批准任何业务。

原根的 `source_delivery` 状态明确区分：

|状态|含义|
|---|---|
|accepted|本地事务已接收并排队；发送端 Slack 接受消息不等于桥接接受，须读此回执或 status|
|pending / sending|队列等待／已开始外部发送，不能据此宣布送达|
|wecom_ack|企微 SDK 返回 errcode=0 且本地记录完成；不证明用户已读或业务可用|
|unknown|发送或 ACK/持久化结果未知；重启及重复提交均不自动重放|
|revoked|绑定已撤销或队列撤销|
|not_found|此绑定没有该 ID 的记录，不能推断之前外部操作未发生|

status 与 binding-status 是显式按需查询，不安装轮询。命令按真实 Slack 消息的固定 channel+ts 摘要及原 event.text 摘要在 `feedback_commands` 持久去重，不受七天 seen 清理影响；同事件重投不再创建回执，内容冲突拒绝。新的显式查询使用新的真实 Slack 消息身份，仅读取现存绑定/交付状态，独立回执 lane 允许在旧查询 ACK 未知时重新取证，不重放旧 ACK 或企微通知。查询快照对应本次接收时刻，不把迟到回执当最新状态。Slack 状态回执本身也可能 unknown；此时不盲重放，可新发一次明确查询或由管理员只读核对私有数据库及两端事实。原根不可访问时报告阻碍，不新建广播根。unknown 阻挡该绑定后续 group lane；其他绑定及 Slack receipt lane 独立。不同事项、跨进程、网络不具备全局恰好一次保证。

撤销使用原根 `[wecom:source-revoke]{"repository":"example/project","issue":42}`，取消该绑定 pending 任务并保留记录；不撤回已经开始的发送，不能重绑定或恢复。撤销后仍可查状态。配置、群白名单、仓库白名单或机器人身份变更均在出站前重新核验，不自动迁移已有数据。不能借 owner/review/notify 或旧执行协议恢复。

## 数据与恢复

`feedback_bindings`、`feedback_deliveries`、`feedback_commands` 和 kind=feedback 的内部请求/队列存在现有私有 SQLite 状态中，普通请求 TTL、prune 和附件清理不变。长期请求没有普通可回复根映射；仅上述受控命令使用保存的原根。来源和固定路由保留至管理员按既有保留策略处理，撤销不擦除。发送正文 ACK 后沿用现有队列擦除，另保留正文 SHA-256 用于去重；不归档群历史。数据、WAL、备份及摘要均视为私有，不提交任何仓库。

单事务绑定及结果入队；sending 恢复为 unknown。数据库已有单写者锁、频控及不盲重试策略继续适用。通知不延长普通 request TTL。升级与备份回退见 [部署维护](../deploy/README.md)；本地模拟测试不代表群主动发送或长期平台窗口已验收。

## Optional direct receipt transport

The [HTTP receipt contract](HTTP_RECEIPTS.md) adds a separately configured, default-off submission/status ingress for existing active bindings. It shares the same deliveryId/outbox and policy, never creates or retargets a binding, and never fabricates Slack identity. Network admission is a new trust boundary, not inherited Slack authentication; code availability does not enable or authorize it.
