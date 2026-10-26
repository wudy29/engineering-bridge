# Engineering Bridge

中文 README 已成为仓库默认首页：[简体中文](README.md)

English README: [English](README.en.md)

## 受控补丁验证（可选）

v1.6.0 保留同步 `validate_controlled_patch(patch_task_id)`；长校验推荐 `start_controlled_patch_validation(patch_task_id, idempotency_key)` 后通过 `get_controlled_patch_validation(validation_run_id)` 独立查询 retained PASS/FAIL/INCOMPLETE。start 成功前 admission 已持久化；caller 断开不取消仍由 Bridge 持有的 run。重启不续跑、不重试、不 attach、不自动删除旧现场；遗留 non-terminal run 变为 INCOMPLETE，保留 recovery fence。

命令仍只来自精确 `CONFIGURE` 的可信固定 profile，采用直接 argv、既有 step/total timeout 与 bounded output。validation 不授权 APPLY，不自动 APPLY/COMMIT/push。私有状态必须在仓库与可登记工作区边界之外；async v1 依赖 POSIX process-group supervision。临时 worktree 不是主机级沙箱。完整配置、幂等规则与迁移说明见 [简体中文 README](README.md)。

## v1.6.0 只读看板

中文看板在 `127.0.0.1:4317` 独立运行，只读本机观测快照；任务控制仍走 MCP/STDIO。当前任务、等待审核、已结束和旧进程历史分区显示。“清理历史显示”和“恢复显示”只影响浏览器本地显示，不改变任务状态或删除磁盘文件；没有磁盘自动淘汰。该 HTTP 服务没有认证或 TLS，不应公开或转发。启动方式、公开标题和诊断边界见[中文主 README](README.md#中文只读看板与任务观测)。
