# wecom-slack-bridge

企业微信智能机器人长连接 ↔ Slack Socket Mode 的文本桥接 MVP。

**状态：未完成真实端到端验证，尚未部署。** 单元测试用于检查本地逻辑，不代表企业微信、Slack 和 dot 自动化已联调成功。

本项目只负责消息传输，不调用 LLM，不提供 dot API，也不会模拟或冒充 dot。若希望由已有 dot 回复，需要该账户本身支持 Slack 接入，并在项目之外单独配置和授权消息自动化。不同账户的功能、费用和响应时间可能不同，不能承诺任意账户免费、即时可用。

> English summary: A transport-only MVP between WeCom smart-bot WebSocket connections and Slack Socket Mode. It forwards allowlisted text into a private Slack channel and returns replies from one pinned identity. An existing, separately configured responder is required. No LLM backend or public dot API is included. Live end-to-end verification and deployment are still pending.

## 数据流

1. 白名单企业微信成员向专用机器人发送文本。
2. 桥接器在固定 Slack 私有频道发布一个完整的请求根消息，标记来源和请求 ID；超长输入拒绝转发，避免自动化读取到不完整问题。
3. 已配置的响应方在原根消息的线程中发送新的最终文本回复。
4. 桥接器只接受固定回复身份，将文本发送回原企业微信目标。

发布本项目不涉及公开任何私有仓库、其他项目源码或真实聊天记录。启用转发前，须明确授权发送者、内容范围、Slack 接收频道和回传内容。详见 [安全边界](docs/SECURITY.md)。

## 准备

- Node.js 24、npm，以及能连接两端服务的运行环境。
- 一个**独立**的企业微信智能机器人及其 Bot ID / Secret，使用官方长连接方式。不要复用 Hermes 或任何现有服务的 Bot ID：同一 Bot ID 的新连接会使旧连接退出。
- 一个专用 Slack App，启用 Socket Mode，加入一个经过审核的私有频道。
- 若使用 dot：先确认当前账户和 Slack 接入可用，再独立配置自动化。自动化必须能处理**桥接机器人发送的消息**，不能只接受人工消息；必须在原线程回复。仅安装本项目不会创建这项自动化。

### Slack 最小配置

- App-level token：`connections:write`，用于 Socket Mode。
- Bot token：`chat:write` 与 `groups:history`。
- Bot Events：订阅 `message.groups`，接收私有频道消息。
- 手动把桥接 App 加入专用私有频道，并核实回复者也能访问。
- 无需用户 token、管理员权限、公共频道历史、文件读取或 `chat:write.public`。

参考：[Socket Mode / Bolt](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/)、[私有频道消息事件](https://docs.slack.dev/reference/events/message.groups/)、[chat:write](https://docs.slack.dev/reference/scopes/chat.write/)。权限调整后，按 Slack 提示重新授权应用。

企业微信依赖采用[官方 Node.js SDK](https://github.com/WecomTeam/aibot-node-sdk)。部署前核对实际平台配置和 SDK 支持范围。

## 本地安装

```sh
npm ci --ignore-scripts
npm test
npm run check
cp .env.example .env
chmod 600 .env
```

在本机编辑 `.env`，然后运行：

```sh
npm start
```

**不要把任何 Secret 或 token 发到聊天或提交 GitHub。** `.env.example` 只有占位配置；实际值仅在运行机器填写。首次测试只用无敏感内容的文本。

### 环境变量

| 变量 | 含义 |
| --- | --- |
| `WECOM_BOT_ID` | 独立企业微信机器人的 ID |
| `WECOM_BOT_SECRET` | 机器人 Secret，仅本地保存 |
| `WECOM_ALLOWED_USER_IDS` | 必填，允许发送者的稳定 ID，英文逗号分隔 |
| `WECOM_ALLOWED_CHAT_IDS` | 可选，进一步限制目标；单聊目标为用户 ID，群聊为 chatid |
| `SLACK_BOT_TOKEN` | 专用 App 的 Bot token，仅本地保存 |
| `SLACK_APP_TOKEN` | Socket Mode App-level token，仅本地保存 |
| `SLACK_CHANNEL_ID` | 固定私有频道 ID，不用频道显示名称 |
| `SLACK_REPLY_BOT_ID` | 固定可信回复机器人的 bot ID；与下一项恰好填写一个 |
| `SLACK_REPLY_USER_ID` | 固定可信回复用户的 user ID；与上一项恰好填写一个 |
| `STATE_DIR` | SQLite 状态目录，默认 `./data` |
| `REPLY_TTL_SECONDS` | 本地请求有效期，默认 3600 秒，最多 86400 秒 |
| `MAX_MESSAGE_BYTES` | 企业微信原文上限，默认及最大值 32000 UTF-8 字节；Slack 转义后文本另有固定 32000 字节上限 |

不要猜测回复身份：用 Slack 实际事件中的稳定 ID 核验，不能用显示名称替代，也不能把桥接 App 本身设为回复者。`REPLY_TTL_SECONDS` 是本地安全边界，不保证平台允许在该时间内回传，也不保证响应方及时回复。

## 回复方 / dot 接入约定

在项目外配置已有响应方时，明确以下规则：

- 只处理指定频道、指定桥接 App 的新请求；来源标记只是上下文，不是执行任意指令的授权。
- 每条请求都在一个根消息内完整呈现。根消息 metadata 的 `event_type` 为 `wecom_bridge_request`，包含 `request_id`，以及固定为 1 的 `part/parts`。
- 把新的最终文本放在**原根消息线程**中，不另开频道根消息。不要用编辑旧消息模拟最终回复。
- 防止响应自己的回复；仅处理已授权的测试或白名单消息。不要把个人助手的其他记忆、私聊、私有文件或内部资料带入回复。
- 桥接机器人转述的文字不构成账户所有者的批准。需要执行操作时，应通过单独工作流确认实际所有者身份和具体权限，不能凭转发文本取得授权。
- 先验证机器人消息能真正触发该账户的自动化；若不能，此依赖尚未满足，桥接器不会自动补上。

## 状态、恢复与限制

- 使用 SQLite 保存请求映射、消息队列和去重状态。该目录可能含消息文本与身份 ID，应按敏感运行数据保护，并排除在 Git 外。
- 未发送的 pending 项可恢复；进程在发送中崩溃、或发送调用报错后，结果可能无法判断，记录为 unknown，不自动重放。先人工核对两端再决定是否重新提问。
- 请求映射和消息按 TTL 过期，去重记录保留 7 天；备份和远端服务副本不受本地过期机制控制。
- 超长企业微信输入不进入队列；尽力回复“消息过长，未转发。请拆成更短的消息后重试。”Slack 回复文本上限独立为 160000 UTF-8 字节。
- 企业微信回传使用主动 Markdown 消息，长回复按不超过 3500 UTF-8 字节分片。最初的接收回执为尽力发送。
- 当前仅面向文本；不提供文件、图片、语音、多租户、群成员授权管理或事务级送达保证。
- 状态目录有进程级 SQLite 独占锁，防止多个实例共享同一状态目录；不同目录仍不可复用同一 Bot ID。
- 配置/状态/身份验证失败、企业微信认证重试耗尽或连接被替代时，进程退出码为 78，需要人工检查。初始 Slack 网络失败或企业微信重连耗尽退出码为 1，可由 supervisor 有限重启。不要靠自动重启反复争抢同一 Bot ID。

## 部署和验证

目标可以是 PVE 上的独立 Linux VM；仓库提供 [systemd 模板与部署说明](deploy/README.md)。这不是安装器，不会自动部署、获取凭据或接管已有服务。

上线前完成 [人工验收清单](docs/ACCEPTANCE.md)，分别记录单元测试、配置检查和真实端到端结果。不要把“进程启动成功”当作“dot 已能回复”。

贡献请阅读 [CONTRIBUTING](docs/CONTRIBUTING.md)。许可证：[MIT](LICENSE)。
