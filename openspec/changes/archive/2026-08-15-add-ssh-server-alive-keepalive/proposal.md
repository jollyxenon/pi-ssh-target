## Why

校园 VPN 等弱网场景下，SSH 连接断连通常表现为 TCP 半开（无 RST/FIN），本地 ssh 客户端默认不发送应用层保活（`ServerAliveInterval=0`），导致 ssh 进程长时间挂起、远程 Watcher 输出送不回来，pi-ssh-target 收不到任何终态事件，断连后完全静默不通报。需要默认启用连接保活，让断连在约 90 秒内被检测并触发 `close` 通报。

## What Changes

- `start` 和 `watch` 启动 SSH 子进程时，默认注入 `-o ServerAliveInterval=30 -o ServerAliveCountMax=3`，使 SSH 客户端每 30 秒经现有加密通道发送应用层保活，连续 3 次无响应（约 90 秒）后客户端主动退出。
- 默认参数放在用户 `ssh_args[]` 之后、`--` 之前；OpenSSH 对重复 `-o` 选项后者生效，因此 Agent 提供的同名选项可覆盖默认值，系统仍不限制 Agent 提供的 SSH 参数。
- ssh 客户端退出后，复用现有 `close` 合成机制（SSH 在 ready 后退出且无合法 `finish`/`interrupt`）通报 Agent。不修改远程 Watcher、协议、状态文件或终态提示词。
- README 补充默认 keepalive 行为与覆盖方式的说明。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `remote-process-monitoring`: `SSH execution model` requirement 新增默认注入 SSH keepalive 参数的行为，并明确 Agent 参数可覆盖默认值；`No automatic retry or fallback` 下的 SSH 断连场景因保活而更快到达 `close`，行为语义不变。

## Impact

- `src/ssh-watch-manager.ts`：spawn 的 SSH argv 构造逻辑（`startInternal` 中 `args` 组装）。
- `README.md`：补充默认 keepalive 注入与覆盖说明。
- 测试：`tests/` 中断言 SSH argv 的用例（单元、集成、本地 e2e）需要同步预期参数；新增 keepalive 注入与覆盖的测试。
- 运行中的旧 watch 不受影响（保活只在新建 SSH 子进程时生效）；升级后新建立的 watch 生效。
