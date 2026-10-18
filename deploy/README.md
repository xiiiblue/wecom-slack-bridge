# Linux / systemd 安装与维护

本目录是通用部署模板，不代表某个环境已部署或验收。目标为可管理常驻进程的独立 Linux 主机/虚拟机，不是在虚拟化宿主机直接安装。以下系统变更与真实连接仅由获授权运维在明确目标执行；仓库测试不会自动执行它们。

## 1. 准备与固定版本

先读 [配置指南](../docs/CONFIGURATION.md)，核对数据转发范围、固定本人、授权群、私有频道和可信回复身份。新安装使用独立 Bot ID；同一既有服务升级不建立第二套连接。

安装 Node.js **24.x** 并核验实际绝对路径、来源与完整性。不要替换其他服务依赖的全局运行时；可以使用隔离的官方 Node 运行时。模板 `/usr/bin/node` 必须按现场路径调整，不能依赖交互式 shell 的 nvm。

在隔离构建目录获取并核对审核过的固定提交，不以浮动 main 代替发布版本：

```sh
git clone https://github.com/xiiiblue/wecom-slack-bridge.git
cd wecom-slack-bridge
# 将 REVIEWED_COMMIT 替换为已审核的完整提交 SHA
git checkout --detach REVIEWED_COMMIT
npm ci --ignore-scripts
npm run check
```

本地测试不连接平台。生产目录按锁文件运行 `npm ci --omit=dev --ignore-scripts`，不要复制其他系统的 node_modules。保留代码提交 SHA、Node 版本与测试结果；已有 [MIT 许可](../LICENSE)随源码保留。

## 2. 账号、目录与配置

- 专用无登录、非 root 服务用户/组：`wecom-bridge`。账户已存在时先核验，不重复创建或变更其他服务账号。
- 代码示例路径 `/opt/wecom-slack-bridge`：管理员拥有，目录0755、普通代码文件0644，服务用户只读。可采用独立 releases 目录，但必须同步 WorkingDirectory、ExecStart 和运行时路径。
- 状态示例 `/var/lib/wecom-slack-bridge`：仅服务用户访问，0700；SQLite 文件0600。systemd 的 StateDirectory 自动建立该目录；其他启动方式由运维预先准备并检查既有目录权限。
- 环境文件 `/etc/wecom-slack-bridge.env`：root拥有、0600；先安全创建私有空文件，再在机器本地编辑。新安装模板不能覆盖现有配置。不要打印、上传或提交内容。
- 环境文件用 systemd 支持的 `KEY=value`，不用 export、命令替换或 shell 展开。避免依赖 Node .env 与 systemd 对复杂引号值的不同解析。
- 必须将 `STATE_DIR` 写为上述绝对状态路径，或删除示例 `STATE_DIR=./data` 使用 unit 默认值。其他状态目录同时调整 ReadWritePaths 和权限；环境文件中的值会覆盖 unit 的 Environment 默认值。

离线检查可在具有读取环境文件权限的本机，以匹配 Node 调用：

```sh
sudo /usr/bin/node --env-file=/etc/wecom-slack-bridge.env /opt/wecom-slack-bridge/scripts/check-config.js
```

按实际 Node 路径调整。检查不建状态库、不验证平台权限和连通性，也不启动 bot。不要把 sudo、环境文件读取权限或新账号视为安装脚本隐含取得的许可。

## 3. 审阅 unit 并启动

核对 [服务模板](wecom-slack-bridge.service) 的代码/运行时路径、用户、状态目录和沙箱设置；由授权管理员安装到 systemd unit 目录。模板不打开入站端口，只需必要的出站 TLS/WebSocket、DNS。不要关闭防火墙、SSH 安全配置或证书校验来处理连通问题。

确认没有共享该 Bot ID 的其他连接、没有共享状态目录的写者，配置与发送范围获准后：

```sh
sudo systemctl daemon-reload
sudo systemctl start wecom-slack-bridge.service
sudo systemctl status wecom-slack-bridge.service
```

首次启动不必同时开机启用。通过合成文本 [人工验收](../docs/ACCEPTANCE.md) 并确认常驻要求后，才在授权内执行 `systemctl enable wecom-slack-bridge.service`。检查实际代码提交、进程用户、唯一连接、状态权限、配置来源和脱敏日志；进程 active 不等于真实消息往返。

退出78表示配置/状态/身份类错误、企微认证耗尽或连接被替代；模板禁止自动重启该退出码。网络启动失败或企微重连耗尽退出1，可由 supervisor 在重启频率上限内恢复。应用应先处理根因，不反复抢 Bot ID。其他错误、队列状态与日志见 [排障](../docs/OPERATIONS.md)。

## 4. 停写与一致备份

升级前记录当前 unit/入口、代码 SHA、运行时版本、状态路径和待发/unknown 数量。暂停新派发后停止**唯一写者**：

```sh
sudo systemctl stop wecom-slack-bridge.service
```

确认进程已停止，保护切换边界已开始发送的未知结果。备份根目录0700，备份中状态/配置等私有文件限制0600或按原私有权限保留；备份放仓库外，按保留期控制访问。

- 停写后备份完整 STATE_DIR，包含 bridge.sqlite 及可能存在的 WAL/SHM、instance.sqlite 和扩展表；不要只复制一个正在写的主数据库文件。
- 记录/备份 unit 和精确代码版本；凭据是否备份由现场单独批准并使用受保护流程，不把密钥混进代码压缩包、日志或聊天。
- 需要 SQLite 在线备份时必须由熟悉 WAL 与备份 API 的运维另行验证；本项目没有自动备份/恢复工具。
- 在私有隔离副本验证数据库兼容性，不启动任何真实平台连接。备份含消息与标识，不能用于公开 fixture。

## 5. 升级与回退

将新固定提交及生产依赖放入管理员维护的代码目录，保留服务身份、环境、原状态与唯一写者；必要时更新 unit 绝对路径。新启动会隔离缺少可信来源的旧请求、恢复 sending 为 unknown，但不自动重写原正文、目标、线程、ID 或 TTL。

升级前阅读协议变化：v0.1 的逐用户群准入已换为非空群白名单与固定本人；旧缺来源请求及未发送任务标 quarantined，仍按原 TTL 清理。删除不再使用的 WECOM_ALLOWED_USER_IDS 配置，不能以清库跳过迁移。

显式评审协议中 owner 只发普通本人私聊，review 才创建评审轮次；旧根提示可能过时，响应方必须同步到 [当前协议](../docs/PROTOCOL.md)。已有有效 review ID、排队正文和到期时间不重解释。没有兼容旧 owner 隐式评审语义的开关。

组合应用复用同一个状态与运行时，不启动第二个 unit。未知类型保留且无应用时不投递，详见 [扩展接口](../docs/EXTENSIONS.md)。

验收失败先停止新派发，保存**升级后的当前状态及新消息**，核对外部副作用。优先在证明兼容后回退代码/unit并保留当前数据库；不能用升级前快照覆盖新数据与去重证据。无法证明兼容则保持停止，交授权人员核验，不盲重放 unknown。

启动后分别记录本地测试、平台 ACK、本人/群实际可见和真实往返结果；长期存活、网络重连与恢复演练也需单独验证，不能由一次短时启动推断。

## 可选群图片的发布门槛

图片默认关闭。新增 scope、成员/精确 CDN 主机白名单、助手文件读取链路和真实合成图验收须单独确认，详见[图片说明](../docs/IMAGES.md)。图片任务使用独立方向标记避免已审查文本基线按文字处理；代码回退前仍须核验目标版本兼容性及未完成图片任务；保留当前状态，不恢复旧库覆盖新记录。
