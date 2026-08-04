> **后续变更说明：** `configure-background-watch-audit` 已取代本文的遗漏审计部分。当前实现保留主动 `start/watch`，但在 `agent_settled` 后完全异步调用可配置 Judge，并由 extension 静默补建 Watcher；不再使用短上下文固定策略，也不再唤醒正式 Agent 补建。本文其余远程启动设计仍然有效。

## Why

Agent 启动远程长任务后仍可能漏调 `pi_ssh_target watch`，使任务结束时无法自动恢复原 Pi session。仅靠提示词不能稳定避免遗漏，同时现有两步式“启动任务、获取 PID、再登记 Watcher”容易在 Agent 收尾时被跳过。

## What Changes

- 强化 `pi_ssh_target` 的系统提示：启动远程长任务时必须获取根 PID，并在同一轮完成 Watcher 登记或明确说明无法登记的原因。
- 在 Agent 完全结束一次运行后，对本轮工具调用做本地规则初筛；只有发现可能启动远程长任务且没有匹配 Watcher 时，才调用独立 Judge LLM 判断。
- Judge LLM 默认复用当前 Pi session 的模型和凭据，使用独立、受限上下文；判断为需要监控或不确定时，唤醒正式 Agent 核实并补建 Watcher。
- 为 `pi_ssh_target` 新增 `start` action，一次调用完成远程命令启动、PID 获取和 Watcher 建立。
- `start` 使用 `command + args[]` 传递启动程序及参数，支持工作目录、环境变量、SSH 参数和日志路径，不默认拼接 shell 命令。
- stdout/stderr 默认写入远程 Watcher 状态目录；用户可覆盖路径。
- 任务启动成功但 Watcher 建立失败时保留任务，返回 PID 和监控错误，并唤醒 Agent 尝试补建 Watcher；不得自动重复启动任务。

## Capabilities

### New Capabilities
- `automatic-watch-management`: 覆盖强制监控提示、运行结束后的 Judge LLM 遗漏审计，以及远程任务原子启动与 Watcher 建立。

### Modified Capabilities

## Impact

- 扩展入口、工具 schema、提示词和 session 生命周期状态。
- 远程 Python Watcher 增加受控进程启动和日志重定向能力。
- 新增独立模型调用，需要复用当前模型鉴权并处理取消、错误、用量和输出解析。
- 增加 Agent 运行审计记录、去重和防循环状态。
- 更新 TypeScript、Python、集成测试、README 和 OpenSpec 文档。
