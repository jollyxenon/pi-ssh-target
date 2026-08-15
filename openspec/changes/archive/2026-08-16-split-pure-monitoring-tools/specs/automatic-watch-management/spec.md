## MODIFIED Requirements

### Requirement: 强制提示 Agent 登记远程长任务
系统 SHALL 在 `pi_ssh_watch` 激活时明确要求 Agent：启动预计长期运行或脱离当前 SSH 命令的远程 Linux 任务后，必须在同一 Agent run 内调用 `pi_ssh_watch` 登记 Watcher，或明确说明无法登记的原因。系统 SHALL NOT 提供 `start` action 作为登记入口。

#### Scenario: 长任务正常登记
- **WHEN** Agent 通过普通 SSH 启动远程长任务并获得稳定根 PID
- **THEN** 系统提示 Agent 在结束当前 run 前调用 `pi_ssh_watch`

#### Scenario: 无法登记
- **WHEN** Agent 无法获得稳定 PID、任务已结束或用户明确拒绝监控
- **THEN** Agent 可以不创建 Watcher，但必须向用户说明原因

## REMOVED Requirements

### Requirement: start action 使用结构化启动参数
### Requirement: start action 单次调用建立任务和 Watcher
### Requirement: 默认日志写入 Watcher 状态目录
### Requirement: Watcher 失败不得终止已启动任务
### Requirement: 启动的任务脱离 SSH 标准流
