# 配置指南

## 平台准备

1. 创建独立企微**智能机器人**，使用官方长连接 Bot ID/Secret，不是群 Webhook 或自建应用 access_token。新安装不要复用已有服务的 Bot ID；更新同一服务时不要启动第二套连接。
2. 获取已核验的本人 userid 和授权群 chatid。不要从显示名猜测；平台身份可能是加密标识，不能擅自换成其他应用中的 ID。每个授权群内所有成员均可提问，文本不提供逐成员群白名单；可选附件入口有独立发送者白名单。
3. 创建专用 Slack App，启用 Socket Mode；将桥接 App 和响应方加入成员范围经过审核的**私有频道**。不要使用公共频道或 Slack Connect 频道。程序检查固定频道 ID，不能仅凭 ID 前缀判断频道私有性，必须人工核验实际设置与成员。
4. 明确哪些文本可以跨服务，以及 Slack 频道中的成员、应用均可能看到本人私聊和评审内容。先审核受众，再启用转发。

### Slack 最小范围

|配置|所需值|
|---|---|
|App-level token|`connections:write`，用于 Socket Mode|
|Bot token|`chat:write`、`groups:history`|
|Bot Events|`message.groups`|
|频道准入|手动加入专用私有频道|

纯文本不需要用户 token、管理员权限、公共频道历史、文件读取或 `chat:write.public`。可选[双向附件](ATTACHMENTS.md)上传另外需要桥接 bot 的 `files:write`，反向群附件需要桥接 bot 的 `files:read`；响应方也须有已授权的文件读取和原生上传能力；不自动添加 scope 或重新授权。权限与令牌由账户所有者在平台配置；程序不会创建令牌或自动批准新授权。变更权限后遵循平台重新授权要求。

参考：[Slack Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/)、[message.groups](https://docs.slack.dev/reference/events/message.groups/)、[官方企微 SDK](https://github.com/WecomTeam/aibot-node-sdk)、[企微长连接协议](https://developer.work.weixin.qq.com/document/path/101463)。

## 环境变量

`.env.example` 仅是空值模板，默认缺少必填值会拒绝启动。不要把真实凭据写进示例或日志。

|变量|含义与默认值|
|---|---|
|`WECOM_BOT_ID` / `WECOM_BOT_SECRET`|独立智能机器人的 ID 和 Secret，必填|
|`WECOM_OWNER_USER_ID`|唯一可单聊、接收私聊与回复编号的本人稳定 userid，必填|
|`WECOM_ALLOWED_CHAT_IDS`|非空群 chatid 白名单，英文逗号分隔；不能包含本人 userid|
|`SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`|专用桥接 App 的 bot token / app-level token，必填|
|`SLACK_CHANNEL_ID`|固定私有频道 ID，必填；不是频道名称|
|`SLACK_REPLY_BOT_ID`|可信响应机器人的事件 bot_id，与下一项恰好选一个|
|`SLACK_REPLY_USER_ID`|可信响应用户的事件 user ID，与上一项恰好选一个|
|`STATE_DIR`|默认 `./data`，相对进程工作目录；服务部署必须指定专用绝对路径|
|`REPLY_TTL_SECONDS`|默认3600，范围1–86400秒；从请求接收计算，对话不续期|
|`WECOM_ATTACHMENTS_ENABLED`|群入站附件默认 `false`；只能 `true`/`false`，真实启用另核权限和读取链路|
|`WECOM_ATTACHMENT_REPLIES_ENABLED`|原请求群的附件回传默认 `false`，需桥接文件读取权限及真实可信上传身份|
|`WECOM_ATTACHMENT_ALLOWED_USER_IDS`|附件额外发送者白名单，启用时非空，不改变文本/单聊策略|
|`WECOM_ATTACHMENT_DOWNLOAD_HOSTS`|启用时非空，管理员核验的官方 CDN 精确子域，规则见附件说明，无默认主机|
|`MAX_ATTACHMENTS_PER_MESSAGE`|默认1，范围1–3；只计当前消息，不合并其他消息|
|`MAX_MESSAGE_BYTES`|默认/最大32000，最小1，UTF-8字节；入站正文及来源经转义后另限30000字节|

回复者必须从真实平台事件核验，不能填显示名称或桥接 App 自己。启动时使用现有 token 的 `auth.test` 核验桥接身份，并拒绝自响应配置；不会借此取得新权限。可信 bot 的主动通知能力不可用于仅配置回复用户的模式。

## 安全检查与启动

本地 `.env` 限本人读写（0600），状态目录限制为0700。不要在共享可写目录放代码、依赖、状态或环境文件。自定义状态、备份目录放到仓库外；`.gitignore` 不可能覆盖任意自定义路径。

```sh
npm run config:check
```

缺失/错误配置退出78，输出变量名或固定错误类别，不输出值。检查通过只代表语法合法。它不读取状态、不调用 auth.test、不验证频道或受众、也不发消息。

按 [部署说明](../deploy/README.md) 完成唯一实例、凭据、受众和服务路径检查后再启动。只用获准的合成消息完成 [现场验收](ACCEPTANCE.md)。若接入某个智能体，须在项目外配置它接收桥接 bot 的根消息和本人线程回复，并排除自己的输出；桥接器本身不会创建该集成。
