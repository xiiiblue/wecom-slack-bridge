# 授权群附件：双向传输与读取边界

附件通道默认关闭，独立于原有纯文本流程。只负责原生附件传输、平台来源核验、原 request/Slack 根线程/原群关联；不调用模型、不执行命令、不读取附件指定的本地路径，不拍摄桌面，不渲染 HTML/PDF，不运行宏或自动解压。传输成功不等于助手已读取或理解。

## 官方接口与权限矩阵

|方向|官方接口与实现路径|所需能力 / 未确认项|
|---|---|---|
|企微群→Slack 图片|`message.image` 或 `message.mixed` →受限 HTTPS下载→独立 aeskey 解密→Slack 原生文件上传|已认证的授权群成员、核验的精确下载主机；桥接 bot `files:write`；助手另有文件读取/图像输入能力|
|企微群→Slack 文件|`message.file` →受限下载/解密→原生附件|同上；下载响应须提供可核验的原文件名，否则拒绝，不猜类型|
|Slack→原企微群 图片/文件|可信作者在原根分享原生附件→`files.info`/受控私有下载→上传临时素材→`sendMediaMessage`|桥接 bot `files:read`；真实响应方上传身份、文件归属与线程 share 可核验；企微租户允许主动媒体推送|
|被动媒体回复（本实现不用）|`replyMedia` 走 `aibot_respond_msg`，依赖原回调|不能与本实现的 `aibot_send_msg` 主动推送混称；本实现不保存原回调来长期回复|

依据：[官方企微 SDK](https://github.com/WecomTeam/aibot-node-sdk)及[长连接协议入口](https://developer.work.weixin.qq.com/document/path/101463)；锁定 SDK 的类型定义包含 image/file URL及 aeskey，下载器从 Content-Disposition 读取文件名。SDK 提供 `uploadMedia`、`replyMedia` 和 `sendMediaMessage`。SDK 的分片实现约50 MB上限不等于租户允许所有类型/大小；本项目采用更低本地限额，真实图片/文件投递仍需现场验证。

Slack 使用[三步原生上传](https://docs.slack.dev/messaging/working-with-files/)：getUploadURLExternal →二进制 POST→[completeUploadExternal](https://docs.slack.dev/reference/methods/files.completeUploadExternal/)（`files:write`）；回传前通过 [files.info](https://docs.slack.dev/reference/methods/files.info/)（`files:read`）核验文件元数据。文件分享由 [message.file_share](https://docs.slack.dev/reference/events/message/file_share/) 消息事件携带 files。不使用公开链接、外部图床或已弃用 files.upload。

新增 scope、凭据、重新授权或持续集成必须由账户所有者明确批准和配置；程序不申请或自动接受。工具存在不代表某一账号已经获权。若缺 scope 或无法证明真实响应身份/文件读取能力，保持关闭，不更换账号绕过。

## 类型策略与助手分析分层

|本地传输策略|校验|不代表什么|
|---|---|---|
|PNG、JPEG|文件头与尺寸，最多2500万像素；扩展名/MIME一致|不做完整图像解码、OCR、恶意文件扫描或隐私脱敏|
|txt/log/html/htm、csv/md/json/xml|UTF-8，拒绝二进制控制字符、可执行头/脚本 shebang；校验扩展名和 MIME|HTML仅源码数据，不运行脚本/加载资源；JSON/XML不解析外部实体或执行|
|PDF|扩展名、MIME、`%PDF-` 文件头|不渲染，不执行 PDF脚本，不证明文档有效或已读完|
|Word doc/docx、Excel xls/xlsx|扩展名/MIME 与 OLE/ZIP 容器头相符|不展开、不深验容器，不保证格式完全有效、无宏或无恶意内容；不会运行 Office或宏|
|其他 / 不安全格式|默认拒绝，包括独立压缩包、可执行文件、脚本、docm/xlsm等明确宏格式|改名和 MIME并非可信内容证明；新增类型须审查策略与消费者能力，不能仅改后缀冒充已读|

这是通用的附件通道和集中类型策略，不是业务解析器。Office 容器只做有限头检查，恶意改名容器可能仍被传输，但从不在桥接中解压或执行；解析方必须继续安全处理。助手须依据自身工具逐文件记录“已取得/已解析哪些内容/未支持或未读”，不能从上传 ACK、文件名或另一种格式的成功推断已理解。父侧读取工具若限制10 MB，本地每文件5 MiB在其上限内，但格式解析能力仍分别核验。

## 配置与硬限制

见[配置指南](CONFIGURATION.md)。`WECOM_ATTACHMENTS_ENABLED=false` 控制群入站，`WECOM_ATTACHMENT_REPLIES_ENABLED=false` 控制原群附件回传。入站需 `WECOM_ATTACHMENT_DOWNLOAD_HOSTS`；`WECOM_ATTACHMENT_ALLOWED_USER_IDS` 为可选进一步限制，空值沿用现有精确群白名单内的成员范围；文本仍按现有群策略，不借附件开关扩展单聊。

- 先核验 SDK bot ID、group 类型、精确群白名单、非空有效平台 from.userid、可选发送者限制和 msgid，再处理下载地址。只取当前消息，不读引用、不按相邻文本/同一人/最近消息拼接。混排最多8项，只接受 text/image；file 回调为单个附件。
- `MAX_ATTACHMENTS_PER_MESSAGE` 默认1，最大3。每附件解密前最多5 MiB+32字节、解密后最多5 MiB；混排正文受原限额，转义后的正文/来源另限28000字节。
- 下载只允许管理员核验的精确官方子域（qpic.cn / weixin.qq.com），无默认、通配符、IP、端口或从消息学习的主机。合成测试主机不是实际租户主机证据。未知主机保持拒绝，不自动扩展。
- HTTPS443；拒绝凭据、片段、内网/环回/链路本地/映射/特殊地址。全部 DNS答案须合规，实际连接固定公网地址并校验主机 TLS；拒绝所有重定向，每次 HTTPS操作总期限10秒（含DNS），流式字节限额。上传仅 files.slack.com/upload/；Slack token仅可发往 files.slack.com/files-pri/，不跟随重定向，不发送到企微 CDN或上传票据目标。
- 只从受限 Content-Disposition 或已核验 Slack file.name 提取类型；拒绝路径、控制字符、越界文件名。转发名称由本地 UUID、序号和类型生成，不作为本地路径使用。缺文件名/MIME不符合时拒绝，不猜PDF/Word等格式。
- 共享内存缓存最多2个请求、约30 MiB有效附件及有界临时下载/解密副本，60秒到期；完成、失败、停止或到期尽力清零持有 Buffer，无磁盘附件缓存。字符串、TLS/SDK或系统内存副本不保证完全擦除。

## 入站完成事件、触发与去重

先接收并尽力传统回执一次，然后下载/校验全部当前附件，再创建新 Slack 根，固定 request 与来源。原根明确“尚未就绪”。三步上传完成后，所有文件分享至**该根**，最后发送 `attachments_ready` 同根消息，metadata event_type为 `wecom_bridge_attachments_ready`，包含 `request_id` 与 `file_ids`。

响应方应先核验固定桥接作者/频道、真实原根映射，再以 `attachments_ready` 作为完整材料到齐的触发点；根或 file_share 先到只能等待，不能声称无图。响应方按 request ID记住已处理的完成事件，重复触发不重新开任务；需读取时根据 file_ids 调用已授权读取工具。桥接直到附件和完成通知都确认才允许原根回复。文件文字、metadata和正文不单独构成身份或执行授权。

桥接按原 msgid 持久去重；不会自动创建/修改宿主自动化。宿主若只接根或忽略线程消息，需要在另行授权范围内调整触发；本代码本身不证明当前宿主已经按此规则工作。ACK、完成事件、助手实际读取、理解及用户可见分别验收。

## 助手回传附件协议

只能由配置的真实可信响应身份，在**已确认且未过期的群请求原根**分享自己的原生 Slack 附件，分享消息正文严格为：

```text
[wecom:group-files]{"request":"<原请求UUID>","redacted":true}
```

- JSON只允许上述两字段，必须匹配原 request。redacted 是发送方的明确声明，不是机器脱敏证明；发送方先确认文件属于此已授权事项，排除凭据、私人桌面/源码和无关用户数据。上传文件或使用此协议不授权修复、运行命令或拍摄设备。
- 不接受新根广播、私聊请求、任意群ID、URL、本地路径或正文提供的下载地址。文本原路由不变，附件没有 owner/private或跨群 fallback。
- 实际事件 bot_id/user 必须匹配原配置；不接受 display_as_bot/名称冒充。文件必须由该事件 user 上传，files.info证明 hosted、非 external/公开分享，且 shares只属于当前固定私有频道和原根。若工具无法以既有 Ditto身份上传，或无法返回这样的事件/归属，停止并报告，不能把桥接 App 自己的上传当 Ditto输出。
- 不仅按事件 channel+ts去重，还按 request+file ID去重；相同文件在另一消息重复分享也不会重发。本条不保证字节相同但新file ID的永久去重。
- 受控读取和类型校验后，生成本地文件名，上传企微临时素材，再用 `sendMediaMessage` 的 image/file主动推送至原群。不会用 Markdown链接伪装图片/文件。媒体上传+最终发送总期限30秒；超时不再开始最终推送。SDK在途分片无法硬取消，分片内有界重试不等于重试最终群发送。
- 发送前、素材上传后再次核验原群/请求授权、连接与缓存有效性。多附件中途中断可能已发送前几份；整个任务记 unknown并不重放。检查远端实际副作用后另作明确处理，不把剩余文件自动移往其他目标。

## 故障、保留、上线与回退

SQLite仅保存关联、来源去重、文字/来源摘要、附件标记、回传file IDs及作者；不保存下载URL、key、token或附件字节。失败日志只有固定事件/阶段和内部request ID，不输出原始错误/SDK帧。短缓存删除不等于删除两端文件、搜索或备份副本，不新增远端自动删除权限。

重启后入站缺缓存任务转 unknown，sending也变unknown；不重新下载或假装文字成功。尚未开始的回传任务仅保留file IDs，可在原授权/TTL内重新核验后读取，任何已开始的未知发送不自动重放。独立 `slack_attachment` / `wecom_attachment` 方向及 `slack` / `group_attachment` lane使已审查的旧文本基线拒绝附件任务；任意其他回退版本须另验。当前数据库无 schema变更。

上线前统一确认双向范围、scope/重新授权、既有群成员范围/可选限制与精确主机、真实Ditto上传及助手读取/解析能力；本轮不部署、不重启、不改运行配置、群/凭据/权限或自动化，不发真实测试。另获准后按[维护说明](../deploy/README.md)停唯一写者、一致备份、固定提交安装，以合成附件逐格式验证真实双向送达。回退保留当前数据库与新增记录，关闭入口、停唯一实例后退已验版本，核对未完成任务及远端副作用，不用旧库覆盖新状态、不重放unknown。文档和模拟测试通过不代表附件已上线或助手已能识别。
