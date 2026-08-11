## Purpose

本 delta 为 `automatic-watch-management` 的 `start` action 增加密码认证参数。

## MODIFIED Requirements

### Requirement: start action 使用结构化启动参数
`pi_ssh_target` SHALL 提供 `start` action，接受 SSH destination、`command`、`args[]`，并可接受 `description`、`cwd`、环境变量、SSH 参数、`password`、扫描间隔、启动超时、日志路径、结果路径和 note。

#### Scenario: 使用参数数组启动脚本
- **WHEN** Agent 提交 `command: "python3"` 和独立的脚本参数数组
- **THEN** 系统按 argv 边界启动远程进程，不把参数拼接为隐式 shell 命令

#### Scenario: 显式使用 shell
- **WHEN** 调用方确实需要管道、重定向或变量展开
- **THEN** 调用方必须显式使用 `command: "bash"` 及对应 `args`，系统不自动引入 shell

#### Scenario: 使用密码认证启动脚本
- **WHEN** Agent 提交 `command: "python3"`、独立脚本参数数组和 `password`
- **THEN** 系统使用该密码通过 SSH 认证，按 argv 边界启动远程进程
- **THEN** 系统返回 `started_and_watched`、根 PID、watch ID 和日志路径
