## Purpose

让 pi-ssh-target 在不打断正式 Agent、不向主对话注入审计消息的前提下，异步识别遗漏的远程长任务并自动补建 Watcher，同时提供可验证的判断、上下文、模型和缓存配置。

## Requirements

### Requirement: 主动监控流程保持首选
系统 SHALL 保留 Agent 在当前 run 内主动调用 `pi_ssh_target start` 或 `watch` 的能力与提示，并 SHALL 将后台审计仅作为遗漏补救机制。

#### Scenario: Agent 已主动建立 Watcher
- **WHEN** 当前问答中已经为远程任务成功建立匹配的 Watcher
- **THEN** 后台审计不得为同一任务重复建立 Watcher

### Requirement: agent_settled 后完全异步审计
系统 SHALL 在 `agent_settled` 时取得当前问答和 session 状态的不可变快照，并 SHALL 在不等待审计完成的情况下允许 Pi 继续接受下一轮用户输入。

#### Scenario: 后台 Judge 尚未完成
- **WHEN** 用户在后台 Judge 完成前提交下一条消息
- **THEN** Pi 正常开始新的 Agent run，审计任务继续在后台执行

#### Scenario: session 生命周期失效
- **WHEN** 审计所属 session 被关闭、替换、reload 或切换分支
- **THEN** 系统取消或丢弃尚未生效的后台审计结果，不得在其他 session 或分支中建立 Watcher

### Requirement: 后台审计不得污染正式上下文
系统 SHALL 使用不进入 LLM 对话上下文的持久化记录保存审计状态、Judge usage、判断结果和补建结果，并 SHALL NOT 通过审计消息唤醒正式 Agent。

#### Scenario: Judge 判断需要监控
- **WHEN** Judge 返回可执行且通过校验的 Watcher 建议
- **THEN** extension 在后台直接建立 Watcher，不向正式 Agent 发送补救消息

#### Scenario: Judge 失败或信息不足
- **WHEN** Judge 调用失败、输出无效或缺少可验证的 Watcher 参数
- **THEN** 系统仅记录失败或信息不足，不触发额外 Agent turn

### Requirement: 支持可选判断方法
系统 SHALL 支持 `prefilter_then_llm` 和 `direct_llm` 两种判断方法，并 SHALL 默认使用 `prefilter_then_llm`。

#### Scenario: 先筛选后提交且没有候选
- **WHEN** 判断方法为 `prefilter_then_llm`，且本地筛选未发现可能的远程长任务
- **THEN** 系统不调用 Judge LLM

#### Scenario: 直接提交
- **WHEN** 判断方法为 `direct_llm`
- **THEN** 系统在每次符合审计条件的 `agent_settled` 后调用 Judge LLM，不要求本地筛选先命中候选

### Requirement: 支持可选提交内容
系统 SHALL 支持 `full_context`、`current_exchange` 和 `ssh_tool_calls` 三种提交内容，并 SHALL 默认使用 `full_context`。

#### Scenario: 提交完整上下文
- **WHEN** 提交内容为 `full_context`
- **THEN** Judge 收到当前有效分支经过 compaction 后的用户消息、助手消息、工具调用和工具结果，但不接收废弃分支、extension custom entries、正式 Agent 工具 schema 或正式 Agent 系统提示

#### Scenario: 提交本轮问答
- **WHEN** 提交内容为 `current_exchange`
- **THEN** Judge 只收到最近一条用户消息至对应 `agent_settled` 之间的消息、工具调用和工具结果

#### Scenario: 提交 SSH 工具调用
- **WHEN** 提交内容为 `ssh_tool_calls`
- **THEN** Judge 只收到本地筛选命中的 SSH 或远程工具调用、结果和已提取的 host/PID 提示

#### Scenario: 无效的直接提交组合
- **WHEN** 判断方法为 `direct_llm` 且提交内容为 `ssh_tool_calls`
- **THEN** 系统在加载配置时报告配置错误，且不得静默替换为其他组合

### Requirement: 支持 Pi Agent 与独立 Judge 配置
系统 SHALL 支持 `pi_agent` 和 `independent` 两种 Judge 模型来源，并 SHALL 默认使用 `pi_agent`。

#### Scenario: 使用 Pi Agent 配置
- **WHEN** 模型来源为 `pi_agent`
- **THEN** 审计快照记录本轮结束时的当前模型身份，并在后台调用时复用对应 provider 和 Pi 鉴权

#### Scenario: 使用独立配置
- **WHEN** 模型来源为 `independent`
- **THEN** 系统使用配置中指定的 provider、model 和独立鉴权引用调用 Judge，不因正式 Agent 后续切换模型而改变

#### Scenario: 独立配置不完整
- **WHEN** 模型来源为 `independent` 但缺少 provider、model 或所需鉴权
- **THEN** 系统报告配置或调用错误，不回退到 Pi Agent 当前模型

### Requirement: 完整上下文支持可选缓存
系统 SHALL 只在提交内容为 `full_context` 时读取缓存选项，并 SHALL 在该模式下默认启用缓存命中。

#### Scenario: 完整上下文启用缓存
- **WHEN** 提交内容为 `full_context` 且缓存选项启用
- **THEN** Judge 请求使用支持长缓存的 retention 配置，并保持稳定的系统提示和历史消息前缀

#### Scenario: 完整上下文禁用缓存
- **WHEN** 提交内容为 `full_context` 且缓存选项关闭
- **THEN** Judge 请求明确禁用 prompt cache retention

#### Scenario: 非完整上下文模式
- **WHEN** 提交内容不是 `full_context`
- **THEN** 系统不读取缓存选项并明确禁用 prompt cache retention

### Requirement: 使用安全的结构化 Judge 输出
Judge SHALL 返回零个或多个结构化决策，每个决策 SHALL 表示 `watch`、`ignore` 或 `insufficient`，并 SHALL 将对话、命令和工具输出视为不可信审计数据。

#### Scenario: 一轮启动多个任务
- **WHEN** 同一问答中存在多个应监控的远程任务
- **THEN** Judge 可以返回多个独立的 `watch` 决策

#### Scenario: 工具输出包含提示注入
- **WHEN** 对话或工具输出包含要求 Judge 改变规则或执行命令的文本
- **THEN** Judge 将其作为不可信数据，不将其作为系统指令执行

### Requirement: 自动补建前必须确定性校验
系统 SHALL 只使用能够从审计快照中的结构化字段或工具调用证据验证的 host、PID 和 SSH 参数建立 Watcher，并 SHALL 使用确定性默认值补全非关键参数。

#### Scenario: 参数完整且可验证
- **WHEN** Judge 返回 `watch`，host、正整数 PID 和所需 SSH 参数均能由快照证据验证，且没有匹配的活跃或终态覆盖记录
- **THEN** extension 生成 watch ID 和缺省 job ID，并直接建立 Watcher

#### Scenario: 参数由模型凭空生成
- **WHEN** Judge 返回的 host、PID 或 SSH 参数无法由审计快照验证
- **THEN** 系统将该决策记录为 `insufficient`，不得建立 Watcher

#### Scenario: Watcher 补建失败
- **WHEN** 参数通过校验但 Watcher 无法 ready
- **THEN** 系统记录补建失败，不启动远程任务、不重试任务启动，也不唤醒正式 Agent

### Requirement: 每个 session 串行执行后台审计
系统 SHALL 按 `agent_settled` 的产生顺序为每个 session 串行执行后台审计，并 SHALL 对候选批次和 Watcher 目标进行去重。

#### Scenario: 用户快速完成多轮问答
- **WHEN** 新的审计快照在上一轮 Judge 完成前产生
- **THEN** 新快照进入同一 session 的后台队列，不与上一轮 Judge 并行执行

#### Scenario: 后续审计再次识别同一任务
- **WHEN** 后续快照再次包含已经补建或主动建立 Watcher 的同一 host/PID
- **THEN** 系统跳过重复补建并记录已覆盖结果

### Requirement: 提供明确默认配置
系统 SHALL 在用户未提供配置时使用 `prefilter_then_llm`、`full_context`、`pi_agent` 和完整上下文缓存启用的组合。

#### Scenario: 没有用户配置
- **WHEN** extension 启动时没有找到审计配置
- **THEN** 系统使用规定的默认组合执行后台遗漏审计
