## Purpose

本 delta 为 `remote-process-monitoring` 的 `SSH execution model` 增加默认 SSH 应用层保活注入行为，使弱网（如校园 VPN）断连时 SSH 客户端能在约 90 秒内主动退出并触发 `close` 通报。

## MODIFIED Requirements

### Requirement: SSH execution model

每个 watch SHALL 使用独立、非阻塞的本机 SSH 子进程运行远程 Python Watcher。系统 SHALL 将 `ssh_args[]` 作为独立 argv 放在 destination 之前，将 `host` 作为 SSH destination，并 SHALL NOT 通过本地 shell 拼接连接命令。系统 SHALL NOT 限制 Agent 提供的 SSH 参数。

系统 SHALL 在 SSH 子进程 argv 中、用户 `ssh_args[]` 之后默认注入 `-o ServerAliveInterval=30` 与 `-o ServerAliveCountMax=3`，使 SSH 客户端每 30 秒经现有加密通道发送应用层保活消息，连续 3 次无响应（约 90 秒）后客户端主动退出。Agent 提供的同名 `-o` 选项 SHALL 覆盖默认值，OpenSSH 对重复 `-o` 选项后者生效。默认保活只作用于新建的 SSH 子进程，不修改远程 Watcher 或协议。

系统 SHALL 支持密码认证：当提供 `password` 时，SHALL 通过 OpenSSH `SSH_ASKPASS` 与 `SSH_ASKPASS_REQUIRE=force` 机制为非交互 SSH 子进程提供密码，密码 SHALL NOT 出现在进程 argv 中。密码 SHALL 通过一次性临时 askpass 脚本和子进程环境传递；askpass 脚本 SHALL 以仅当前用户可读写的权限创建，并在 SSH 子进程结束后立即删除。

#### Scenario: Use custom SSH parameters

- **WHEN** Agent 提供端口、密钥、ProxyJump 或 `-o` 等 `ssh_args[]`
- **THEN** 系统按给定顺序把这些参数传给 `ssh`
- **THEN** 系统通过该连接启动远程 Python Watcher

#### Scenario: Default keepalive options are injected

- **WHEN** 插件为 `start` 或 `watch` 启动 SSH 子进程
- **THEN** SSH argv 在用户 `ssh_args[]` 之后包含 `-o ServerAliveInterval=30` 与 `-o ServerAliveCountMax=3`
- **THEN** 连接无响应约 90 秒后 SSH 客户端主动退出，插件按无合法终态退出合成 `close`

#### Scenario: Agent overrides keepalive options

- **WHEN** Agent 在 `ssh_args[]` 中提供同名 `-o ServerAliveInterval` 或 `-o ServerAliveCountMax`
- **THEN** Agent 提供的值位于默认值之后并生效
- **THEN** 系统不拒绝或改写 Agent 提供的 SSH 参数

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
