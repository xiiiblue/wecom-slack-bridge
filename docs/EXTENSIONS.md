# 可信运行时扩展

默认入口 `src/main.js` 只启动通用桥接器。它不依赖任何业务仓库，也不会从消息加载代码或执行工作流。扩展用于复用既有连接与事务，不是插件下载器、消息指令系统或沙箱。

本项目设置 `private: true` 防止误发 npm；以下是本地依赖/组合应用的导出接口，不承诺包已在 npm 发布。组合应用从 `wecom-slack-bridge/runtime` 导入 `startBridge`，调用 `startBridge({ createApplication })`。工厂收到 `{ config, store, env }`，返回可信应用对象。不要另外启动第二个桥接进程或争用同一 Bot ID。

|钩子|调用边界与返回值|
|---|---|
|`initialize({ store, config })`|建立平台连接前初始化应用 schema，可异步|
|`receiveRoot(bridge, event)`|固定频道、可信作者通过后处理新 Slack 根；同步返回严格 true 才表示接收|
|`receiveOwnerText(bridge, text, source, now)`|已认证本人单聊的同步事务内；null 交通用问答，非空请求 ID 表示接收，其他返回值拒绝；不得返回 Promise|
|`authorizeRequest(bridge, request)`|非通用请求须同步返回严格 true；缺失、抛错或其他值均拒绝|

平台认证、固定频道与本人边界先于应用钩子；固定出站目标也不会被钩子授权放宽。应用负责自身语义、schema、权限、升级和测试；同进程代码有全部进程权限与共享数据库访问能力，必须作为部署代码审阅。

应用记录和发件箱可以在同一 SQLite 事务写入。原子性只覆盖本地数据库，不覆盖外部消息。应用必须维护合法的 request/job 结构、正文、目标和到期时间，不直接修改 unknown 为 pending。

通用请求类型为 single/group/notify。已有自定义请求、业务表和关联保留；未注入应用时发送循环跳过自定义 pending 项，不降级为普通请求。通用恢复仍会将 sending 改为 unknown；明确 job 到期仍可清理。通用请求 TTL 清理不会删除自定义请求本体；去重键仍按7天清理，因此应用若需要更长去重或业务保留，须自行设计和验收。

独立运行时不解释业务表；保留数据不等于保证任意旧应用兼容。升级和回退必须验证当前数据库、待发内容及应用自身约束，见 [部署维护](../deploy/README.md)。
