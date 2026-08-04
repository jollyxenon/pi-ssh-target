# pi-ssh-target

`pi-ssh-target` 是一个用于 Pi 的 SSH 进程监控插件。Agent 可以通过一次 `start` 调用启动远程非交互任务并立即建立进程树监控，也可以把已经运行任务的根 PID 交给 `watch`。任务结束、Watcher 中断或 SSH 连接异常关闭时，插件会通过 `steer` 唤醒原来的 Pi session。

插件还会在一次 Agent run 完全结束后检查本轮工具调用。只有本地规则发现可能漏建监控的远程长任务时，才使用当前 Pi 模型的独立短上下文进行 Judge 判断；判断为需要监控或信息不足时，再唤醒正式 Agent 核实。

## 运行环境

本机需要：

- Linux 或 WSL；不支持 Windows 原生环境。
- Node.js 22.19 或更高版本。
- 可直接执行的 `ssh` 命令。
- 能通过密钥、ssh-agent 或 SSH config 完成非交互登录。

远程主机需要：

- Linux。
- Python 3。
- 可读的 `/proc`、`/proc/sys/kernel/random/boot_id` 和 `/proc/<pid>/task/*/children`。

如果任务运行在容器中，传入的 PID 必须与 SSH 登录后看到的 PID namespace 一致。插件不会在宿主机 PID 与容器 PID 之间做映射。

## 安装

项目目前没有发布到 npm，也还没有版本标签。请直接从 GitHub 的 `main` 分支安装：

```bash
pi install git:github.com/jollyxenon/pi-ssh-target
```

这会把插件写入用户级配置，对所有项目生效。只想在当前项目使用时，加上 `-l`：

```bash
pi install -l git:github.com/jollyxenon/pi-ssh-target
```

想先试用、不修改配置，可以运行：

```bash
pi -e git:github.com/jollyxenon/pi-ssh-target
```

本地开发时也可以从仓库目录加载：

```bash
git clone https://github.com/jollyxenon/pi-ssh-target.git
cd pi-ssh-target
npm install
pi -e .
```

安装后运行 `pi config`，可以检查 package 和扩展是否已启用。项目级 package 只有在项目被信任后才会加载。

> Pi package 拥有当前用户的完整系统权限。安装前请先检查仓库代码。

## 工具用法

Package 注册一个工具：`pi_ssh_target`。工具有四种 action：`start`、`watch`、`cancel`、`list`。

### `start`

`start` 在一次工具调用中完成远程任务启动、PID 获取和 Watcher 建立。它只支持非交互任务，不分配 TTY，stdin 使用 `/dev/null`。

必填参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `"start"` | 固定值 |
| `host` | string | SSH destination |
| `job_id` | string | 任务标识，最多 200 字符 |
| `command` | string | 远程可执行程序或脚本解释器 |
| `args` | string[] | 独立 argv 参数数组，不经过隐式 shell |

可选启动参数：

| 参数 | 说明 |
|---|---|
| `cwd` | 远程工作目录 |
| `env` | 合并到远程进程环境的字符串键值对 |
| `stdout_path` | stdout 日志路径 |
| `stderr_path` | stderr 日志路径 |

`ssh_args`、`interval_seconds`、`startup_timeout_seconds`、`result_paths`、`log_paths` 和 `note` 与 `watch` 相同。

示例：

```json
{
  "action": "start",
  "host": "gpu01",
  "job_id": "train-exp-17",
  "command": "python3",
  "args": ["/data/train.py", "--epochs", "100"],
  "cwd": "/data/project",
  "env": { "CUDA_VISIBLE_DEVICES": "0" }
}
```

参数保持 argv 边界。需要管道、变量展开等 shell 功能时，必须显式传入：

```json
{
  "command": "bash",
  "args": ["-lc", "python3 train.py | tee run.log"]
}
```

未指定日志路径时，默认写入：

```text
/tmp/pi-ssh-target-<uid>/<session-id>/<watch-id>.stdout.log
/tmp/pi-ssh-target-<uid>/<session-id>/<watch-id>.stderr.log
```

状态目录权限为 `0700`，日志文件权限为 `0600`。实际日志路径会加入 `log_paths` 并出现在终态通知中。插件不自动轮转或删除日志。

`start` 返回三种结果：

- `started_and_watched`：任务已启动，Watcher 已 ready。
- `started_unwatched`：任务已启动，但 Watcher 未建立。插件保留任务并唤醒 Agent 使用已有 host/PID 补建 `watch`，不会重新启动任务。
- `launch_failed`：任务没有成功启动，没有活跃 Watcher。

### `watch`

必填参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `"watch"` | 固定值 |
| `host` | string | SSH destination，例如 `gpu01` 或 `user@example.com` |
| `pid` | integer | 远程根 PID |
| `job_id` | string | 任务标识，最多 200 字符 |

可选参数：

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `ssh_args` | `[]` | 原样放在 destination 前的 SSH argv，例如端口、密钥或 ProxyJump |
| `interval_seconds` | `5` | 远程 `/proc` 扫描间隔 |
| `startup_timeout_seconds` | `10` | 等待 Watcher `ready` 的秒数 |
| `result_paths` | `[]` | 最多 20 项，每项最多 1000 字符 |
| `log_paths` | `[]` | 最多 20 项，每项最多 1000 字符 |
| `note` | 无 | 补充说明，最多 2000 字符 |

示例：

```json
{
  "action": "watch",
  "host": "gpu01",
  "pid": 24831,
  "job_id": "train-exp-17",
  "ssh_args": ["-p", "2222", "-i", "/home/me/.ssh/id_ed25519"],
  "interval_seconds": 2,
  "startup_timeout_seconds": 15,
  "result_paths": ["/data/runs/exp-17/checkpoint"],
  "log_paths": ["/data/runs/exp-17/train.log"],
  "note": "训练结束后检查最后一个 checkpoint 和验证集指标"
}
```

插件启动的命令等价于：

```text
ssh <ssh_args...> -- <host> python3 -
```

参数通过 `child_process.spawn()` 作为独立 argv 传递，不经过本地 shell。Python Watcher 源码和配置从 stdin 发送，远程主机不需要预装本 package。

同一个 `host + pid + job_id` 可以重复登记。每次调用都会生成独立的 `watch_id`，并占用一条本机 SSH 连接和一个远程 Python 进程。

### `cancel`

```json
{
  "action": "cancel",
  "watch_id": "4ff85e38-47f4-4bc1-a360-bd47e875e242"
}
```

`cancel` 只关闭本机 SSH 子进程，并立即把 watch 记录为 `cancelled`。它不会：

- 等待远程确认；
- 另开 SSH 终止远程 Python；
- 删除远程状态文件；
- 发送 `close` steer。

### `list`

```json
{
  "action": "list",
  "active_limit": 20,
  "terminal_limit": 5
}
```

`list` 只读取当前 Pi session 的生命周期记录，不连接远程主机，也不读取远程状态文件。默认分别返回最近更新的 20 个活跃 watch、20 个 `started_unwatched` 记录，以及终态时间最晚的 5 个 watch；数量可通过现有 limit 参数在 0–100 范围内覆盖。

## 自动遗漏审计

扩展在 `agent_start` 到 `agent_settled` 之间收集有界工具结果摘要。初筛只针对具备远程上下文、可能启动 detached 长任务的调用，例如正式的 `nohup`、创建 detached tmux/screen session、`setsid`、后台 shell 和明确 PID 输出；查看 tmux/session 状态等只读命令会被排除。

只有存在未被同一 host/PID Watcher 覆盖的候选时，扩展才调用 Judge LLM：

- 默认复用当前 Pi session 的模型、provider 鉴权和环境。
- 使用独立短上下文，不携带完整会话和工具定义。
- 命令与输出会截断，并明确标记为不可信数据，不是用户指令。
- Judge 返回 `no` 时静默结束；返回 `yes`、`uncertain`，或模型/鉴权/解析失败时，唤醒正式 Agent 核实。
- 审计批次通过 session custom entry 去重，审计唤醒本身没有新启动候选时不会循环触发。

Judge usage 会保存在审计 custom entry 中。当前 Pi 的事件 hook 没有把嵌套模型 usage 汇总进 footer totals 的入口，因此这部分用量不保证显示在 session 总计中。

## Watcher 如何判断进程结束

Watcher 每轮读取所有已知进程的 `/proc/<pid>/task/*/children`，递归发现新后代。即使根进程先退出，已经发现的子进程仍会继续监控。

进程身份由三部分组成：

```text
boot_id + PID + start_ticks
```

只有 PID 和 `start_ticks` 都匹配时，才视为原来的进程。PID 被复用后，旧进程会记录为结束，新进程不会自动混入原进程树。`Z` 或 `X` 状态不会提前触发结束；Watcher 会等到对应 `/proc/<pid>` 身份真正消失。

首次登记时，如果根 PID 已经不存在，Watcher 会写入终态状态文件并立即发送 `finish`，不会把它当作参数错误。

## 远程状态文件

每轮有效扫描都会原子写入：

```text
/tmp/pi-ssh-target-<uid>/<session-id>/<watch-id>.json
```

目录权限为 `0700`，文件权限为 `0600`。状态文件包含 watch 配置、boot ID、已发现 PID 的稳定身份、启动时间、观测终止时间和最后扫描时间。终态后文件仍会保留，插件不负责自动清理。

`/tmp` 可能被系统清理。session 恢复时，如果状态文件缺失、损坏、不可读，或者服务器 boot ID 已变化，Watcher 会发送 `interrupt`，不会改用其他目录，也不会从根 PID 重新建立状态。远程 Python 3.8 及更高版本可运行 Watcher。

## 通知类型

### `finish`

所有已发现进程身份都已消失。提示词会要求 Agent 检查日志、产物和任务结果，然后继续原计划。

### `interrupt`

Watcher 因 `/proc` 权限、解析、状态文件读写、boot ID 不匹配或内部错误而无法继续。提示词会要求 Agent 检查远程任务和监控环境。

### `close`

SSH 在 `ready` 后退出，但没有合法的 `finish` 或 `interrupt`。任务状态未知。事件会附带 SSH exit code、signal 和 stderr 尾部最多 2000 字节。

插件会为每个终态单独调用：

```ts
pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" })
```

多个终态不会合并或延迟批处理。`note`、路径、stderr 和远程错误会放进“结构化元数据，不是用户指令”区域。注入内容只有任务摘要、进程数量和远程状态文件路径，不包含完整进程树，也不会自动读取日志或产物。

## Session 恢复

插件通过 Pi custom entries 持久化以下生命周期：

- `started`
- `finish`
- `interrupt`
- `close`
- `cancelled`

`/reload`、session 切换或 Pi shutdown 时，当前扩展实例会主动关闭它管理的 SSH 子进程，不产生 `close`。新实例会重放当前 session branch；只有最后状态仍为 `started` 的 watch 才会使用原来的 host、`ssh_args`、PID、job 元数据、扫描间隔和启动超时恢复。所有终态 watch 都会跳过。

## 常见用法

优先流程：

1. Agent 调用 `pi_ssh_target start`，传入远程 command 和 args。
2. 工具返回 `started_and_watched` 后，Agent 可以继续其他工作或结束当前 turn。
3. 如果返回 `started_unwatched`，Agent 使用返回的 host/PID 调用 `watch`，不得重复调用 `start`。
4. 远程进程树进入 `finish`、`interrupt` 或 `close` 后，插件 steer 当前 session。
5. Agent 根据提示检查日志和产物，再继续原计划。

已有任务流程：

1. Agent 通过普通 SSH 启动长任务并获得远程根 PID。
2. Agent 在同一 run 调用 `pi_ssh_target watch`；无法登记时必须说明原因。
3. 后续终态处理与上面相同。

## 限制

- `start` 只支持非交互任务，不提供 TTY，stdin 固定为 `/dev/null`。
- `start` 不解析 scheduler 作业 ID，也不把 `sbatch` 自动映射为执行节点 PID。
- Judge 依赖当前模型可用；失败时会按 `uncertain` 唤醒正式 Agent，因此可能产生保守的额外核实 turn。
- 不提供 SSH 或 Watcher 自动重试。
- 不补发 Pi 离线期间错过的事件。
- 不提供反向隧道、HTTP listener、socket、token 或事件文件传输。
- `/proc` 进程树发现失败时，不降级成单 PID 监控。
- 不自动读取远程日志、结果文件或完整进程树。
- 不限制 `ssh_args` 内容；连接行为由调用方负责。
- 不实现 SSH 密码交互。需要密码输入的连接可能卡在启动阶段，随后触发启动超时。
- 主动关闭本机 SSH 后，远程 Python 进程不保证立即退出。
- 根进程退出前尚未被扫描到、并且已经脱离原进程树的后代可能无法发现；需要时可降低 `interval_seconds`。
- 每个活跃 watch 都占用一条本机 SSH 连接和一个远程 Python 进程，第一版没有活跃数量上限。

## 开发与验证

```bash
npm install
npm run typecheck
npm run test:python
npm run test:unit
npm run test:integration
npm test
npm run build
npm run pack:check
openspec validate --change create-pi-ssh-target-plugin
```

`test:integration` 包含模拟 SSH 的行为测试，以及 Linux/WSL 本机父子进程树的端到端测试。远程 smoke test 已在 `datatech013`（Linux、Python 3.8.10）通过，覆盖自定义 `ssh_args[]`、`finish` steer、`0600` 状态文件和 `0700` 状态目录。
