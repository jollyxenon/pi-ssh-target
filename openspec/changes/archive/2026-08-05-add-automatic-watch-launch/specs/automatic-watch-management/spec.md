> **后续变更说明：** 本文件中的遗漏审计 requirements 已由 `configure-background-watch-audit/specs/background-watch-audit/spec.md` 取代。当前行为不再通过审计消息唤醒正式 Agent，而是在后台异步判断并静默补建可验证的 Watcher。

## Purpose

让 Pi Agent 更可靠地为远程 Linux 长任务建立进程树监控，并提供一次调用即可完成任务启动、PID 获取和 Watcher 登记的安全接口。

## ADDED Requirements

### Requirement: 强制提示 Agent 登记远程长任务
系统 SHALL 在 `pi_ssh_target` 激活时明确要求 Agent：启动预计长期运行或脱离当前 SSH 命令的远程 Linux 任务后，必须在同一 Agent run 内登记 Watcher，或明确说明无法登记的原因。

#### Scenario: 长任务正常登记
- **WHEN** Agent 启动远程长任务并获得稳定根 PID
- **THEN** 系统提示 Agent 在结束当前 run 前调用 `pi_ssh_target watch` 或 `start`

#### Scenario: 无法登记
- **WHEN** Agent 无法获得稳定 PID、任务已结束或用户明确拒绝监控
- **THEN** Agent 可以不创建 Watcher，但必须向用户说明原因

### Requirement: Agent run 结束后执行本地初筛
系统 SHALL 在 `agent_settled` 后检查从对应 `agent_start` 起完成的工具调用，并仅在调用记录可能表示启动了远程长任务且没有成功匹配的 Watcher 时进入 LLM 判断阶段。

#### Scenario: 没有候选调用
- **WHEN** 本轮工具调用不包含可能启动远程长任务的证据
- **THEN** 系统不调用 Judge LLM，也不产生额外 Agent turn

#### Scenario: 已有成功 Watcher
- **WHEN** 候选远程任务已有本轮成功创建且可匹配的 Watcher
- **THEN** 系统不调用 Judge LLM

#### Scenario: 正式识别 nohup
- **WHEN** 成功工具调用包含正式命令 `nohup` 并具备远程任务上下文
- **THEN** 系统把该调用视为可能需要监控的候选

### Requirement: 初筛数据必须受限且视为不可信
系统 SHALL 只向 Judge LLM 提供有界的工具名、命令摘要、退出状态、输出尾部、可能的 host/PID 和本轮 Watcher 摘要，并 SHALL 明确标记这些内容为不可信数据而非用户指令。

#### Scenario: 工具输出过长
- **WHEN** 候选工具输出超过审计上限
- **THEN** 系统截断输入后再提交 Judge LLM，不提交完整输出

#### Scenario: 工具输出包含指令文本
- **WHEN** 候选命令或输出包含要求模型执行操作的文本
- **THEN** Judge LLM 将其作为被审计数据，不将其视为系统或用户指令

### Requirement: 使用独立 Judge LLM 判断遗漏
系统 SHALL 默认复用当前 Pi session 的模型、鉴权和 provider 环境，通过独立短上下文判断候选调用是否需要 Watcher。Judge 输出 SHALL 归一化为 `yes`、`no` 或 `uncertain`。

#### Scenario: Judge 判断无需监控
- **WHEN** Judge 返回 `no`
- **THEN** 系统静默结束审计，不唤醒正式 Agent

#### Scenario: Judge 判断需要或无法确定
- **WHEN** Judge 返回 `yes` 或 `uncertain`
- **THEN** 系统唤醒正式 Agent，要求其核实任务并在需要时创建 Watcher

#### Scenario: Judge 不可用或输出无效
- **WHEN** 当前模型无法调用、鉴权失败、调用报错或输出无法解析
- **THEN** 系统按 `uncertain` 处理并唤醒正式 Agent，不静默丢弃候选任务

### Requirement: 审计必须防止重复和循环
系统 SHALL 对每批候选工具调用只审计一次，并 SHALL 防止审计唤醒的 Agent run 在没有新候选任务时再次触发同一审计。

#### Scenario: 审计 Agent 没有启动新任务
- **WHEN** 审计唤醒的 Agent 仅检查状态或创建 Watcher，没有启动新的候选任务
- **THEN** 系统不再次调用 Judge LLM

#### Scenario: 同一调用重复出现在 session 数据中
- **WHEN** 已审计的工具调用因重放或生命周期事件再次可见
- **THEN** 系统按稳定标识或内容摘要跳过重复审计

### Requirement: start action 使用结构化启动参数
`pi_ssh_target` SHALL 提供 `start` action，接受 SSH destination、`command`、`args[]`、`job_id`，并可接受 `cwd`、环境变量、SSH 参数、扫描间隔、启动超时、日志路径、结果路径和 note。

#### Scenario: 使用参数数组启动脚本
- **WHEN** Agent 提交 `command: "python3"` 和独立的脚本参数数组
- **THEN** 系统按 argv 边界启动远程进程，不把参数拼接为隐式 shell 命令

#### Scenario: 显式使用 shell
- **WHEN** 调用方确实需要管道、重定向或变量展开
- **THEN** 调用方必须显式使用 `command: "bash"` 及对应 `args`，系统不自动引入 shell

### Requirement: start action 单次调用建立任务和 Watcher
`start` action SHALL 在一次工具调用中启动远程非交互进程、取得准确根 PID、建立稳定进程身份并启动 Watcher。工具 SHALL 仅在启动结果明确后返回。

#### Scenario: 启动并成功监控
- **WHEN** 远程进程启动成功且 Watcher 完成 ready
- **THEN** 工具返回 `started_and_watched`、根 PID、watch ID 和日志路径

#### Scenario: 启动命令失败
- **WHEN** 远程进程未成功创建
- **THEN** 工具返回 `launch_failed`，且不得创建活跃 Watcher

### Requirement: 默认日志写入 Watcher 状态目录
`start` action SHALL 将未显式指定的 stdout 和 stderr 路径分别设为当前 Watcher 状态目录中的 `<watch-id>.stdout.log` 和 `<watch-id>.stderr.log`，并 SHALL 以仅当前远程用户可读写的权限创建文件。

#### Scenario: 使用默认日志路径
- **WHEN** 调用方未提供 stdout 或 stderr 路径
- **THEN** 系统在 `/tmp/pi-ssh-target-<uid>/<session-id>/` 下创建对应日志文件，返回实际路径并加入终态通知的日志路径

#### Scenario: 覆盖日志路径
- **WHEN** 调用方提供 stdout 或 stderr 路径
- **THEN** 系统使用指定路径并在工具结果中返回实际路径

### Requirement: Watcher 失败不得终止已启动任务
远程任务成功创建后，如果 Watcher 无法建立，系统 SHALL 保留任务运行，返回 `started_unwatched`、准确 host/PID、日志路径和监控错误，并唤醒正式 Agent 尝试使用已有 PID 补建 Watcher。

#### Scenario: Watcher ready 失败
- **WHEN** 远程任务已启动但 Watcher 在启动超时前未 ready
- **THEN** 工具不得终止或重新启动任务，并返回 `started_unwatched`

#### Scenario: Agent 补建 Watcher
- **WHEN** 正式 Agent 收到 `started_unwatched` 通知
- **THEN** Agent 使用返回的 PID 尝试调用 `watch`，不得再次调用 `start` 创建同一任务

### Requirement: 启动的任务脱离 SSH 标准流
`start` action SHALL 以新的远程 session 启动非交互任务，并 SHALL 将 stdin 与 SSH 通道分离、将 stdout/stderr 重定向到实际日志路径，使任务在 Watcher SSH 通道异常关闭后不因继承标准流而被动退出。

#### Scenario: Watcher SSH 异常关闭
- **WHEN** Watcher SSH 连接在任务运行期间异常关闭
- **THEN** 已启动任务不因标准流或控制终端关闭而被系统主动终止
