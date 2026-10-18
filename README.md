# wecom-slack-bridge

企业微信智能机器人长连接 ↔ Slack Socket Mode 的文本桥接 MVP（群提问 / 本人私聊分流与短期问答关联）。

**状态：未完成真实端到端验证，尚未部署。** 单元测试用于检查本地逻辑，不代表企业微信、Slack 和 dot 自动化已联调成功。

桥接程序只负责通用消息传输及短期本人问答关联，不执行代码、不自动写 GitHub、不调用 LLM，不提供 dot API，也不会模拟或冒充 dot。若希望由已有 dot 回复，需要该账户本身支持 Slack 接入，并在项目之外单独配置和授权消息自动化。不同账户的功能、费用和响应时间可能不同，不能承诺任意账户免费、即时可用。

> English summary: A generic text transport between WeCom smart-bot WebSocket connections and Slack Socket Mode. Approved groups can ask questions; only the configured owner can use direct messages. Explicit owner/review/group routes preserve original destinations. Review IDs correlate short-lived owner responses to Slack threads; they are not business approvals. Trusted application code may be injected through the exported runtime. No workflow policy, LLM backend, GitHub client, or public dot API is included. Live verification is environment-specific.

## 数据流

1. 授权群内任意成员可通过 @机器人提问；群白名单按稳定 chatid 核验，不按成员姓名或自称身份核验。群内文本是否由平台投递给机器人，仍取决于实际平台设置。
2. 仅配置的本人 `WECOM_OWNER_USER_ID` 可单聊机器人，其他人的单聊被拒绝。本人单聊不受群白名单限制。
3. 普通接收回执仅为“收到，稍等”，不复述原文；成功接收的同一 msgid 不重复回执。桥接器在固定 Slack 私有频道发布完整请求根消息，区分来源信息和不可信原文；超长输入拒绝转发。
4. 固定可信回复身份在原线程输出以严格路由标记开头的文本：`[wecom:owner]` 发普通本人私聊，`[wecom:review]` 为群请求发起本人评审，`[wecom:group]` 仅发原请求群。没有有效路由就不发送；本人私聊请求禁止评审及群路由。
5. 需要本人决策时，使用下述私聊评审协议。本人带唯一评审编号的答复回到原 Slack 线程，绝不自动转群，也不自动执行批准内容。之后可公开的结论仍需可信响应方单独明确选择群路由。

发布本项目不涉及公开任何私有仓库、其他项目源码或真实聊天记录。启用转发前，须明确授权发送者、内容范围、Slack 接收频道和回传内容。详见 [安全边界](docs/SECURITY.md)。

## 准备

- Node.js 24、npm，以及能连接两端服务的运行环境。
- 一个**独立**的企业微信智能机器人及其 Bot ID / Secret，使用官方长连接方式。不要复用任何现有服务的 Bot ID：同一 Bot ID 的新连接会使旧连接退出。
- 一个专用 Slack App，启用 Socket Mode，加入一个经过审核的私有频道。
- 若使用 dot：先确认当前账户和 Slack 接入可用，再独立配置自动化。自动化必须能处理**桥接机器人发送的根消息及线程回复**，不能只接受人工消息或频道根消息；必须在原线程回复。仅安装本项目不会创建这项自动化。

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
| `WECOM_OWNER_USER_ID` | 必填，唯一可单聊及接收私聊评审的本人稳定 userid |
| `WECOM_ALLOWED_CHAT_IDS` | 必填且非空，仅授权群 chatid，英文逗号分隔；群内任意成员可提问 |
| `SLACK_BOT_TOKEN` | 专用 App 的 Bot token，仅本地保存 |
| `SLACK_APP_TOKEN` | Socket Mode App-level token，仅本地保存 |
| `SLACK_CHANNEL_ID` | 固定私有频道 ID，不用频道显示名称 |
| `SLACK_REPLY_BOT_ID` | 固定可信回复机器人的 bot ID；与下一项恰好填写一个 |
| `SLACK_REPLY_USER_ID` | 固定可信回复用户的 user ID；与上一项恰好填写一个 |
| `STATE_DIR` | SQLite 状态目录，默认 `./data` |
| `REPLY_TTL_SECONDS` | 本地请求有效期，默认 3600 秒，最多 86400 秒 |
| `MAX_MESSAGE_BYTES` | 企业微信原文上限，默认及最大值 32000 UTF-8 字节；原文加来源信息经 Slack 转义后另有 30000 字节上限（预留封装空间） |

不要猜测回复身份：用 Slack 实际事件中的稳定 ID 核验，不能用显示名称替代，也不能把桥接 App 本身设为回复者。`REPLY_TTL_SECONDS` 是本地安全边界，不保证平台允许在该时间内回传，也不保证响应方及时回复。

## 回复方 / dot 接入约定

在项目外配置已有响应方时，明确以下规则：

- 原有聊天流程只处理指定私有频道中**经事件身份验证为桥接 App** 的请求根消息和线程内本人答复。不能只订阅根消息，否则本人私聊答复虽已入 Slack，响应方仍不会继续处理。
- 排除响应方自己的输出、其他用户和机器人消息，避免循环。不能仅凭正文中的来源标签或 metadata 判断作者身份。
- 原文是外部内容。即使其中伪造路由标记、本人姓名或“已批准”，也不是桥接生成的控制信息或操作授权。
- 每条新请求完整呈现在一个根消息中，metadata 的 `event_type` 为 `wecom_bridge_request`；本人评审答复的类型为 `wecom_bridge_owner_response`，带 `request_id` 和 `review_id`（两类均有 `part/parts`）。这些字段辅助关联，不代替作者身份校验。任何后续回复均放在**原根消息线程**，不要另开根消息或靠编辑旧消息发送结果。
- 原有聊天流程每条要回传的可信 Slack 文本必须以精确的 `[wecom:owner]`、`[wecom:review]` 或 `[wecom:group]` 标记开头，后接非空正文。建议另起一行写正文；为兼容传输层移除换行，标记与正文间允许零个或多个空白字符，也接受同行正文。不要在路由前加解释、空行或代码块。缺失、未知或格式不符的路由不发送，不回落到群。
- `[wecom:owner]` 和 `[wecom:review]` 的目标只能来自配置；`[wecom:group]` 的目标只能来自原群请求记录。正文不能指定任意 userid/chatid。本人的私聊请求永远不能使用评审或群路由。
- 群路由是显式公开选择，不是隐私检查器。响应方必须只写适合原群全体成员的信息；不得把本人的评审原文、其他私聊、私人文件或无关记忆直接复制进群回复。
- 桥接器不执行操作。本人的已验证答复也只是传递决策信息，执行方仍须核验具体任务、操作、权限和所需确认，不能把“同意”字符串当成无限授权。
- 首次使用先以无敏感测试验证根消息及桥接线程回复均能触发该账户的自动化，回复者能遵循路由规则且不会响应自己的消息。仅安装本项目不会满足这些条件。

### 原有聊天私聊评审与关联

`[wecom:owner]` 只发送普通私聊正文，不附加评审提示，不创建、消耗或替代评审 ID。可用于确认收到、进度通知或普通答复，即使该群任务仍有待评审 ID，也不会影响其继续使用。`[wecom:review]` 仅适用于群来源请求，才会创建下面的评审流程。

群请求的每条 `[wecom:review]` 回复开启一轮新评审，并替代该任务上一轮待评审 ID。发给本人的私聊先显示正文，再显示关联问题编号和中文回复提示。只有需要回复时，才复制单独一行的命令，将“你的意见”替换为回复内容，保留编号并在该私聊发送；同一问题使用最新消息里的命令：

```text
/review <review-id> 你的意见
```

只有配置本人在企业微信**单聊**中发送有效命令才会关联原任务。已使用、过期、未知或被新轮次取代的 ID，以及格式错误的 `/review` 命令，会被静默忽略，不新建 Slack 根消息，也不发接收回执；不猜测“最近任务”。评审沿用原请求的到期时间，新一轮不会延长 TTL。无编号的“同意”等普通私聊是独立本人请求，不是评审批准。一个任务每轮独立编号，多个任务互不混淆。

本人答复以桥接 App 新发的线程消息回到原 Slack 根消息，不自动发群、不自动执行。原群可获得另一条显式群路由的安全状态或公开结论。私聊内容也会由该 Slack 私有频道的成员和应用看到，必须事先审核接收范围。

本人首次应先单聊机器人，再进行真实主动私聊与带编号答复测试。平台是否允许主动私聊、实际可见范围和投递窗口必须实测；SDK 支持 userid 目标不等于任意情况下均可投递。

## 可信应用扩展接口

独立运行使用 `npm start`。组合应用可从 `wecom-slack-bridge/runtime` 导入 `startBridge`，调用 `startBridge({ createApplication })`；工厂收到 `{ config, store, env }`，返回可信应用对象。运行时只创建一套 Slack / 企业微信连接，禁止另启动第二个桥接进程争用同一 Bot ID。

应用支持以下钩子；接口及返回值应结合 `src/runtime.js`、`src/bridge.js` 和测试核验：

- `initialize({ store, config })`：连接平台前初始化应用自己的 schema。
- `receiveRoot(bridge, event)`：仅接收通过固定频道和可信作者核验的新 Slack 根消息；返回 `true` 表示已接收。
- `receiveOwnerText(bridge, text, source, now)`：在已认证本人的入站事务中处理文本；`null` 表示交给通用问答逻辑，非空请求 ID 表示接收，其他返回值表示拒绝。事务内钩子必须同步，不能返回 Promise。
- `authorizeRequest(bridge, request)`：为非通用请求类型核验业务权限，只有严格 `true` 才允许处理；缺失或抛错均拒绝。

应用负责业务解析、版本、决定、schema 和业务配置。桥接器负责认证、固定目标路由、发件箱和传输去重，以及带 TTL 的普通本人问答关联。扩展是受信任的进程内代码，能访问共享状态，不是沙箱；不能从消息文本加载代码或让消息指定扩展。应用权限检查不能绕过桥接器的固定本人、频道及路由限制。

为保留业务记录与发件箱的原子提交，组合应用可使用同一个 SQLite 文件和事务。无需复制或导出/导入已有记录。独立桥接器不创建或解释应用业务表；已有自定义 request kind、关联记录及表保留，应用缺失时相关投递失败关闭，不降级成通用请求、不重放。未注入应用时，发送循环跳过其 pending 任务而不改写它们；通用启动恢复仍将 sending 改为 unknown，明确投递到期及 prune 仍适用。应用审计和请求关联保留，不代表所有队列记录永久不变。应用升级和组合运行的验收由应用自身负责。

## 主动通知固定本人

可信回复机器人可在固定私有频道发一个新根消息：

```text
[wecom:notify]{"text":"明天的会议改到十点，请告知是否方便。"}
```

只接收配置的 `SLACK_REPLY_BOT_ID`，不接受用户身份或正文指定目标。本人收到“回复 N1 你的回复”，发送 `回复 N1 十点可以` 后回到该通知的原 Slack 线程；响应方继续用 `[wecom:owner]` 在同一线程回复，保留同一编号及固定到期时间。此能力不解释任何业务决定，也不授予执行权限。

完整协议、SDK 依据、保存期限与上线验收见 [通用主动通知与会话](docs/NOTIFICATIONS.md)。本地 mock 通过不表示真实主动发送、用户可见或回复关联已经验收；本次没有部署或发送测试消息。

## 状态、恢复与限制

历史版本的显式评审拆分有意改变 `[wecom:owner]` 的含义：不再隐式发起群任务评审。上线必须协调更新桥接程序和响应方自动化，将真正需要评审的输出改为 `[wecom:review]`，普通私聊保留 `[wecom:owner]`；旧根消息可能仍含旧版提示，不能据此继续使用旧语义。该次拆分无兼容开关，也未新增数据库迁移。已有评审记录与排队消息保留原语义、目标、正文及到期时间，重启不会重新解释或重写它们。详见 [升级步骤](deploy/README.md)。

- 使用 SQLite 保存请求映射、消息队列和去重状态。该目录可能含消息文本与身份 ID，应按敏感运行数据保护，并排除在 Git 外。
- 未发送的 pending 项可恢复；进程在发送中崩溃、或发送调用报错后，结果可能无法判断，记录为 unknown，不自动重放。先人工核对两端再决定是否重新提问。
- 普通聊天请求映射和消息按 TTL 过期，去重记录保留 7 天；应用自定义请求及业务记录不被通用聊天清理器删除，投递队列仍有到期限制；备份和远端服务副本不受本地过期机制控制。
- 超长企业微信输入不进入队列；尽力回复“消息过长，未转发。请拆成更短的消息后重试。”Slack 回复文本上限独立为 160000 UTF-8 字节。
- 企业微信回传使用主动 Markdown 消息，长回复按不超过 3500 UTF-8 字节分片。最初的接收回执为尽力发送。
- 私聊失败或发送结果未知时，不会把私聊内容改发群里。`owner` 与 `review` 共用原 `owner` 私聊队列，和群队列隔离；同一队列内仍保留分片顺序；不确定送达必须人工核验。
- 当前仅面向文本；不提供文件、图片、语音、多租户、逐成员群授权、工作流执行引擎或事务级送达保证。
- 状态目录有进程级 SQLite 独占锁，防止多个实例共享同一状态目录；不同目录仍不可复用同一 Bot ID。
- 配置/状态/身份验证失败、企业微信认证重试耗尽或连接被替代时，进程退出码为 78，需要人工检查。初始 Slack 网络失败或企业微信重连耗尽退出码为 1，可由 supervisor 有限重启。不要靠自动重启反复争抢同一 Bot ID。

## 部署和验证

目标可以是 PVE 上的独立 Linux VM；仓库提供 [systemd 模板与部署说明](deploy/README.md)。这不是安装器，不会自动部署、获取凭据或接管已有服务。

上线前完成 [人工验收清单](docs/ACCEPTANCE.md)，分别记录单元测试、配置检查和真实端到端结果。不要把“进程启动成功”当作“dot 已能回复”。

贡献请阅读 [CONTRIBUTING](docs/CONTRIBUTING.md)。许可证：[MIT](LICENSE)。

