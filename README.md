# wecom-slack-bridge

企业微信智能机器人长连接 ↔ Slack Socket Mode 的受限文本桥接器。独立运行，不依赖特定智能体或业务项目。

它负责来源核验、固定目标路由、短期会话关联和持久化发件箱；不调用模型、不访问 GitHub、不执行消息里的命令，不判断业务审批。现有代码包含传统即时回执和主动 Markdown 答案；没有流式续写、自动 @ 或原生引用关联功能。

> An allowlisted text transport between WeCom smart bots and a pinned Slack responder. Explicit routes separate owner DMs from original-group replies. No LLM, GitHub integration, workflow engine, or business approval is included. Delivery and live compatibility must be verified in each deployment.

## 工作方式

```text
授权企微群 / 固定本人私聊 → 来源核验 → 固定 Slack 私有频道的新根线程
                                                   ↓
                                       固定可信响应方生成带路由的回复
                                                   ↓
                               配置本人私聊 / 原请求群（显式选择）
```

- 企微群按 chatid 白名单放行群内任意成员；单聊只允许配置本人。两者不能互相借用身份。
- 每条新文本建立独立 Slack 根线程；不按同一人、引用文字或“最近任务”自动合并。
- 接收后尽力回“收到，稍等”。已接收的同一 msgid 不重复回执；回执成功不代表下游已经完成。
- 只有指定频道、指定可信作者、映射原线程中的严格路由回复才回传。本人私聊内容不默认回群。
- 可信 bot 还可向固定本人发起带短编号的通知与对话；不允许正文选择其他接收人。

## 阅读入口

|要做什么|文档|
|---|---|
|准备机器人、Slack 与环境变量|[配置指南](docs/CONFIGURATION.md)|
|实现响应方与理解路由/评审协议|[消息协议](docs/PROTOCOL.md)|
|主动通知与短编号对话|[通知协议](docs/NOTIFICATIONS.md)|
|Linux 安装、备份、升级与回退|[运维说明](deploy/README.md)|
|查队列状态、错误与恢复限制|[可靠性与排障](docs/OPERATIONS.md)|
|复用同一运行时编写可信扩展|[扩展接口](docs/EXTENSIONS.md)|
|评估隐私和权限|[安全边界](docs/SECURITY.md)|
|验证实际环境|[人工验收清单](docs/ACCEPTANCE.md)|
|修改项目|[贡献指南](docs/CONTRIBUTING.md)|

## 本地准备

使用 Node.js **24.x** 和 npm。锁文件固定依赖版本；不要把开发机 node_modules 复制到其他系统。

```sh
npm ci --ignore-scripts
npm run check
cp .env.example .env
chmod 600 .env
# 在本机安全填写 .env，不能把凭据发到聊天或提交仓库
npm run config:check
# 配置、受众和启用范围确认后才启动真实连接：
npm start
```

`config:check` 只检查配置语法，不连接平台、不建状态库，不核验身份真实性、频道私有性、权限或网络。`check` 检查源码语法、文档本地文件链接并运行模拟服务测试；不发送真实消息。生产安装可用 `npm ci --omit=dev --ignore-scripts`，仍需匹配 Node.js 24.x。

## 支持范围与限制

|能力|当前范围|
|---|---|
|企微入站|智能机器人 SDK 的 text 回调；非本人单聊、未授权群、非文本忽略|
|Slack 回传|文本路由；有限 rich_text 只用于恢复与原文本一致的段落，不决定身份或目标|
|企微出站|普通主动 Markdown；长文本按 UTF-8 字节分片，平台渲染需实测|
|恢复|pending 可恢复；sending 重启后变 unknown，不自动重放|
|去重|来源去重保留7天，固定请求/会话沿用 TTL，不承诺永久去重或恰好一次|
|不支持|文件/图片/语音/卡片传输、多租户、逐成员群准入、消息编辑删除同步、自动 @、原生引用续接|

同一 Bot ID 只运行一套连接：新连接可能踢掉旧服务。状态目录独占锁只防止共享同一目录的进程，不是跨目录或跨主机锁。默认不开放公网入站端口。

**本地测试、平台 ACK、用户可见和真实往返是不同验证层级。** 仓库版本不证明某个环境已经部署，也不承诺任意智能体账户都能免费或即时接入。部署及现场验证记录应由各使用者单独保存，不把私人运行细节写进公共文档。

项目已有 [MIT License](LICENSE)，本轮不改变许可条款。`private: true` 防止意外发布到 npm，不影响源码仓库的使用；当前主要以 Git 固定提交部署。
