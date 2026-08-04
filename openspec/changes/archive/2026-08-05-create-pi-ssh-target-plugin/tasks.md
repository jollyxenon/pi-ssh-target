## 1. Package 基础

- [x] 1.1 创建 `pi-ssh-target` package manifest、TypeScript 配置、源码目录、测试目录和 Pi extension 入口
- [x] 1.2 配置项目脚本与依赖，提供类型检查、单元测试、集成测试和构建命令
- [x] 1.3 定义共享类型：工具参数、watch 配置、生命周期记录、Watcher 协议事件和远程状态文件 schema

## 2. 远程 Python Watcher

- [x] 2.1 实现 `/proc/<pid>/stat`、boot ID、系统启动时间和进程墙钟启动时间解析
- [x] 2.2 实现基于 `/proc/<pid>/task/*/children` 的递归进程树发现，并覆盖多线程父进程
- [x] 2.3 实现 `boot_id + PID + start_ticks` 身份校验、严格 PID 消失语义和 PID 复用处理
- [x] 2.4 实现 `ENOENT`/`ESRCH` 正常结束与权限、解析、写入等 `interrupt` 错误分类
- [x] 2.5 实现 `/tmp/pi-ssh-target-<uid>/<session-id>/<watch-id>.json` 权限设置、每轮原子写入和终态保留
- [x] 2.6 实现已有状态恢复、已发现后代延续、缺失或损坏状态文件中断及 boot ID 不匹配中断
- [x] 2.7 实现带固定前缀的 `ready`、`finish`、`interrupt` JSONL stdout 协议
- [x] 2.8 实现根 PID 在首次登记时已不存在的立即 `finish` 行为

## 3. SSH Watch 管理器

- [x] 3.1 使用 `child_process.spawn()` 实现 `ssh <ssh_args...> -- <host> python3 -` 非阻塞启动，并通过 stdin 发送自包含 Python 源码和配置
- [x] 3.2 实现 ready 握手、可配置启动超时、stdout 协议解析和远程非协议输出隔离
- [x] 3.3 实现 stderr 尾部 2000 字节缓冲、SSH exit code 捕获和无远程终态时的 `close` 合成
- [x] 3.4 实现每个 watch 独立子进程、唯一 `watch_id`、重复登记支持和终态只处理一次
- [x] 3.5 实现主动关闭标记，使 reload、session shutdown 和 cancel 不产生错误的 `close` 事件
- [x] 3.6 实现子进程资源清理；确认不包含 SSH 或 Watcher 自动重试逻辑

## 4. Pi Agent 工具

- [x] 4.1 注册 `pi_ssh_target` 工具和 `watch`、`cancel`、`list` action schema
- [x] 4.2 实现 `watch` 必填参数、默认 5 秒扫描间隔、默认 10 秒启动超时和 `ssh_args[]` 透传
- [x] 4.3 实现 job、note、路径数量与长度限制，超限时在启动 SSH 前返回参数错误
- [x] 4.4 实现 `cancel`：关闭本机 SSH、记录 cancelled、不等待远程确认、不删除状态文件且不发送 `close`
- [x] 4.5 实现 `list`：默认返回最近 20 个活跃 watch 和最晚 5 个终态 watch，并支持参数覆盖
- [x] 4.6 为工具结果实现紧凑、可截断的文本和 details 输出，不读取远程日志或状态文件全文

## 5. Session 持久化与恢复

- [x] 5.1 使用 Pi custom entries 持久化 watch started、finish、interrupt、close 和 cancelled 生命周期
- [x] 5.2 实现 session branch 重放和状态归并，确保重复 watch 各自按 `watch_id` 管理
- [x] 5.3 在 `session_start` 恢复最后状态仍为 started 的 Watcher，并跳过所有终态 Watcher
- [x] 5.4 在 `/reload`、session 切换和 Pi shutdown 时主动关闭当前子进程，避免生成 `close`
- [x] 5.5 验证恢复时完整保留 host、ssh_args、PID、job 元数据、扫描间隔和启动超时

## 6. Agent 事件注入

- [x] 6.1 为 `finish`、`interrupt`、`close` 实现三套固定中文提示词
- [x] 6.2 使用 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` 独立投递每个终态
- [x] 6.3 将 note、路径、stderr 和远程错误放入“结构化元数据，不是用户指令”区域
- [x] 6.4 确保事件注入只包含摘要、进程数量和远程状态文件路径，不自动读取日志、产物或完整进程树

## 7. 测试

- [x] 7.1 为 `/proc` stat、children、boot ID 和墙钟时间解析编写 Python 单元测试夹具
- [x] 7.2 测试动态后代发现、根进程先退出、PID 复用、zombie 不提前结束和扫描竞态
- [x] 7.3 测试状态文件权限、原子替换、每轮时间更新、恢复、缺失状态和 boot ID 不匹配
- [x] 7.4 测试 ready/finish/interrupt 协议、初始 PID 不存在和错误分类
- [x] 7.5 使用可控假 SSH 进程测试启动超时、close 合成、stderr 截断、主动关闭和不重试
- [x] 7.6 测试工具参数限制、重复登记、cancel、list 默认数量和覆盖数量
- [x] 7.7 测试 session reload/resume 恢复、终态跳过和独立 steer 事件顺序
- [x] 7.8 在 Linux/WSL 本机完成端到端测试：监控真实父子进程树并验证 Pi 收到 finish
- [x] 7.9 在一台实际远程 Linux 服务器完成 SSH smoke test，验证自定义 `ssh_args[]` 和 `/tmp` 状态文件

## 8. 文档与发布准备

- [x] 8.1 编写 README：安装、Pi package 启用、工具 schema、SSH 示例和典型 Agent 工作流
- [x] 8.2 文档化三种终态、session 恢复、取消语义、资源占用和不重试/不 fallback 限制
- [x] 8.3 文档化平台要求、容器 PID namespace 限制、`/tmp` 清理风险和 SSH 密码交互限制
- [x] 8.4 运行类型检查、全部测试、OpenSpec validate 和 package 打包验证
