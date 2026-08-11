## Purpose

本 delta 为 `remote-process-monitoring` 增加基于密码的 SSH 认证支持。

## MODIFIED Requirements

### Requirement: Watch input contract
`watch` action SHALL 要求 `host` 和 `pid`。系统 SHALL 接受可选 `description`、`ssh_args[]`、`password`、`interval_seconds`、`startup_timeout_seconds`、`result_paths`、`log_paths` 和 `note`。默认扫描间隔 SHALL 为 5 秒，默认启动超时 SHALL 为 10 秒。

#### Scenario: Register a watch with defaults
- **WHEN** Agent 使用合法的 `host` 和活动 PID 调用 `watch`
- **THEN** 系统为该调用生成唯一 `watch_id`
- **THEN** 系统使用 5 秒扫描间隔和 10 秒启动超时
- **THEN** 工具在远程 Watcher ready 后返回，不等待目标进程树结束

#### Scenario: Allow duplicate registrations
- **WHEN** Agent 对相同 `host` 和 PID 重复调用 `watch`
- **THEN** 系统为每次调用生成不同 `watch_id`
- **THEN** 系统分别启动和管理这些 Watcher

#### Scenario: Register a watch with password auth
- **WHEN** Agent 调用 `watch` 并提供 `host`、活动 PID 和 `password`
- **THEN** 系统使用该密码通过 SSH 认证并启动远程 Python Watcher
- **THEN** 工具在远程 Watcher ready 后返回

### Requirement: Metadata limits
系统 SHALL 限制注入上下文的 watch 元数据：`description` 和 `note` 最多 2000 字符，`password` 最多 512 字符且不允许为空，`result_paths` 和 `log_paths` 各最多 20 项，每项最多 1000 字符。SSH stderr SHALL 仅保留尾部最多 2000 字节。

#### Scenario: Reject oversized metadata
- **WHEN** `watch` 输入超过任一元数据限制
- **THEN** 工具返回参数错误
- **THEN** 系统不启动 SSH 或远程 Watcher

#### Scenario: Reject oversized or empty password
- **WHEN** `password` 超过 512 字符或为空字符串
- **THEN** 工具返回参数错误
- **THEN** 系统不启动 SSH 或远程 Watcher

### Requirement: SSH execution model
每个 watch SHALL 使用独立、非阻塞的本机 SSH 子进程运行远程 Python Watcher。系统 SHALL 将 `ssh_args[]` 作为独立 argv 放在 destination 之前，将 `host` 作为 SSH destination，并 SHALL NOT 通过本地 shell 拼接连接命令。系统 SHALL NOT 限制 Agent 提供的 SSH 参数。

系统 SHALL 支持密码认证：当提供 `password` 时，SHALL 通过 OpenSSH `SSH_ASKPASS` 与 `SSH_ASKPASS_REQUIRE=force` 机制为非交互 SSH 子进程提供密码，密码 SHALL NOT 出现在进程 argv 中。密码 SHALL 通过一次性临时 askpass 脚本和子进程环境传递；askpass 脚本 SHALL 以仅当前用户可读写的权限创建，并在 SSH 子进程结束后立即删除。

#### Scenario: Use custom SSH parameters
- **WHEN** Agent 提供端口、密钥、ProxyJump 或 `-o` 等 `ssh_args[]`
- **THEN** 系统按给定顺序把这些参数传给 `ssh`
- **THEN** 系统通过该连接启动远程 Python Watcher

#### Scenario: Authenticate with a password
- **WHEN** Agent 提供 `password` 且服务器只接受密码认证
- **THEN** 系统把 askpass 脚本路径和密码注入 SSH 子进程环境并强制使用 askpass
- **THEN** 系统启动远程 Python Watcher，密码不出现在命令行参数中

#### Scenario: Password-required connection without password
- **WHEN** 服务器只接受密码认证但 Agent 未提供 `password`
- **THEN** 工具在启动超时内无法完成认证，返回启动失败，且不把该 watch 记录为活跃

#### Scenario: Askpass script cleanup
- **WHEN** 带 `password` 的 SSH 子进程以任何方式结束
- **THEN** 系统删除临时 askpass 脚本，不在磁盘保留密码内容

#### Scenario: SSH startup times out
- **WHEN** SSH 未在 `startup_timeout_seconds` 内产生合法 ready 协议事件
- **THEN** 工具终止本机 SSH 子进程
- **THEN** 工具返回启动失败
- **THEN** 系统不把该 watch 记录为活跃
