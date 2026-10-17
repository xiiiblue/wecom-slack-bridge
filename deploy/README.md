# Linux VM / systemd 部署模板

本目录只提供可审阅的模板，尚未实际部署。适合 PVE 中独立的 Linux VM；不在 PVE 宿主机直接安装，也不修改其他机器人或现有服务。安装软件、创建账户、配置凭据和启动转发均由获授权的运维人员在目标 VM 操作。

## 部署前

1. 完成主 README 的平台配置、数据转发授权和身份核验。使用新的企业微信 Bot ID。
2. 从 Node.js 官方来源安装 Node.js 24，检查 `node --version`。模板假定绝对路径为 `/usr/bin/node`，按实际路径调整，避免依赖交互式 shell 的 nvm 环境。
3. 创建专用无登录非 root 用户和组 `wecom-bridge`。代码目录为 `/opt/wecom-slack-bridge`，由部署管理员维护，服务用户只读。不要把整个目录设为任何用户可写。
4. 在部署目录运行 `npm ci --ignore-scripts`、`npm test` 和 `npm run check`。不要复制开发机器的 `node_modules`；SQLite 运行时依赖与 Node 版本须匹配。
5. 以 `.env.example` 为参考，在 VM 本地安全编辑 `/etc/wecom-slack-bridge.env`。文件由 root 拥有、权限 0600，内容为 systemd 支持的 `KEY=value`，无 `export` 和命令替换。不要把真实值写入本仓库或聊天。
6. 模板默认 `STATE_DIR=/var/lib/wecom-slack-bridge`。不要原样保留示例中的 `STATE_DIR=./data`；应删除该行以使用模板默认值，或明确填入 `/var/lib/wecom-slack-bridge`。如使用其他路径，必须同步调整 `ReadWritePaths` 并设置私有目录权限；否则沙箱会拒绝写入。

## 审阅并启动

审阅 `wecom-slack-bridge.service` 的路径、用户和沙箱设置，再安装到系统的 unit 目录。模板不开放入站服务端口；按组织网络策略允许必要的出站 TLS/WebSocket 和 DNS。不要为了连通而关闭防火墙或证书校验。

完成授权后，运维人员可运行以下命令。它们会改变系统并开始向两端转发消息，请勿在未配置或错误的机器上执行。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now wecom-slack-bridge.service
sudo systemctl status wecom-slack-bridge.service
```

日志可通过 `journalctl -u wecom-slack-bridge.service` 检查。分享日志前先检查并脱敏；不要打开含原始载荷或凭据的调试输出。

`RestartPreventExitStatus=78` 防止配置、状态或身份错误，以及已被新连接替代的实例反复重启。若看到该退出码，先核对脱敏日志中的阶段、配置、状态目录权限、认证和重复实例，不要直接强制重启。网络类失败使用退出码 1，受模板的重启频率上限限制。不要运行两个使用同一 Bot ID 的实例。

## 停止与更新

```sh
sudo systemctl stop wecom-slack-bridge.service
```

停服务后再更新代码、依赖和状态备份；备份也要限制访问。按新版本说明处理数据库兼容性，确认后再启动。删除本地状态会影响去重和未完成请求，不应作为常规故障修复步骤。

先在小范围授权群和本人私聊、无敏感数据场景完成 [验收](../docs/ACCEPTANCE.md)，再扩大允许范围。网络恢复、进程重启、发送失败和 dot 不响应都应验证；未知发送结果不能盲目重放。

## 从 v0.1 升级到 v0.2

先停止旧服务，并安全备份完整状态目录。保留备份只供获授权的故障核验，不把状态或凭据提交仓库。

- 配置必填 `WECOM_OWNER_USER_ID`，将 `WECOM_ALLOWED_CHAT_IDS` 改为必填、非空、只含群 chatid 的名单。删除旧 `WECOM_ALLOWED_USER_IDS` 配置；新版允许授权群内所有成员提问，单聊仅本人可用。
- 程序执行增量数据库迁移：旧请求缺少可信来源/路由信息，会被标为 quarantined；尚未发送的旧任务也被隔离，不自动转换为 owner 或 group 投递。迁移本身不删除或重新解释旧数据；被隔离的请求和任务仍会按原请求 TTL 清理，去重记录按正常 7 天保留期清理，不是永久归档。旧任务需要核对后重新发问，不能用手改目标或状态强行重放。
- 不删除状态目录来绕过迁移，否则会丢失去重和未完成状态；回滚代码前先评估数据库兼容性，不用旧程序直接继续运行新状态。
- 同步更新响应方协议：所有回传文本精确以 `[wecom:owner]` 或 `[wecom:group]` 起行。自动化必须监听并过滤桥接身份发出的**根消息和线程回复**，排除响应方自己的输出，否则本人评审回复无法继续或可能形成循环。
- 私聊评审采用每轮唯一 ID，命令为 `/review <review-id> <text>`。本人的私聊答复进入原 Slack 线程；它不是自动公开或自动执行的指令。
- 启动前重新核验 Slack 频道成员都适合接收本人评审内容；由本人先向机器人私聊测试，再完成真实主动私聊资格与完整群提问/本人评审/公开结论链路验收。

本模板面向可明确配置常驻进程和重启策略的 Linux VM。开发云工作区中的短时运行不能证明 24/7 存活、网络稳定性或自动恢复；首次实际部署和两端联调仍待执行。
