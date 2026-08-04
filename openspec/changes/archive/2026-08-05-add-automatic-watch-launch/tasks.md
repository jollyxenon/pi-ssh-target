## 1. 协议与共享类型

- [x] 1.1 扩展工具输入、配置、结果和生命周期类型，加入 `start` action、launch 字段及三态结果
- [x] 1.2 扩展远程 JSONL 协议，加入 `launched` 事件和带 launch 元数据的 ready/error 处理
- [x] 1.3 增加 start 输入校验，包括 command、args、cwd、env、日志路径和元数据边界

## 2. 远程启动与监控

- [x] 2.1 扩展 Python Watcher，以 argv、cwd、env 和 `shell=False` 启动非交互进程并取得根 PID
- [x] 2.2 实现新 session、stdin 分离、stdout/stderr 重定向及默认状态目录日志路径
- [x] 2.3 实现日志目录与文件权限、指定路径错误和 launch_failed 协议事件
- [x] 2.4 在进程启动后立即记录稳定身份并复用现有进程树扫描、状态文件和终态逻辑
- [x] 2.5 增加 Python 单元测试，覆盖参数边界、默认/自定义日志、进程存活和启动失败

## 3. TypeScript start action

- [x] 3.1 扩展 SshWatchManager，跟踪 launched 与 ready 阶段并暴露部分成功信息
- [x] 3.2 注册 `start` action，生成 watch ID、规范化配置并返回三态结构化结果
- [x] 3.3 实现 started_and_watched 生命周期持久化、列表显示和 session 恢复兼容
- [x] 3.4 实现 started_unwatched：保留任务、持久化部分成功、返回 host/PID/日志和监控错误
- [x] 3.5 对 started_unwatched 发送补建 Watcher 消息，明确禁止重新启动同一任务
- [x] 3.6 增加 start action 集成测试和本机进程树端到端测试

## 4. Agent run 初筛

- [x] 4.1 实现 agent_start 到 agent_settled 的有界工具调用 accumulator
- [x] 4.2 实现远程长任务候选规则，识别正式 `nohup`、detached tmux/screen、setsid、后台 shell 和 PID 证据
- [x] 4.3 排除明确未启动任务的失败调用、明显只读命令、本机任务及已有匹配 Watcher 的候选
- [x] 4.4 实现稳定批次摘要、session custom entry 持久化和 reload/重放去重
- [x] 4.5 增加候选识别、截断、Watcher 覆盖和防循环单元测试

## 5. Judge LLM 与补救 Agent turn

- [x] 5.1 使用当前 ctx.model 和 model registry 鉴权建立独立短上下文 Judge 调用
- [x] 5.2 构造不可信候选 JSON 提示并解析 `yes | no | uncertain` 结构化结果
- [x] 5.3 将模型、鉴权、调用和解析错误统一降级为 uncertain
- [x] 5.4 对 yes/uncertain 发送一次防循环补救消息，对 no 保持静默
- [x] 5.5 将 Judge 决策、批次摘要和 usage 保存为有界 custom entry
- [x] 5.6 增加 Judge 成功、no、无效输出、鉴权失败和重复审计测试

## 6. 提示词与文档

- [x] 6.1 强化 `pi_ssh_target` promptSnippet/promptGuidelines，要求同一 run 登记或解释，并优先使用 start
- [x] 6.2 更新 README 的 start 参数、三态结果、默认日志、部分成功补救和非交互限制
- [x] 6.3 记录 Judge 触发流程、当前模型复用、数据截断、安全边界和 usage 统计限制

## 7. 验证

- [x] 7.1 运行 TypeScript typecheck、Python 测试、unit/integration 测试和完整 npm test
- [x] 7.2 运行 build、pack dry-run 和 OpenSpec strict validation
- [x] 7.3 审查 git diff，确认无 `nohub` 兼容、无隐式 shell、无任务自动重启或自动终止行为
