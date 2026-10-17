# wecom-slack-bridge

企业微信智能机器人长连接 ↔ Slack Socket Mode 的文本桥接 MVP（群提问 / 本人私聊分流与持久 Issue 决策记录）。

**状态：未完成真实端到端验证，尚未部署。** 单元测试用于检查本地逻辑，不代表企业微信、Slack 和 dot 自动化已联调成功。

桥接程序只负责消息传输及持久记录本人 Issue 决策，不执行代码、不自动写 GitHub、不调用 LLM，不提供 dot API，也不会模拟或冒充 dot。若希望由已有 dot 回复，需要该账户本身支持 Slack 接入，并在项目之外单独配置和授权消息自动化。不同账户的功能、费用和响应时间可能不同，不能承诺任意账户免费、即时可用。

> English summary: A transport and decision-recording MVP between WeCom smart-bot WebSocket connections and Slack Socket Mode. Members of approved WeCom groups can ask questions; only the configured owner can use direct messages. Replies from one pinned Slack identity require an explicit owner/review/group route, and private review responses return to the original Slack thread without automatic publication or execution. Optional durable Issue proposals pin one repository and owner, preserve decisions beyond chat TTL, and never execute code or write GitHub. An existing, separately configured responder is required. No LLM backend or public dot API is included. Live end-to-end verification and deployment are still pending.

## 数据流

1. 授权群内任意成员可通过 @机器人提问；群白名单按稳定 chatid 核验，不按成员姓名或自称身份核验。群内文本是否由平台投递给机器人，仍取决于实际平台设置。
2. 仅配置的本人 `WECOM_OWNER_USER_ID` 可单聊机器人，其他人的单聊被拒绝。本人单聊不受群白名单限制。
3. 桥接器在固定 Slack 私有频道发布完整请求根消息，区分来源信息和不可信原文；超长输入拒绝转发。
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
| `ISSUE_REPOSITORY` | 可选、显式启用 Issue 评审的唯一 `owner/repository`；留空禁用，例如 `example-owner/example-project`。不配置 GitHub 凭据 |
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

## 持久 Issue 评审（仅记录决策）

这是一条与原有聊天评审并存的协议：统一接收企业微信讨论整理、人工创建的 GitHub Issue，以及未来 AI 提议的 Issue 快照。来源标签只是可信响应方提供的分类，不证明 Issue 作者身份。桥接器不发现、创建、修改、关闭 Issue，不读取 GitHub，不申请新凭据，也不执行获批操作。GitHub 发现、快照核验和向 Slack 提交提案由项目外的响应方另行授权；安装本项目不会创建定时任务。每小时发现及未来 AI 自动发现需由外部服务独立配置和验证，本仓库不随安装启用。外部响应方可在另获授权后将本人的决定写成 GitHub 评论；这不属于桥接程序的能力，也不授权修改代码、文档或 Issue 状态。

仅当 `ISSUE_REPOSITORY` 明确设置为一个仓库时启用。提案只接受固定私有 Slack 频道中已核验可信回复身份的新根消息；线程回复、编辑及删除事件不能提交提案。GitHub 来源任务没有原企业微信群，不猜测或补造群目标，所有 Issue 评审只发配置本人。企业微信主动私聊资格与可达窗口仍须实测，不承诺所有账户、所有时间均可主动投递。

### 提案格式

Slack 文本必须从精确的 `[wecom:issue]` 开始，随后是一个 JSON 对象，整条文本最多 8192 UTF-8 字节，不附解释、代码围栏、额外字段或尾随文字。字段如下：

| 字段 | 类型与含义 |
| --- | --- |
| `repo` | 与 `ISSUE_REPOSITORY` 精确匹配的 `owner/repository` |
| `issue_id` | 1–20 位正十进制字符串，稳定 Issue 身份，不用标题代替 |
| `issue_number` | 正安全整数，用于仓库内 Issue 编号 |
| `title` | 非空标题，最多 300 UTF-8 字节 |
| `revision` | 正安全整数，提案版本；内容变化须使用新版本 |
| `proposed_action` | 非空拟采取动作，最多 2000 UTF-8 字节，须具体到可评审范围 |
| `allowed_scope` | 非空允许范围，最多 1000 UTF-8 字节；它是供本人评审的提案内容，不自行授予权限 |
| `source_kind` | 仅 `wecom`、`github` 或 `ai` |

示例只使用虚构仓库及内容：

```text
[wecom:issue]{"repo":"example-owner/example-project","issue_id":"123456789","issue_number":42,"title":"补充安装说明","revision":1,"proposed_action":"准备安装说明修改供人工检查","allowed_scope":"仅 README 文案，不执行代码或部署","source_kind":"github"}
```

版本必须严格递增；相同或更低版本（包括内容冲突）忽略。仓库、稳定 Issue ID 与 Issue 编号绑定后不可更换。新版本使旧的待评审编号和未发送的 pending 提示失效；已发送提示不能撤回，旧编号仍被拒绝。

不接收自定义 URL、userid、chatid 或接收频道字段。Issue 链接由已核验仓库及编号构造；标题、动作和范围仍是不可信数据，不能构成可执行授权；字段拒绝不允许的控制字符。

### 本人决策与持久性

本人在企业微信单聊使用收到的唯一评审编号：

```text
/review <review-id> 同意
/review <review-id> 不同意 可选的单行理由
/review <review-id> 暂缓 可选的单行理由
```

命令使用单个 ASCII 空格分隔；可选理由为单行，最多 1000 UTF-8 字节。只接受当前配置本人且与提案固定本人匹配的单聊事件。普通“收到”“同意”或 `[wecom:owner]` 确认不创建或完成 Issue 评审。每个决定仅适用于指定 Issue 的指定版本；暂缓会持久记录，不被当作批准；同一编号不能再决定，重新评审须提交更高版本。已用编号、过时版本、重复事件和错误命令失败关闭，不回落成新任务或猜测最近任务。

提案快照和决策保存在 SQLite 中，独立于普通聊天 `REPLY_TTL_SECONDS`，跨重启与数日后仍可核验；发送队列从每次入队起按 `REPLY_TTL_SECONDS` 到期（默认 1 小时，最多 24 小时）。记录存在不代表消息已送达，队列过期或发送结果 unknown 不会删除决定，也不自动重放。GitHub 提案及本人答复都会经过指定 Slack 私有频道；其中所有可见成员及应用都是潜在接收者，须一并审核。

决策回传的 metadata 为 `event_type: wecom_bridge_issue_decision`，`event_payload` 包含 `request_id`、`review_id`、`repo`、`issue_id`、`issue_number`、`revision`、`decision`、`reason` 及 `decision_record_only: true`；`decision` 分别为 `approve`、`reject`、`defer`。为支持不能稳定读取 metadata 的外部连接器，决定消息第一行精确为 `Issue decision record`，第二行为相同 `event_payload` 的单个 JSON 对象（包含 `reason`）；后续行为中文摘要及仅记录决定的提示。JSON 中 `<`、`>`、`&` 可使用 Unicode 转义，应按 JSON 正常解析，不用正则从理由中抽取决定。无论读 metadata 还是正文，都须先验证实际桥接 App 作者、固定私有频道与原提案线程，不能仅凭前缀相信内容。

提案标题、动作与范围在企业微信提示中显示为单行带引号的转义文本，避免正文伪造命令或提及；实际命令以提示独立给出的编号为准。可在 Issue 原根线程发送 `[wecom:owner]` 普通本人通知；`[wecom:review]` 和 `[wecom:group]` 被拒绝，不创建第二条评审链路。

桥接程序本版本只记录同意、不同意或暂缓并回传原提案线程，不把“同意”当成执行授权：不会运行代码、部署、自动写 GitHub、变更 Issue 状态或向群发布。外部 GitHub 评论及将来的其他写入或执行必须分别取得相应授权；决定记录本身不能扩大权限。

## 状态、恢复与限制

历史版本的显式评审拆分有意改变 `[wecom:owner]` 的含义：不再隐式发起群任务评审。上线必须协调更新桥接程序和响应方自动化，将真正需要评审的输出改为 `[wecom:review]`，普通私聊保留 `[wecom:owner]`；旧根消息可能仍含旧版提示，不能据此继续使用旧语义。该次拆分无兼容开关，也未新增数据库迁移；本次持久 Issue 评审另有增量迁移。已有评审记录与排队消息保留原语义、目标、正文及到期时间，重启不会重新解释或重写它们。详见 [升级步骤](deploy/README.md)。

- 使用 SQLite 保存请求映射、消息队列和去重状态。该目录可能含消息文本与身份 ID，应按敏感运行数据保护，并排除在 Git 外。
- 未发送的 pending 项可恢复；进程在发送中崩溃、或发送调用报错后，结果可能无法判断，记录为 unknown，不自动重放。先人工核对两端再决定是否重新提问。
- 普通聊天请求映射和消息按 TTL 过期，去重记录保留 7 天；持久 Issue 提案和决定不随聊天 TTL 清理，投递队列仍有到期限制；备份和远端服务副本不受本地过期机制控制。
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
