## Context

现状：`src/ssh-watch-manager.ts` 的 `startInternal` 组装 SSH argv 为 `[...config.ssh_args, "--", config.host, "python3", "-"]`。OpenSSH 默认 `ServerAliveInterval=0`（不发应用层保活），弱网断连时 TCP 半开，本地 ssh 子进程长期挂起，`child.on("close")` 不触发，插件收不到任何终态，全程静默。README 明确"不限制 `ssh_args` 内容；连接行为由调用方负责"，因此此前未注入任何连接选项。

目标：让新建的 SSH 子进程在连接失效约 90 秒内主动退出，复用现有 `close` 合成与 steer 机制通报，不改远程 Watcher、协议与状态文件。

## Goals / Non-Goals

**Goals:**

- `start` 与 `watch` 新建 SSH 子进程时默认注入 `-o ServerAliveInterval=30 -o ServerAliveCountMax=3`。
- Agent 提供的同名 `-o` 选项能覆盖默认值。
- 断连后约 90 秒收到 `close` 通报；README 说明默认行为与覆盖方式。

**Non-Goals:**

- 不新增"每 30 秒新开连接 echo"式探测（额外握手开销、探测对象是新连接而非原连接、VPN 抖动易误报）。
- 不改远程 Watcher（不加心跳协议）、不改协议前缀、不改状态文件、不改终态提示词。
- 不为旧 watch 补建保活（只对新建 SSH 子进程生效）。
- 不引入自动重连或重试（保持现有"不自动重试"语义）。

## Decisions

**D1：用 OpenSSH 内置 ServerAlive 而非自建探测。** ServerAlive 复用现有加密通道发送空保活消息（每 30 秒约几字节），探测对象就是原 watcher 连接本身；相比"每 30 秒新开连接执行 echo"没有额外握手与认证开销，不需要为密码认证场景额外管理 askpass，且是 OpenSSH 官方机制。备选方案（本地 watchdog 轮询新连接、Watcher 心跳 + 本地超时）都需要更多代码与协议改动，收益相同，不采用。

**D2：默认 `-o` 放在用户 `ssh_args[]` 之后，保证 Agent 可覆盖。** 实测确认：OpenSSH 对重复 `-o` 选项**第一个生效**（`ssh -G -o ServerAliveInterval=30 -o ServerAliveInterval=3` 结果为 30；真实连接行为也验证了这一点）。因此要让 Agent 提供的同名选项覆盖默认值，默认值必须位于用户参数之后。argv 组装为：

```ts
const args = [
  ...config.ssh_args,            // 用户参数在前，同名 -o 优先生效 → 覆盖默认值
  ...DEFAULT_SSH_KEEPALIVE_ARGS, // 默认值在后，仅当用户未提供同名选项时生效
  "--", config.host, "python3", "-",
];
```

- Agent 未提供同名 `-o` → 默认值（30 / 3）生效。
- Agent 提供 `-o ServerAliveInterval=60` → 位于默认值之前，60 生效。
- `-o` 是 `--` 前的普通选项，与 `-p`、`-i` 等可任意混排，不影响 host 与远程命令解析。
- 注：最初设计假设"重复 `-o` 后者生效"，端到端测试（111 秒超时 ≈ 默认 30/3，而非覆盖的 3/2）推翻了该假设，已按实测行为修正。

**D3：常量集中定义。** 在 `src/constants.ts` 增加 `DEFAULT_SSH_KEEPALIVE_ARGS = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"]`，`startInternal` 组装时展开插入。测试直接断言该常量与 argv 组成。

**D4：不把保活做成可配置项。** 第一版固定默认值，符合"最简单实现"；需要调整间隔时用户可用 `ssh_args` 覆盖（见 D2）。未来如有需要再引入配置。

## Risks / Trade-offs

- **覆盖语义依赖 OpenSSH 行为**：实测重复 `-o` **第一个生效**（与常见认知相反），参数顺序是正确实现的关键（默认值必须在用户参数之后）。已用单元测试锁定 argv 顺序，并用端到端断连测试验证覆盖真实生效（~9 秒超时）。
- **误判风险**：ServerAlive 连续 90 秒无响应才判死，可容忍短暂网络抖动；但若网络极端拥塞导致保活消息全部丢失，可能误报 `close`。接受该权衡：`close` 语义本就是"任务状态未知"，Agent 会自行核查。
- **保活开销**：每 30 秒一个空消息，对服务器基本无感；比系统级 TCP keepalive（默认 2 小时）及时得多。
- **旧 watch 不生效**：运行中的 watch 不会因升级自动获得保活，需重新 `start`/`watch`。README 注明。
- **askpass 兼容**：默认 `-o` 注入不影响 `SSH_ASKPASS_REQUIRE=force` 环境注入路径（两者独立）。
