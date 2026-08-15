## MODIFIED Requirements

### Requirement: Pi package and Agent tool
系统 SHALL 以可安装 Pi package `pi-ssh-target` 提供三个 Agent 工具：`pi_ssh_watch`（监控已运行的远程进程树）、`pi_ssh_cancel`（取消监控）、`pi_ssh_list`（查看监控列表）。系统 SHALL NOT 提供 `pi_ssh_target` 单一工具或 `start` action。系统 SHALL NOT 提供用户 slash command 作为主要操作入口。

#### Scenario: Agent discovers the tool
- **WHEN** `pi-ssh-target` package 被 Pi 加载
- **THEN** Agent 可调用名为 `pi_ssh_watch`、`pi_ssh_cancel`、`pi_ssh_list` 的三个工具
- **THEN** `pi_ssh_watch` 工具 schema 以必填字段要求 `host` 和 `pid`

### Requirement: Watch input contract
`pi_ssh_watch` 工具 SHALL 要求必填字段 `host` 和 `pid`，不提供 `action` 字段。系统 SHALL 接受可选 `description`、`ssh_args[]`、`password`、`interval_seconds`、`startup_timeout_seconds`、`result_paths`、`log_paths` 和 `note`。默认扫描间隔 SHALL 为 5 秒，默认启动超时 SHALL 为 10 秒。

#### Scenario: Register a watch with defaults
- **WHEN** Agent 使用合法的 `host` 和活动 PID 调用 `pi_ssh_watch`
- **THEN** 系统为该调用生成唯一 `watch_id`
- **THEN** 系统使用 5 秒扫描间隔和 10 秒启动超时
- **THEN** 工具在远程 Watcher ready 后返回，不等待目标进程树结束

#### Scenario: Allow duplicate registrations
- **WHEN** Agent 对相同 `host` 和 PID 重复调用 `pi_ssh_watch`
- **THEN** 系统为每次调用生成不同 `watch_id`
- **THEN** 系统分别启动和管理这些 Watcher

#### Scenario: Register a watch with password auth
- **WHEN** Agent 调用 `pi_ssh_watch` 并提供 `host`、活动 PID 和 `password`
- **THEN** 系统使用该密码通过 SSH 认证并启动远程 Python Watcher
- **THEN** 工具在远程 Watcher ready 后返回

### Requirement: Cancel behavior
`pi_ssh_cancel` 工具 SHALL 要求 `watch_id`。对于活跃 watch，系统 SHALL 主动关闭本机 SSH 子进程，记录 `watch_cancelled`，不等待远程确认，不删除远程状态文件，也不发送 `close` prompt。

#### Scenario: Cancel an active watch
- **WHEN** Agent 对活跃 `watch_id` 调用 `pi_ssh_cancel`
- **THEN** 系统主动关闭本机 SSH 子进程
- **THEN** 该 watch 标记为 cancelled 状态
- **THEN** 系统不另开 SSH 或发送 steer `close`

#### Scenario: Cancel a terminal or unknown watch
- **WHEN** Agent 对不存在或已终态的 `watch_id` 调用 `pi_ssh_cancel`
- **THEN** 系统返回不改变现有状态的错误
- **THEN** 系统不创建新的 watch

### Requirement: List behavior
`pi_ssh_list` 工具 SHALL 只读取当前 Pi session 的活跃 watch 记录，不连接远程主机。可选数量 SHALL 支持最多 20 个活跃 watch 和最多 5 个终态 watch，并 SHALL 提醒 Agent 可以传更多数量。

#### Scenario: List with defaults
- **WHEN** Agent 不传数量参数调用 `pi_ssh_list`
- **THEN** 系统返回最多 20 个活跃 watch
- **THEN** 系统返回最多 5 个终态 watch
- **THEN** 输出提示可请求更多数量

#### Scenario: List with custom counts
- **WHEN** Agent 传 `active_limit` 和 `terminal_limit` 调用 `pi_ssh_list`
- **THEN** 系统按请求数量返回结果
- **THEN** 系统保持 Pi 系统提示语不变
