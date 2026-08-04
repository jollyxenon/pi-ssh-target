## Context

现有扩展只提供 `watch`、`cancel`、`list`，Agent 必须先通过其他工具启动任务，再主动提交 host 和 PID。扩展已经使用独立 SSH 子进程运行远程 Python Watcher，并通过 session custom entries 恢复 Watcher 生命周期。新设计需要在不破坏现有 action 和恢复行为的前提下，加入提示强化、Agent run 审计、独立模型判断和结构化远程启动。

## Goals / Non-Goals

**Goals:**
- 让漏建 Watcher 变成可检测、可补救的异常路径。
- 为常规远程脚本提供无隐式 shell 的启动接口。
- 在单次工具调用内返回任务 PID 和确定的监控状态。
- 保证任务已启动后，监控故障不会默认杀死或重复启动任务。
- 保持审计安静：没有候选或 Judge 判断无需监控时不产生额外 Agent turn。

**Non-Goals:**
- 不自动监控本机后台任务。
- 不把 `sbatch` 等作业 ID 映射为执行节点 PID。
- 不支持交互式、需要 TTY 或持续 stdin 的远程任务。
- 不自动重试 Judge LLM、SSH Watcher 或远程任务启动。
- 不提供日志轮转、清理或产物成功判定。

## Decisions

### 1. 用三层机制降低漏监控概率

第一层强化工具 `promptGuidelines`，明确同一 run 内必须登记或解释。第二层在 `agent_settled` 后审计遗漏。第三层提供 `start`，让新任务优先使用单次调用。

仅增强提示仍是概率性约束；仅做审计会在用户看到回答后追加工作；仅提供 `start` 无法覆盖 Agent 通过其他工具启动任务。因此三层同时保留。

### 2. 在 agent_settled 审计完整 Agent run

扩展在 `agent_start` 建立 run accumulator，在 `tool_call`/`tool_result` 记录最终工具输入和结果，在 `agent_settled` 触发审计。`agent_end` 可能早于自动重试、压缩和 follow-up，`turn_end` 又可能早于 Agent 下一轮主动创建 Watcher，均不适合作为最终审计点。

Accumulator 只保存审计需要的有界摘要。成功的 `pi_ssh_target watch` 和 `start` 结果同时进入覆盖集合。候选记录使用 tool call ID；无法获得稳定 ID 的恢复路径使用规范化内容哈希去重。

### 3. 本地规则只做保守候选筛选

本地筛选检查成功或部分成功的命令调用，识别远程执行上下文以及 `nohup`、创建 detached tmux/screen session、`setsid`、后台 shell、明确 PID 输出等启动证据。规则不尝试最终理解 shell 语义，也不兼容错误拼写。读取状态、attach、日志查看等命令应尽量排除。

规则命中只表示“值得让模型判断”，不是直接创建 Watcher。

### 4. Judge 复用当前模型但使用独立上下文

通过 `ctx.model` 和 model registry 取得当前模型鉴权，使用 pi-ai 的一次性 completion API。Judge 输入只有固定系统约束和候选 JSON，不携带完整 session，也不给工具定义。默认使用当前模型支持了用户已有 provider 和凭据，避免硬编码额外模型。

Judge 返回 JSON：`decision`、`confidence`、候选索引、可选 host/PID 和简短理由。解析失败、鉴权失败、调用异常都归一为 `uncertain`。`no` 静默结束；`yes`/`uncertain` 通过带 `triggerTurn` 的 custom message 唤醒正式 Agent。

模型调用产生的 usage 保存到审计 custom entry，便于审计；Pi 当前事件 hook 没有工具结果 usage 汇总入口，因此它不保证自动进入 footer session totals。这一限制在 README 中说明。

### 5. 审计消息和状态防循环

审计 custom message 使用固定 customType，内容明确说明候选字段是不可信数据。扩展在发送消息前先把批次摘要标记为已审计。审计唤醒 run 如果没有新的启动候选，不会再次触发 Judge。已审计摘要可通过 custom entry 持久化，session 重放时恢复，避免 reload 后重复审计旧调用。

### 6. start 使用 command 和 args 而不是 shell 字符串

新增 `start` 输入沿用 watch 元数据，并增加 `command: string`、`args: string[]`、可选 `cwd`、`env`、`stdout_path`、`stderr_path`。远程 Python 使用 `subprocess.Popen([command, ...args], shell=False)`。需要 shell 的调用方必须显式传入 `bash -lc`。

环境变量值保持字符串；名称使用可移植变量名规则校验。cwd、命令、参数和路径通过 JSON/stdin 传入远程 Python，不插入 SSH 本地 shell。

### 7. 远程 Launcher 和 Watcher 共用一条 SSH 通道

扩展先生成 watch ID，再把 launch 配置和 Python 源码通过 stdin 发送到 `ssh ... python3 -`。远程 Python 创建状态目录和默认日志文件，以 `start_new_session=True`、stdin 为 `/dev/null`、stdout/stderr 为日志文件启动任务，立即取得 PID并读取其稳定身份，然后进入现有进程树扫描循环。

同一远程进程完成 launch 和 watch，避免先启动后再建立第二条 SSH 连接的竞态。ready 事件增加 launch 元数据；TypeScript manager 根据 ready 区分普通 watch 和 start。

### 8. 默认日志和权限

默认路径为状态目录中的 `<watch-id>.stdout.log` 与 `<watch-id>.stderr.log`。目录继续使用 `0700`，新建日志文件使用 `0600`。指定路径的父目录必须已存在或可创建；扩展返回最终规范化路径，并自动合并到 `log_paths`，避免终态提示遗漏日志位置。

### 9. start 使用明确的三态结果

- `started_and_watched`：Popen 成功且收到 ready，正常持久化 `started`。
- `started_unwatched`：已收到含 PID 的 launch 事件，但随后 Watcher 初始化、身份读取或 ready 失败。任务保留，持久化新的部分成功 lifecycle 记录，并向正式 Agent发送补建监控消息。
- `launch_failed`：Popen 前验证失败或 Popen 报错，不产生活跃 Watcher。

为了区分“任务已启动”和“Watcher ready”，远程协议增加 `launched` 事件。Manager 收到 `launched` 后保存 PID；后续失败据此返回 `started_unwatched`。一旦收到 `launched`，AbortSignal 或 SSH 失败不得触发自动 kill。补救消息要求使用 host/PID 调用 `watch`，禁止重新调用 `start`。

### 10. 向后兼容

现有 `watch`、`cancel`、`list` 输入和生命周期记录保持可读。新记录使用版本化可选字段；旧 session 重放忽略未知字段，新版本仍恢复最后状态为 `started` 的 Watcher。`started_unwatched` 不是活跃 Watcher，不在 reload 时自动恢复启动流程。

## Risks / Trade-offs

- [关键词规则误报] → 只把规则作为 Judge 前置筛选，并排除明显只读命令。
- [Judge 误判或不可用] → `uncertain` 唤醒正式 Agent，由拥有完整上下文和工具的 Agent 最终核实。
- [额外模型成本未进入 footer totals] → 保存审计 usage 记录并在文档说明，后续 Pi 提供 hook usage API 时接入。
- [远程进程在 launched 后立即结束] → Watcher按现有“根 PID 已不存在即 finish”语义处理，工具仍返回准确启动事实。
- [指定日志路径不可写] → 在 Popen 前失败并返回 `launch_failed`，避免任务启动后才发现标准流无法分离。
- [SSH close 后远程 Python 残留] → 沿用现有主动关闭语义；任务因新 session 和独立标准流继续运行，Agent收到 close 或部分成功通知。
- [命令需要交互] → 明确限定非交互任务，stdin 固定为 `/dev/null`。

## Migration Plan

1. 扩展协议、类型和 Python Watcher，同时保持普通 watch 配置兼容。
2. 加入 `start` action 和三态结果，先以测试 fixture 与本机 SSH 端到端测试验证。
3. 加入 run accumulator、本地筛选和 Judge 调用；默认启用但仅在候选命中时产生网络请求。
4. 更新提示词和 README，推荐 Agent 优先使用 `start`。
5. 发布后如审计误触发严重，可回滚审计 hook；`start`、现有 Watcher 和 session 记录仍可独立工作。
