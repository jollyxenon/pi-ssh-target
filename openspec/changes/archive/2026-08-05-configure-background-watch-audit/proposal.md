## Why

现有遗漏审计会在 Judge 判断需要监控或无法确定时唤醒正式 Agent，既增加一轮对话，也把后台补救逻辑带入主上下文。需要把遗漏审计改为完全异步、静默的后台流程，同时允许用户按成本、判断质量和模型部署方式选择审计策略。

## What Changes

- 保留 Agent 主动调用 `pi_ssh_target start/watch` 的现有首选流程。
- 将 `agent_settled` 后的遗漏审计改为完全异步执行，不阻塞新一轮问答，也不通过消息把审计结果注入正式 Agent 上下文。
- 后台 Judge 判断需要监控时，由 extension 校验参数并直接建立 Watcher；失败或信息不足时只持久化审计结果。
- 增加可配置的判断方法：先本地筛选再交给 LLM，或每轮直接交给 LLM。
- 增加可配置的提交内容：当前有效分支的完整上下文、本轮问答，或本地筛选命中的 SSH 工具调用。
- 增加可配置的 LLM 来源：复用本轮 Pi Agent 模型配置，或使用额外的独立模型配置。
- 增加完整上下文模式专用的 prompt cache 开关。
- 默认使用“先筛后交、完整上下文、Pi Agent 配置、启用缓存命中”。
- 对无效配置组合进行启动期校验；直接交给 LLM 时不得选择“SSH 工具调用”提交模式。
- 每个 session 串行调度完全异步的审计任务，避免重复补建并提高递增上下文的缓存命中率。

## Capabilities

### New Capabilities
- `background-watch-audit`: 定义异步静默遗漏审计、可选判断与上下文策略、Judge 模型配置、缓存行为，以及由 extension 自动补建 Watcher 的行为。

### Modified Capabilities

## Impact

- `src/index.ts` 的 `agent_settled` 审计调度、session 生命周期和 Watcher 补建流程。
- `src/audit.ts` 的候选筛选、上下文构造、Judge 输入输出、模型解析和缓存参数。
- 新增 extension 配置读取、规范化和校验模块，并更新 package 文档。
- lifecycle/audit custom entries 需要记录后台任务状态、配置摘要、Judge usage、补建结果和失败原因。
- 单元测试与集成测试需要覆盖配置组合、完全异步执行、session 失效、串行队列、缓存开关、去重和自动补建。
