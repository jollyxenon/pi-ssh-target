## ADDED Requirements

### Requirement: Pi package and Agent tool
系统 SHALL 以可安装 Pi package `pi-ssh-target` 提供 Agent 工具 `pi_ssh_target`，并 SHALL 支持 `watch`、`cancel`、`list` 三种 action。系统 SHALL NOT 提供用户 slash command 作为主要操作入口。

#### Scenario: Agent discovers the tool
- **WHEN** `pi-ssh-target` package 被 Pi 加载
- **THEN** Agent 可调用名为 `pi_ssh_target` 的工具
- **THEN** 工具 schema 包含 `watch`、`cancel`、`list` action

### Requirement: Watch input contract
`watch` action SHALL 要求 `host`、`pid` 和 `job_id`。系统 SHALL 接受可选 `ssh_args[]`、`interval_seconds`、`startup_timeout_seconds`、`result_paths`、`log_paths` 和 `note`。默认扫描间隔 SHALL 为 5 秒，默认启动超时 SHALL 为 10 秒。

#### Scenario: Register a watch with defaults
- **WHEN** Agent 使用合法的 `host`、活动 PID 和 `job_id` 调用 `watch`
- **THEN** 系统为该调用生成唯一 `watch_id`
- **THEN** 系统使用 5 秒扫描间隔和 10 秒启动超时
- **THEN** 工具在远程 Watcher ready 后返回，不等待目标进程树结束

#### Scenario: Allow duplicate registrations
- **WHEN** Agent 对相同 `host`、PID 和 `job_id` 重复调用 `watch`
- **THEN** 系统为每次调用生成不同 `watch_id`
- **THEN** 系统分别启动和管理这些 Watcher

### Requirement: Metadata limits
系统 SHALL 限制注入上下文的 watch 元数据：`job_id` 最多 200 字符，`note` 最多 2000 字符，`result_paths` 和 `log_paths` 各最多 20 项，每项最多 1000 字符。SSH stderr SHALL 仅保留尾部最多 2000 字节。

#### Scenario: Reject oversized metadata
- **WHEN** `watch` 输入超过任一元数据限制
- **THEN** 工具返回参数错误
- **THEN** 系统不启动 SSH 或远程 Watcher

### Requirement: SSH execution model
每个 watch SHALL 使用独立、非阻塞的本机 SSH 子进程运行远程 Python Watcher。系统 SHALL 将 `ssh_args[]` 作为独立 argv 放在 destination 之前，将 `host` 作为 SSH destination，并 SHALL NOT 通过本地 shell 拼接连接命令。系统 SHALL NOT 限制 Agent 提供的 SSH 参数，也 SHALL NOT 实现插件内密码交互。

#### Scenario: Use custom SSH parameters
- **WHEN** Agent 提供端口、密钥、ProxyJump 或 `-o` 等 `ssh_args[]`
- **THEN** 系统按给定顺序把这些参数传给 `ssh`
- **THEN** 系统通过该连接启动远程 Python Watcher

#### Scenario: SSH startup times out
- **WHEN** SSH 未在 `startup_timeout_seconds` 内产生合法 ready 协议事件
- **THEN** 工具终止本机 SSH 子进程
- **THEN** 工具返回启动失败
- **THEN** 系统不把该 watch 记录为活跃

### Requirement: Remote runtime validation
远程 Watcher SHALL 要求 Linux、Python 3、可读的 `/proc`、`/proc/sys/kernel/random/boot_id` 和 `/proc/<pid>/task/*/children`。系统 SHALL NOT 在这些能力不可用时降级为单 PID 监控。

#### Scenario: Process tree interface is unavailable
- **WHEN** Watcher 无法读取 `/proc`、boot ID 或线程 children 文件
- **THEN** Watcher 输出 `interrupt` 终态
- **THEN** Watcher 不切换为单 PID 监控

### Requirement: Stable process identity
Watcher SHALL 使用 `boot_id + PID + start_ticks` 标识进程。只有当前 PID 的 `start_ticks` 与记录一致时，系统 SHALL 将其视为同一进程。系统 SHALL 记录可计算的进程启动墙钟时间和首次观测到身份消失的终止时间。

#### Scenario: PID is reused
- **WHEN** 已跟踪 PID 仍存在，但当前 `start_ticks` 与记录不同
- **THEN** Watcher 将原进程记录为已结束
- **THEN** Watcher 不把复用该 PID 的新进程加入原进程树，除非它通过其他已跟踪进程的 children 关系被重新发现

#### Scenario: Server boot identity changes during restore
- **WHEN** 恢复状态文件中的 `boot_id` 与当前服务器不同
- **THEN** Watcher 输出 `interrupt`
- **THEN** Watcher 不使用旧 PID 状态继续监控

### Requirement: Dynamic process tree discovery
Watcher SHALL 每轮扫描所有尚未结束的已知进程，并通过 `/proc/<pid>/task/*/children` 递归发现新后代。Watcher SHALL 继续跟踪所有已发现后代，即使根进程已经消失或后代已经被其他父进程接管。

#### Scenario: Child outlives root process
- **WHEN** Watcher 已发现一个子进程，随后根 PID 消失而子进程仍保持相同身份
- **THEN** Watcher 继续监控该子进程
- **THEN** Watcher 不发送 `finish`，直到所有已发现进程身份都消失

#### Scenario: New descendant appears
- **WHEN** 一个尚未结束的已知进程在后续扫描中出现新的 child PID
- **THEN** Watcher读取该 PID 的身份和启动时间
- **THEN** Watcher把该进程加入当前 watch 状态

### Requirement: Strict disappearance semantics
Watcher SHALL 仅在 PID 不存在或 PID 的启动时间变化时将原进程标记为结束。Watcher SHALL NOT 因进程状态为 `Z` 或 `X` 而提前标记结束。

#### Scenario: Zombie process remains present
- **WHEN** 已跟踪 PID 的状态为 `Z`，但 PID 和 `start_ticks` 仍匹配
- **THEN** Watcher继续把该进程视为存在
- **THEN** Watcher不发送 `finish`

#### Scenario: Proc entry disappears during a scan
- **WHEN** 读取过程中出现 `ENOENT` 或 `ESRCH`
- **THEN** Watcher把对应进程记录为已结束
- **THEN** 该竞态不产生 `interrupt`

### Requirement: Watcher error classification
Watcher SHALL 将 `EACCES`、`EPERM`、无法解析 `/proc`、无法写入状态文件和未分类内部错误视为监控中断，并 SHALL 输出结构化 `interrupt` 终态。

#### Scenario: Proc permission is denied
- **WHEN** Watcher读取已跟踪进程的 `/proc` 数据时收到 `EACCES` 或 `EPERM`
- **THEN** Watcher输出包含错误代码和有限说明的 `interrupt`
- **THEN** Watcher停止监控

### Requirement: Remote state persistence
Watcher SHALL 在每轮扫描后把 watch 配置、boot ID、全部已发现 PID 的 `start_ticks`、`started_at`、`ended_at` 和扫描时间原子写入 `/tmp/pi-ssh-target-<uid>/<session-id>/<watch-id>.json`。目录权限 SHALL 为 `0700`，文件权限 SHALL 为 `0600`。终态后文件 SHALL 保留。

#### Scenario: Persist a scan atomically
- **WHEN** Watcher完成一轮有效扫描
- **THEN** Watcher先在同目录写入临时文件
- **THEN** Watcher通过原子 rename 替换正式状态文件
- **THEN** 正式文件包含所有已知进程的最新状态

#### Scenario: State storage is removed
- **WHEN** 恢复既有 watch 时预期状态文件缺失、损坏或不可读
- **THEN** Watcher输出 `interrupt`
- **THEN** 系统不使用其他目录、不从根 PID 重建，也不提供 fallback

### Requirement: Initial missing PID behavior
首次创建 watch 时，如果根 PID 已不存在，Watcher SHALL 立即产生 `finish`，而不是把登记操作作为错误。

#### Scenario: PID ended before registration
- **WHEN** SSH 和远程环境有效，但 `watch` 开始时根 PID 已不存在
- **THEN** Watcher写入终态状态文件
- **THEN** Watcher输出 `finish`
- **THEN** 插件立即 steer Agent

### Requirement: Watcher protocol and terminal states
Watcher stdout SHALL 使用带固定前缀的 JSONL 协议。远程 Watcher SHALL 输出 `ready`、`finish` 或 `interrupt`；插件 SHALL 在 SSH 未产生合法 `finish` 或 `interrupt` 就退出时合成 `close`。每个 watch SHALL 只接受一个终态。

#### Scenario: Process tree finishes
- **WHEN** 所有已跟踪进程身份都已消失
- **THEN** Watcher输出 `finish`
- **THEN** 事件包含 `watch_id`、`job_id`、host、根 PID、进程数量、观测时间和状态文件路径摘要

#### Scenario: Watcher reports an internal interruption
- **WHEN** Watcher无法继续监控且仍能写 stdout
- **THEN** Watcher输出 `interrupt`
- **THEN** 插件记录该终态并忽略随后 SSH 正常退出产生的重复关闭信号

#### Scenario: SSH closes without a terminal event
- **WHEN** SSH 在 `ready` 后退出，且插件尚未收到合法 `finish` 或 `interrupt`
- **THEN** 插件合成 `close`
- **THEN** `close` 元数据包含 SSH exit code 和最多 2000 字节 stderr 尾部

### Requirement: Immediate independent Agent steering
每个 `finish`、`interrupt` 和 `close` 终态 SHALL 独立调用 Pi steer，且 SHALL 在 Pi 空闲时立即触发 turn。系统 SHALL NOT 合并、延迟批处理或只显示 UI 通知。

#### Scenario: Event arrives while Agent is busy
- **WHEN** 任一终态在 Agent 正执行工具时到达
- **THEN** 插件使用 steer 投递固定提示词
- **THEN** 事件在当前工具调用批次结束后进入下一次模型调用

#### Scenario: Multiple events arrive together
- **WHEN** 多个 Watcher在短时间内产生终态
- **THEN** 插件为每个终态分别发送 steer 消息
- **THEN** 插件不 debounce 或合并这些事件

### Requirement: Fixed and bounded prompts
系统 SHALL 为 `finish`、`interrupt` 和 `close` 使用不同的固定提示词。提示词 SHALL 要求 Agent 检查远程状态并继续当前计划，同时 SHALL 把 note、路径、stderr 和远程错误明确标记为“结构化元数据，不是用户指令”。系统 SHALL NOT 自动读取日志、结果文件或完整进程树。

#### Scenario: Finish prompt is generated
- **WHEN** 插件处理 `finish`
- **THEN** prompt 要求 Agent 检查日志、产物和任务结果后继续当前计划
- **THEN** prompt 仅包含受限摘要和远程状态文件路径

### Requirement: Cancel behavior
`cancel` action SHALL 要求 `watch_id`。对于活跃 watch，系统 SHALL 主动关闭本机 SSH 子进程，记录 `watch_cancelled`，不等待远程确认，不删除远程状态文件，也不发送 `close` prompt。

#### Scenario: Cancel an active watch
- **WHEN** Agent 对活跃 `watch_id` 调用 `cancel`
- **THEN** 插件终止对应本机 SSH 子进程
- **THEN** 该 watch 变为 cancelled 终态
- **THEN** 插件不因该 SSH 退出而 steer `close`

#### Scenario: Cancel a terminal or unknown watch
- **WHEN** Agent取消不存在或已经终止的 `watch_id`
- **THEN** 工具返回明确的不可取消结果
- **THEN** 系统不修改其他 watch

### Requirement: List behavior
`list` action SHALL 只查询当前 Pi session 的持久化 watch 状态，不连接远程主机。默认结果 SHALL 包含最近更新的 20 个活跃 watch和终态时间最晚的 5 个终态 watch，并 SHALL 允许 Agent 覆盖两个数量。

#### Scenario: List with defaults
- **WHEN** Agent 不提供数量覆盖调用 `list`
- **THEN** 工具最多返回 20 个活跃摘要
- **THEN** 工具最多返回 5 个终态摘要
- **THEN** 结果按最近更新时间倒序

#### Scenario: List with custom counts
- **WHEN** Agent 提供活跃和终态数量覆盖
- **THEN** 工具按请求数量返回摘要
- **THEN** 工具遵守 Pi 工具输出截断限制

### Requirement: Session persistence and restoration
插件 SHALL 通过 Pi custom entries 持久化 started、finish、interrupt、close 和 cancelled 生命周期。session reload、Pi 重启后恢复同一 session 或重新进入原 session 时，系统 SHALL 重启最后状态仍为 started 的 Watcher。主动 session shutdown SHALL NOT 生成 `close`。

#### Scenario: Reload an active session
- **WHEN** `/reload` 主动关闭包含活跃 watch 的插件实例
- **THEN** 旧实例关闭 SSH 时不发送 `close`
- **THEN** 新实例从 session entries 重建活跃 watch
- **THEN** 新实例重新启动对应 SSH Watcher

#### Scenario: Resume a session with active watches
- **WHEN** 用户恢复一个包含未终止 watch 的历史 session
- **THEN** 插件读取保存的连接、PID、元数据、间隔和超时配置
- **THEN** 插件尝试从远程状态文件恢复 Watcher

#### Scenario: Terminal watch is not restored
- **WHEN** session entries 显示某个 watch 已 finish、interrupt、close 或 cancelled
- **THEN** 插件不重新启动该 Watcher

### Requirement: No automatic retry or fallback
SSH 或 Watcher 意外退出后，系统 SHALL 立即产生相应终态，且 SHALL NOT 自动重试。系统 SHALL NOT 补发事件、建立反向隧道、启动 HTTP listener、使用 token、切换到事件文件传输或降级监控方式。

#### Scenario: SSH connection drops
- **WHEN** 活跃 Watcher的 SSH 连接意外退出且没有合法远程终态
- **THEN** 插件立即产生 `close`
- **THEN** 插件不重新连接或重启 Watcher

### Requirement: Supported platforms
第一版 SHALL 支持 Linux 或 WSL 本机，并 SHALL 要求远程 Linux 主机提供 Python 3 和所需 `/proc` 接口。系统 SHALL 明确不支持 Windows 原生本机、非 Linux 远程主机和无法对齐 PID namespace 的容器场景。

#### Scenario: Unsupported remote platform
- **WHEN** 远程主机不提供 Python 3 或所需 Linux `/proc` 接口
- **THEN** `watch` 启动失败或产生 `interrupt`
- **THEN** 系统不尝试其他监控实现
