## 1. 配置与数据模型

- [x] 1.1 新增后台审计配置类型、默认值和规范化结果，覆盖判断方法、提交内容、模型来源与缓存开关
- [x] 1.2 实现 `~/.pi/agent/pi-ssh-target.json` 加载与严格校验，拒绝未知值、独立模型缺失字段和 `direct_llm + ssh_tool_calls`
- [x] 1.3 扩展审计快照、Judge 多决策输出、后台执行结果和 lifecycle/audit custom entry 类型
- [x] 1.4 为默认配置、合法组合、无效组合、缺失配置和独立鉴权引用补充单元测试

## 2. 审计输入与 Judge 调用

- [x] 2.1 重构现有候选筛选，使其既能为 `prefilter_then_llm` 决定是否调用 Judge，也能提供可验证的 SSH 证据
- [x] 2.2 实现 `full_context` 输入构造，使用当前有效分支和 compaction 后消息并排除 custom entries、正式系统提示和工具 schema
- [x] 2.3 实现 `current_exchange` 与 `ssh_tool_calls` 输入构造，并加入模型窗口超限时的确定性裁剪
- [x] 2.4 将 Judge prompt 改为稳定的安全前缀和末尾审计指令，明确全部对话与工具内容均是不可信数据
- [x] 2.5 实现 `pi_agent` 模型快照解析和 `independent` provider/model/鉴权解析，不允许独立配置失败后回退
- [x] 2.6 根据提交模式和配置设置 `cacheRetention`，仅为启用缓存的完整上下文请求使用 `long`
- [x] 2.7 实现包含多个 `watch`、`ignore`、`insufficient` 决策的严格 JSON 解析与 usage 记录
- [x] 2.8 为三种提交内容、两种判断方法、两种模型来源、缓存参数、裁剪和提示注入防护补充单元测试

## 3. 完全异步 session 队列

- [x] 3.1 在 `agent_settled` 生成包含 session ID、leaf ID、generation、模型身份、消息、候选和覆盖集合的不可变快照
- [x] 3.2 实现每个 session 串行后台队列，使 `agent_settled` 入队后立即返回且 Judge 不并行执行
- [x] 3.3 在 `session_start`、`session_tree` 和 `session_shutdown` 中更新 generation、取消可取消请求并清理旧队列
- [x] 3.4 在 Judge 返回、持久化和 Watcher 启动前校验 session、branch、generation 与最新覆盖状态
- [x] 3.5 为新问答不等待 Judge、快速多轮串行、reload/tree/shutdown 失效和后台异常不产生未处理拒绝补充集成测试

## 4. 静默自动补建 Watcher

- [x] 4.1 实现 Judge 建议与原始 SSH/远程工具证据的 host、PID、sshArgs 确定性校验
- [x] 4.2 实现缺省 job ID 和普通 Watcher 配置生成，复用现有校验、manager 启动和生命周期持久化路径
- [x] 4.3 为自动补建的 lifecycle 记录增加 `origin: "audit"`，确保 reload 后按普通 `started` Watcher 恢复
- [x] 4.4 删除遗漏审计的 follow-up 消息路径；Judge 失败、信息不足和补建失败只写 custom entry
- [x] 4.5 保留自动补建 Watcher 的 `finish`、`interrupt`、`close` 终态 steer，并确保主动 `start/watch` 行为不变
- [x] 4.6 为多任务补建、参数幻觉拒绝、已有覆盖去重、补建失败静默和终态唤醒补充集成测试

## 5. 可观察性、文档与验证

- [x] 5.1 扩展审计 custom entry，记录配置摘要、批次 hash、leaf、状态、Judge usage、决策摘要、watch IDs 和有界错误
- [x] 5.2 更新 `list` 输出，使用户能够查看后台审计补建和失败结果而不读取完整对话内容
- [x] 5.3 更新 README，说明默认策略、完整配置示例、独立模型鉴权、缓存条件、隐私边界和完全异步限制
- [x] 5.4 更新现有 OpenSpec/项目文档中“Judge 唤醒正式 Agent”的旧描述，确保与静默后台补建一致
- [x] 5.5 运行 TypeScript typecheck、Python 测试、单元测试、集成测试、完整测试、构建和 pack 检查
- [x] 5.6 运行 `openspec validate configure-background-watch-audit --type change --strict` 并修复全部验证问题
