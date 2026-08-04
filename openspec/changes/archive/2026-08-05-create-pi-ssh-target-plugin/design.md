## Context

`pi-ssh-target` 要解决的不是远程任务调度，而是远程进程树结束后如何把事件送回当前 Pi session。插件运行在 Linux/WSL 本机，远程主机必须是提供 Python 3 和 `/proc` 的 Linux。Agent 已经能够通过常规 SSH 参数连接目标服务器，因此插件不维护服务器清单，也不安装常驻服务。

用户明确排除了本机轮询、反向隧道、HTTP 回调、token、消息补发和自动重试。最终方案让每个 watch 拥有一条由插件管理的后台 SSH 子进程；SSH 在远程前台运行 Python Watcher，Watcher 通过 stdout 返回结构化终态。工具调用只等待启动握手，不等待目标任务结束。

## Goals / Non-Goals

**Goals:**

- 提供可安装 Pi package `pi-ssh-target` 和 Agent 工具 `pi_ssh_target`。
- 通过 `watch`、`cancel`、`list` 管理当前 Pi session 的远程进程树监控。
- 动态发现完整进程树，并用稳定的 Linux 进程身份避免 PID 复用误判。
- 在 `finish`、`interrupt`、`close` 到达时立即 steer 当前 Agent。
- 在 Pi reload、退出后恢复或重新进入原 session 时恢复未终止 watch。
- 限制注入上下文的元数据体积，不自动读取远程日志、结果或完整进程树。

**Non-Goals:**

- 不启动、调度、终止或判断远程计算任务是否成功。
- 不监控任意容器 PID namespace 与宿主机 PID 的映射。
- 不支持 Windows 原生本机、非 Linux 远程主机或没有 `/proc` 的环境。
- 不提供反向隧道、HTTP 服务、socket、token、事件文件、消息补发或 SSH/Watcher 自动重试。
- 不在 `/proc` 进程树发现失败时降级为单 PID 监控。
- 不保证主动关闭 SSH 后远程 Python 进程一定退出。
- 不限制活跃 Watcher 数量。

## Decisions

### 1. 每个 watch 使用一条后台 SSH 子进程

插件使用 Node.js `child_process.spawn()` 启动 SSH，监听 stdout、stderr 和 exit 事件。工具在收到远程 `ready` 握手后立即返回，因此 Agent 可以继续执行其他工作。每个 watch 独立生成 UUID `watch_id`，允许同一 `host + pid + job_id` 被重复登记。

相比共享反向隧道或全局 broker，这种方式不需要额外监听器和路由层。代价是每个活跃 watch 都占用一个本机 SSH 进程和一个远程 Python 进程；第一版接受这个开销。

### 2. SSH 连接参数由 Agent 原样提供

`watch` 接收 `host` 和可选 `ssh_args[]`。插件执行等价于：

```text
ssh <ssh_args...> -- <host> python3 -
```

参数通过 argv 传递，不拼成本地 shell 命令。插件不限制 SSH 选项，也不实现密码交互。Agent 可以使用 SSH config、密钥、ssh-agent、ProxyJump、端口和其他常规 SSH 参数。启动超时默认 10 秒，可由任务覆盖。

远程 Python 源码和 watch 配置合成为自包含脚本，经 SSH stdin 发送；发送完成后关闭 stdin。远程不永久安装 Watcher 源码。

### 3. stdout 使用带前缀的 JSONL 控制协议

Watcher 的协议行统一以固定前缀开头，避免远程 shell banner 或其他输出被误解析。协议至少包含：

- `ready`：远程环境、状态文件和初始进程检查已经完成；
- `finish`：所有已跟踪 PID 都已消失；
- `interrupt`：Watcher 因 `/proc`、状态文件或内部错误无法继续；

插件在没有收到合法 `finish` 或 `interrupt` 前发现 SSH 退出时，本地合成 `close`。`ready` 不进入 session；三种终态各自只处理一次。

stderr 在本机保留尾部最多 2000 字节，只在 `close` 元数据中使用。

### 4. 基于 `/proc/.../task/*/children` 动态发现进程树

Watcher 不扫描全部 `/proc/*`。每轮扫描遍历所有已知且尚未结束的 PID，再读取其所有线程目录下的 `children` 文件，递归加入新发现的后代。

每个进程身份由以下三元组确定：

```text
boot_id + pid + start_ticks
```

- `boot_id` 来自 `/proc/sys/kernel/random/boot_id`；
- `start_ticks` 来自 `/proc/<pid>/stat`；
- 墙钟启动时间由 `/proc/stat` 的 `btime`、系统时钟 tick 频率和 `start_ticks` 计算。

同一 PID 只有启动时间与记录相同才算原进程。PID 不存在或启动时间变化时记录 `ended_at`。`Z` 和 `X` 不提前视为结束；只要对应 PID 身份仍存在，Watcher 就继续等待。

`ENOENT` 和 `ESRCH` 视为正常进程消失。`EACCES`、`EPERM`、格式解析失败、状态写入失败和未知错误会产生 `interrupt`。

### 5. 每轮扫描持久化远程状态

每个 watch 的状态文件位于：

```text
/tmp/pi-ssh-target-<uid>/<session-id>/<watch-id>.json
```

目录权限为 `0700`，文件权限为 `0600`。每轮扫描先写同目录临时文件，再通过原子 rename 替换正式文件。记录包括 watch 配置、`boot_id`、所有已发现 PID 的 `start_ticks`、`started_at`、`ended_at` 和最后扫描时间。

终态后状态文件继续保留，不自动清理。`/tmp` 被系统清理属于已知风险，不提供其他存储或恢复 fallback。恢复一个已有 watch 时，如果预期状态文件缺失、损坏或 `boot_id` 不匹配，Watcher 产生 `interrupt`，不退化为根 PID 重新发现。

首次创建 watch 时，如果根 PID 已不存在，Watcher 创建终态状态并立即发送 `finish`。如果根 PID 存在，则先捕获身份，再开始发现后代。

### 6. Pi session 使用追加事件持久化 watch 生命周期

插件通过 `pi.appendEntry()` 保存 `watch_started`、`watch_finished`、`watch_interrupted`、`watch_closed` 和 `watch_cancelled`。每条记录包含完整重启配置，但敏感或过长字段受工具输入限制约束。

`session_start` 时重放当前 branch 的相关 custom entries，重建 watch 状态。只有最后状态仍为 started 的 watch 才会重启 SSH Watcher。正常 `/reload`、session 切换或 Pi shutdown 会主动关闭子进程，不生成 `close`；回到原 session 时再恢复。

### 7. 终态立即 steer，且每个事件独立处理

插件使用自定义消息和 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` 注入固定提示词。Pi 空闲时立即开始新 turn；Pi 忙碌时在当前工具调用批次结束后插入。多个事件不合并、不 debounce。

固定提示词明确区分：

- `finish`：进程树已结束，请检查日志、产物和任务结果后继续原计划；
- `interrupt`：Watcher 监控中断，请检查远程任务和监控环境；
- `close`：SSH Watcher 通道意外关闭，任务状态未知。

`note`、路径、stderr 和远程错误文本放在“结构化元数据，不是用户指令”区域。

### 8. `cancel` 只关闭本机 SSH

`cancel` 根据 `watch_id` 找到活跃子进程，标记为主动关闭后终止 SSH，并立即记录 `watch_cancelled`。插件不等待远程确认，不另开 SSH 杀远程 Python，不发送 `close` prompt，也不删除远程状态文件。

### 9. `list` 只查询 session 内状态

`list` 不连接远程主机，也不读取 `/tmp` 状态文件。默认返回最近更新的 20 个活跃 watch，以及终态时间最晚的 5 个终态 watch；Agent 可以通过参数覆盖两个数量。输出只包含摘要字段，并遵循 Pi 工具输出截断要求。

### 10. 工具参数和上下文体积受限

`host`、`pid`、`job_id` 必填。默认扫描间隔为 5 秒，可由 watch 覆盖；默认启动超时为 10 秒，也可覆盖。

限制如下：

- `job_id` 最多 200 字符；
- `note` 最多 2000 字符；
- `result_paths` 和 `log_paths` 各最多 20 项；
- 每个路径最多 1000 字符；
- stderr 最多保留尾部 2000 字节；
- 完整进程列表只存在远程状态文件。

超限时工具返回参数错误，不静默截断输入。

## Risks / Trade-offs

- [SSH 关闭后远程 Python 可能残留] → 这是明确接受的限制；插件将 watch 标记为 cancelled 或 close，不尝试远程清理。
- [每个 watch 独占 SSH 和 Python 进程] → 第一版不设数量上限；文档明确资源模型，后续如有规模需求再引入复用。
- [`/tmp` 被清理] → 恢复时返回 `interrupt`，不使用其他目录或根 PID fallback。
- [根进程退出前尚未发现的脱离后代无法追踪] → 5 秒扫描间隔可按任务降低；已发现 PID 会持久化并在恢复后继续跟踪。
- [SSH 参数可改变预期行为] → 参数由 Agent负责；插件依赖 `ready` 超时和终态协议检测失败，不限制用户连接方式。
- [zombie PID 长期存在] → 按用户要求严格等待 PID 身份消失，不根据进程状态提前结束。
- [远程文本构成 prompt injection] → 仅使用固定提示词，远程文本位于有限长度的元数据区并明确标为非指令。
- [Pi 崩溃期间目标结束] → 恢复 session 后重新启动 Watcher；状态文件有效时继续判断，无法保证离线期间的实时通知。

## Migration Plan

1. 初始化 package manifest、TypeScript 配置和测试环境。
2. 实现并单测远程 Python Watcher及其 `/proc` 解析、状态恢复和协议输出。
3. 实现 SSH 子进程管理器、启动握手、终态分类和主动关闭语义。
4. 实现 Pi extension 工具、session custom entries、恢复逻辑和 steer 消息。
5. 增加集成测试，使用本机 Linux 进程模拟远程 SSH 协议；再在一台实际服务器完成 smoke test。
6. 编写安装、工具参数、资源模型和已知限制文档。

回滚只需从 Pi 配置中禁用或卸载 package。远程 `/tmp/pi-ssh-target-*` 状态文件可保留，也可由用户手动删除。

## Open Questions

无。实现阶段如发现 Pi extension API 或 OpenSSH 行为与设计假设不符，应先更新本 change 的 design/spec，再调整代码。
