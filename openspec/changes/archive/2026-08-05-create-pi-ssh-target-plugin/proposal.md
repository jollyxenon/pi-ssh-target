## Why

远程算力任务结束后无法主动恢复本机 Pi Agent，导致任务完成、监控中断或 SSH 通道关闭后长期无人处理。需要一个事件驱动的 Pi package，在不占用 Agent 工具调用、不注入周期状态、不依赖反向隧道或轮询本机的前提下，持续监控远程 Linux 进程树并立即唤醒对应 Pi session。

## What Changes

- 创建可安装 Pi package `pi-ssh-target`，注册 Agent 工具 `pi_ssh_target`。
- 提供 `watch`、`cancel`、`list` 三种工具 action。
- `watch` 通过非阻塞后台 SSH 启动远程 Python Watcher；每个 watch 使用独立 SSH 通道和唯一 `watch_id`。
- Watcher 基于 Linux `/proc/<pid>/task/*/children` 动态发现并监控完整进程树，使用 `boot_id + PID + start_ticks` 校验进程身份。
- Watcher 每轮扫描将进程启动时间、观测终止时间和活动状态原子写入 `/tmp` 状态文件，并在 Pi session reload/resume 后恢复未终止 watch。
- 定义 `finish`、`interrupt`、`close` 三种终态，并通过 `steer` 独立、立即唤醒对应 Pi session。
- 仅向上下文注入有限的结构化摘要；不自动读取日志、结果文件或完整进程树。
- 不提供 SSH/Watcher 自动重试、反向隧道、HTTP 回调、token、事件补发、状态文件 fallback 或监控降级。
- 支持标准 SSH destination 与独立 `ssh_args[]` 连接参数；支持 Linux/WSL 本机与 Linux + Python 3 + `/proc` 远程环境。

## Capabilities

### New Capabilities
- `remote-process-monitoring`: 规定 Pi Agent 工具接口、远程进程树 Watcher、session 生命周期恢复、终态事件注入、取消和列表查询行为。

### Modified Capabilities

无。

## Impact

- 新增 TypeScript Pi extension/package、远程 Python Watcher 源码、package manifest、测试和使用文档。
- 运行时依赖本机 `ssh` 命令、远程 `python3` 和 Linux `/proc`。
- Pi session 将持久化 watch 生命周期记录；远程 `/tmp` 将保留每个 watch 的进程树状态文件。
- 每个活跃 watch 占用一个本机 SSH 子进程和一个远程 Python 进程。
