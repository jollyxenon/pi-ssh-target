## Context

现状是单一 `pi_ssh_target` 工具，用 `action` 枚举（`watch`/`start`/`cancel`/`list`）分发到四个操作。所有参数放在一个宽泛 union schema 中且全部 Optional，必填性依赖运行时校验（`requireWatchFields`/`requireStartFields`）。远程 Watcher 支持两种模式：监控已运行 PID，或通过 `launchMode` 远程启动新任务。详见 proposal.md。

## Goals / Non-Goals

**Goals:**
- 三个独立工具，各自 schema 用 `Required` 精确表达必填字段。
- 移除工具侧的远程启动能力，启动职责回归 Agent 的 SSH 调用。
- 每个工具携带聚焦的 snippet / description / guidelines，字段说明写入 description 与字段级 schema。

**Non-Goals:**
- 不新增或改动审计（background-watch-audit）行为——它本来就识别 bash 里的 SSH 启动命令，与新流程天然兼容。
- 不引入工具激活策略（如按需 `setActiveTools`），三个工具保持默认激活。
- 不改远程 `/proc` 监控协议与状态文件格式。

## Decisions

### 1. 拆成三个工具，而非四个
`start` 直接移除而不是保留为独立工具。理由：启动本质是"执行远程命令"，Agent 的 SSH 能力已覆盖；工具只保留监控闭环（watch/cancel/list），schema 从 20+ 字段收缩到最少，参数混淆问题（如 `args` 被误认为 SSH 参数）从根上消失。替代方案（保留 4 个工具）被否决：启动参数依然需要一整套 schema，混淆源仍在。

### 2. 命名差异化避免相似混淆
四个相似前缀名（`pi_ssh_target_watch` 等）会增加模型选错工具的概率，因此使用 `pi_ssh_watch` / `pi_ssh_cancel` / `pi_ssh_list`，动词直接跟在 `pi_ssh_` 后。

### 3. 提示词分层
- `promptSnippet`：一行"何时用"（Available tools 索引）。
- `description`：按工具写必填字段 + 每个可选字段填什么（含限制值），模型构造参数时可见。
- `promptGuidelines`：watch 上挂 4 条（工具原理 / 三种返回状态语义 / 无需持续盯守 / ssh 启动拿 PID 的流程）；cancel/list 各 1 条。

### 4. 彻底删除启动代码，不保留内部能力
`watcher.py` 的 `launch()`、`ssh-watch-manager.ts` 的 `startLaunch`/`launchMode`、`started_unwatched` 状态、`buildStartedUnwatchedPrompt` 全部删除，而不是"工具不暴露但内部保留"。遵循"不保留向后兼容"与"最简单实现"原则。

### 5. 审计模块不动
`audit.ts` 的候选提取针对 bash 的 SSH 命令（`nohup ... & echo PID=$!`），与工具 action 无关；`recordCoverage` 改为按 `pi_ssh_watch` 工具名记录覆盖即可。

## Risks / Trade-offs

- [Agent 忘记拿 PID] → guidelines 第 4 条显式给出 `ssh host 'nohup cmd > /tmp/out.log 2>&1 & echo $!'` 流程；审计模块仍会从 bash 证据中兜底提取 host/PID。
- [旧会话恢复含 `started_unwatched` 记录] → `isLifecycleRecord` 不再接受该 kind，旧记录被跳过、不崩溃；该状态本就是故障态，丢失可接受。
- [工具数量从 1 增至 3，系统提示占用略增] → 三个工具 schema 总量小于原宽 union schema 加启动字段，净占用下降。
- [README/测试大规模改动] → 一次性完成，测试从 58 调整到 52（删除启动路径用例，watch 路径覆盖不变）。

## Migration Plan

- 代码与测试同步完成；`dist/` 重新构建。
- 无数据迁移：session 生命周期记录按 `watch_id` 组织，与工具形态无关。
- 回滚：git revert 即可，旧版 `pi_ssh_target` 工具注册代码保留在历史提交中。

## Open Questions

无。
