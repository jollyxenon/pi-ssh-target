## 1. 类型与常量清理
- [x] 1.1 删除 `StartInput`、`StartManagerResult`、`WatcherLaunchedEvent`、`StartOutcome`、`started_unwatched` 状态与 `ToolInput`/`ToolDetails.action` 等启动相关类型
- [x] 1.2 删除 `validateStartInput` 与启动限制常量（`MAX_COMMAND_LENGTH` 等）；`normalizeWatchConfig` 改为只接受 `WatchInput`

## 2. Watcher 启动逻辑移除
- [x] 2.1 `ssh-watch-manager.ts` 删除 `startLaunch`、launchMode 分支与 `resolveUnwatched`，`start()` 只走监控路径
- [x] 2.2 `watcher.py` 删除 `launch()`、`_open_log`、popener 注入与启动参数校验

## 3. 工具拆分与提示词
- [x] 3.1 `index.ts` 注册 `pi_ssh_watch` / `pi_ssh_cancel` / `pi_ssh_list` 三个工具，各自独立 schema（watch 用 Required host/pid）
- [x] 3.2 三个工具各自的 snippet / description（必填+字段说明）/ guidelines；删除 `executeStart`、`sendStartedUnwatched` 及相关辅助函数
- [x] 3.3 `prompts.ts` 删除 `buildStartedUnwatchedPrompt`；`recordCoverage` 与工具事件过滤改为按三个工具名
- [x] 3.4 `session-state.ts` 恢复校验去掉 `started_unwatched`

## 4. 测试与文档
- [x] 4.1 删除 start 相关测试（3 个 vitest 用例 + 3 个 python launch 用例），e2e 改为真实进程 + `pi_ssh_watch`
- [x] 4.2 更新 README 工具用法（删 start 章节、示例去 action、常见用法改为 ssh 启动流程）
- [x] 4.3 `npm test` 全绿、`npm run build` 成功
