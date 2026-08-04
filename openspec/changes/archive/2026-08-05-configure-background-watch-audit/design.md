## Context

当前扩展在 `agent_start` 到 `agent_settled` 之间收集候选工具结果和成功 Watcher 覆盖。`agent_settled` handler 会等待 Judge，并在 `yes` 或 `uncertain` 时发送 follow-up 消息唤醒正式 Agent。Judge 仅接收有界候选摘要，固定复用当前模型，且明确关闭 prompt cache。

本变更建立在现有主动 `start/watch`、`SshWatchManager`、session lifecycle custom entries 和本地候选筛选之上。Pi 的 custom entries 不进入 LLM 上下文，适合保存静默审计状态；`agent_settled` 表示自动重试、压缩重试和已有 follow-up 均已结束，但新的用户输入可以立即开始下一轮 run。

## Goals / Non-Goals

**Goals:**
- 保持主动 `start/watch` 为及时、可靠的主路径。
- 让遗漏审计完全异步，既不阻塞新问答，也不向正式 Agent 上下文注入消息。
- 支持用户选择判断方法、提交内容、Judge 模型来源和完整上下文缓存策略。
- 在 Judge 给出可验证参数时由 extension 直接补建 Watcher。
- 让连续多轮完整上下文 Judge 请求保持稳定前缀，以利用 provider prompt cache。

**Non-Goals:**
- 不保证在 Pi 进程退出后继续完成尚未结束的 Judge 请求。
- 不让 Judge 启动远程任务、修改远程任务或执行任意命令。
- 不从 scheduler job ID 推导执行节点 PID。
- 不为无法从对话或工具证据验证的 host/PID 猜测参数。
- 不把后台 Judge usage 合并进 Pi footer totals，除非未来 Pi 提供对应 hook API。

## Decisions

### 1. 主动路径不变，后台审计只替换现有补救路径

保留工具的 `promptSnippet`、`promptGuidelines`、`start`、`watch` 及本轮覆盖记录。成功主动监控的 host/PID 在后台判断前继续被排除。

现有“Judge 后发送 follow-up，让正式 Agent 补建”的路径改为“Judge 后 extension 直接调用 Watcher manager”。这样主模型仍能及时建立监控，只有漏网任务使用后台恢复。

备选方案是删除主动提示、完全依赖结束审计；该方案会延迟监控、丢失短任务并降低 PID 可获得性，因此不采用。

### 2. `agent_settled` 只排队，不等待后台任务

handler 在同步阶段完成以下操作：

1. 生成不可变审计快照；
2. 记录 session ID、branch leaf ID、当前模型身份、候选、覆盖集合和所需消息；
3. 将快照加入 session 内部队列；
4. 立即返回。

队列 worker 使用 `void runQueue().catch(...)` 启动，不把 Promise 返回给事件系统。用户可以在 Judge 运行期间继续下一轮问答。

完全异步不等于并行。每个 session 只运行一个 Judge，后续快照按顺序等待。串行执行减少重复 Watcher、保持状态因果顺序，并让完整上下文请求更容易复用前一轮缓存前缀。

### 3. 用 session generation 防止旧后台任务生效

extension 实例维护单调递增的 generation。`session_start`、`session_tree` 和 `session_shutdown` 使旧 generation 失效，并取消仍可取消的 Judge 请求。Judge 返回后、持久化前和启动 Watcher 前都检查：

- extension 未 disposed；
- session ID 与快照一致；
- generation 未变化；
- 当前 branch 仍包含快照 leaf；
- 目标没有被后续主动或自动 Watcher 覆盖。

若检查失败，丢弃结果。虽然正常使用中活跃 Watcher 会使用户保持 session，reload、fork、tree 和进程退出仍可能发生，不能允许旧闭包操作新 session。

### 4. 使用一个严格规范化的审计配置

从用户级专用配置文件 `~/.pi/agent/pi-ssh-target.json` 读取配置；没有文件时使用默认值。第一版不引入项目级覆盖和多层合并，避免同一后台行为存在多个来源。

配置形状：

```json
{
  "audit": {
    "judgmentMethod": "prefilter_then_llm",
    "submission": "full_context",
    "model": {
      "source": "pi_agent"
    },
    "cacheEnabled": true
  }
}
```

独立模型配置：

```json
{
  "audit": {
    "model": {
      "source": "independent",
      "provider": "anthropic",
      "model": "claude-haiku-4-5",
      "apiKeyEnv": "PI_SSH_TARGET_JUDGE_API_KEY"
    }
  }
}
```

独立配置仍复用 Pi model registry 中的 provider 实现和模型元数据，但模型选择固定，不跟随正式 Agent。`apiKeyEnv` 只引用环境变量名，不允许配置内明文密钥。未指定 `apiKeyEnv` 时可使用 Pi 已配置的该 provider 鉴权。

加载时做严格校验，拒绝未知枚举、缺失的独立模型字段和 `direct_llm + ssh_tool_calls`。`cacheEnabled` 在非 `full_context` 模式下不参与规范化结果，运行时固定为关闭。

### 5. 预筛选只决定是否调用 LLM

`prefilter_then_llm` 继续使用现有保守规则识别远程上下文、后台启动证据和 PID，并排除只读调用。若候选在本轮或后续状态中已有覆盖，不调用 Judge。

`direct_llm` 不要求候选命中；每个非空问答快照都进入 Judge。它仍会在执行前做 Watcher 覆盖去重。

本地规则不直接决定建立 Watcher，避免正则误报产生远程 SSH 连接。

### 6. 三种提交内容使用同一安全消息转换

- `full_context`：从 `sessionManager.buildContextEntries()` 得到当前有效分支和 compaction 后消息，转换为 Judge 可接受的消息。排除 custom entries、正式 Agent system prompt 和工具定义。
- `current_exchange`：在上述消息中截取最后一条用户消息到当前快照 leaf。
- `ssh_tool_calls`：使用本地筛选生成的有界候选列表，不发送其余对话。

完整上下文与本轮问答保留消息角色和工具调用关系，而不是拼成一段自由文本。Judge 使用固定系统约束，明确所有用户消息、助手消息、命令和工具输出都是待审计材料，不得改变 Judge 的权限或输出协议。

如果上下文超过指定模型窗口，先保留固定 Judge prompt、最近问答和候选工具证据，再从最旧历史开始裁剪。该裁剪只用于 Judge，不修改 Pi session。

### 7. 缓存只服务完整上下文模式

`full_context + cacheEnabled` 使用 `cacheRetention: "long"`；`full_context + !cacheEnabled` 和其他提交模式使用 `cacheRetention: "none"`。

为提高命中率：

- Judge system prompt 保持字节稳定；
- 完整历史保持原有顺序和内容；
- 不在缓存前缀插入时间、随机 ID 或批次哈希；
- 本轮审计指令和结构化输出要求放在末尾；
- session 队列串行发送递增上下文。

缓存是否真正命中由 provider/model 决定。审计 custom entry 保存返回 usage 中的 cache read/write 信息，文档不承诺固定节省比例。

### 8. Judge 输出支持多个任务，但权限保持最小

Judge 输出固定 JSON：

```json
{
  "decisions": [
    {
      "action": "watch",
      "evidenceIndexes": [0],
      "host": "gpu01",
      "pid": 12345,
      "jobId": "train-exp",
      "sshArgs": [],
      "reason": "远程后台训练仍可能运行"
    }
  ]
}
```

`action` 只能是 `watch`、`ignore` 或 `insufficient`。Judge 没有工具，不执行命令。`uncertain` 不再触发正式 Agent；无法产生可验证参数时使用 `insufficient` 并静默记录。

### 9. 参数校验以证据为准

执行层不信任 Judge 输出：

- PID 必须是正整数，并在工具结果或结构化远程工具字段中出现；
- host 必须能从原始 SSH argv 或结构化字段提取；
- `sshArgs` 只能是原始调用中观察到且属于该 host 的参数子序列；
- 禁止 Judge提供 command、env、cwd 或远程启动参数；
- job ID 缺失时由 host、PID 和 tool call ID 确定性生成；
- interval、startup timeout、路径和 note 使用现有默认值或可信原始元数据；
- 启动前再次检查已有 coverage。

参数通过后生成新的 watch ID，调用普通 Watcher 启动路径，并持久化 `started` lifecycle，附加 `origin: "audit"`。该记录可以像主动 Watcher 一样在 reload 后恢复。

### 10. 后台状态只写 custom entries

审计状态至少记录：批次 hash、session/leaf 标识、配置摘要、开始与结束时间、Judge decision 摘要、usage、自动补建的 watch IDs，以及错误尾部。记录不包含完整对话、完整命令或鉴权信息。

Judge、校验或 Watcher 启动失败时不调用 `sendMessage`。自动补建成功后的 Watcher 终态仍沿用现有 `finish`、`interrupt`、`close` steer，因为唤醒 Agent 检查真实任务结果正是 Watcher 的核心行为。

## Risks / Trade-offs

- [完全异步任务可能在 Pi 退出时中止] → shutdown 时取消请求并记录可记录的状态；不承诺跨进程完成审计。
- [完整上下文包含提示注入或敏感内容] → 使用固定 Judge 系统约束、无工具调用权限、严格 JSON 解析；文档明确完整上下文会发送给所选模型 provider。
- [完整上下文成本和窗口压力较大] → 默认先筛选减少调用次数，利用长缓存，并在超过窗口时按明确优先级裁剪。
- [自动建立 SSH Watcher 是后台副作用] → 只允许证据可验证的 host/PID/sshArgs，Watcher 不启动或终止任务，失败静默记录。
- [用户快速多轮输入导致审计积压] → 每 session 串行队列并对覆盖目标去重；第一版不丢弃中间快照，以保持可审计性。
- [Pi Agent 模型在后台执行前被切换] → 快照固定本轮结束时的模型身份，调用时按该身份解析 provider 和鉴权。
- [独立 provider 不支持 long cache] → 仍发送统一 retention 选项，由 provider 能力决定实际命中，usage 记录真实结果。

## Migration Plan

1. 加入配置类型、默认值、用户级配置加载和严格校验；现有无配置安装自动获得默认组合。
2. 把 Judge 输入构造拆分为完整上下文、本轮问答和 SSH 候选三种策略，并加入独立模型解析与缓存选项。
3. 将 `agent_settled` 改为快照入队后立即返回，加入 session generation、串行 worker 和 shutdown 取消。
4. 用后台自动补建替换 audit follow-up 消息，保留现有主动路径和 Watcher 终态 steer。
5. 扩展 lifecycle/audit 记录、`list` 输出和 README 配置说明。
6. 发布前验证默认行为、所有合法配置组合、无效组合、缓存参数、并发问答、session 切换和自动补建。
7. 如后台自动补建出现严重误报，可回滚为只记录 Judge 结果；主动 `start/watch` 与现有 Watcher 恢复不受影响。
