## Why

`pi_ssh_target` 单一工具用 `action` 枚举区分 `start`/`watch`/`cancel`/`list`，导致参数 schema 无法精确表达每个操作必填的字段（全部 Optional，必填只能靠运行时校验），模型调用时容易混淆参数（如把远程命令参数 `args` 误当成 SSH 连接参数）。同时 `start` 的启动职责与监控职责耦合，让高频路径（监控）和低频路径（启动、取消、列表）共用一份宽泛的 schema 与提示词。

## What Changes

- **BREAKING**：移除 `pi_ssh_target` 工具及其 `start` action。工具不再负责启动远程任务。
- 注册三个独立工具：`pi_ssh_watch`（监控已运行的远程进程树）、`pi_ssh_cancel`（取消监控）、`pi_ssh_list`（查看监控列表）。
- `pi_ssh_watch` 的参数 schema 用 `Required` 精确表达 `host` + `pid`，不再有 `action` 字段；`command`/`args`/`cwd`/`env`/`stdout_path`/`stderr_path` 等启动参数全部移除。
- 远程启动职责回归 Agent 的普通 SSH 能力（如 `ssh host 'nohup cmd > /tmp/out.log 2>&1 & echo PID=$!'`），工具只做纯监控。
- 删除远程 Watcher 的启动（launch）逻辑、`started_unwatched` 状态和 `buildStartedUnwatchedPrompt` 补救提示。
- 三个工具各自携带聚焦的 `promptSnippet`、`description`（含必填字段说明）和 `promptGuidelines`。

## Capabilities

### New Capabilities

- 无新增 capability。

### Modified Capabilities

- `remote-process-monitoring`: 工具从单一 `pi_ssh_target`（带 `action` 枚举）拆分为 `pi_ssh_watch` / `pi_ssh_cancel` / `pi_ssh_list` 三个独立工具；输入契约移除 `action` 字段与启动参数。
- `automatic-watch-management`: 移除 `start` 相关 requirements（结构化启动参数、单次调用启动并登记、默认日志写入、启动失败不终止任务、任务脱离 SSH 标准流）；登记提示指向 `pi_ssh_watch`。

## Impact

- `src/index.ts`：工具注册与执行分发重写；删除 `executeStart`、启动辅助函数。
- `src/ssh-watch-manager.ts`：删除 `startLaunch` 与 launchMode 分支。
- `src/watcher.py`：删除远程进程启动逻辑（command/args/env/cwd/日志重定向）。
- `src/types.ts` / `src/constants.ts` / `src/prompts.ts` / `src/session-state.ts`：删除启动相关类型、校验、状态与提示。
- 测试：删除 3 个 start 单元用例与 3 个 python launch 用例；e2e 改为真实进程 + `pi_ssh_watch` 流程。
- README 工具用法章节重写。
