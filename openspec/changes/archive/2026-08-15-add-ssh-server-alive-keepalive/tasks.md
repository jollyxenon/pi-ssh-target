## 1. 实现默认保活注入

- [x] 1.1 在 `src/constants.ts` 新增常量 `DEFAULT_SSH_KEEPALIVE_ARGS = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"]`，并附简短注释说明覆盖语义（默认值在前、用户 `ssh_args` 在后，OpenSSH 重复 `-o` 后者生效）
- [x] 1.2 修改 `src/ssh-watch-manager.ts` 的 `startInternal`：argv 组装为 `[...config.ssh_args, ...DEFAULT_SSH_KEEPALIVE_ARGS, "--", config.host, "python3", "-"]`（默认值在后，用户同名 `-o` 在前优先生效）
  - 端到端测试修正：最初实现（默认在前）下覆盖参数 3/2 不生效，断连 111 秒后才 close（默认 30/3 行为）；实测确认 OpenSSH 对重复 `-o` 选项**第一个生效**，修正为默认在后，覆盖参数 3/2 在断连后 8 秒触发 close
- [x] 1.3 确认密码认证（askpass 环境注入）与启动超时逻辑不受 argv 变化影响（两处代码路径独立）

## 2. 测试同步与新增

- [x] 2.1 检查 `tests/` 中所有断言 SSH argv 或 spawn 参数的用例，同步预期参数顺序（默认 `-o` 在用户 `ssh_args` 之前）：现有 fake ssh fixture 从 stdin 读配置、不直接断言 argv，无需同步
- [x] 2.2 新增单元测试：无用户同名选项时 argv 包含默认 `-o ServerAliveInterval=30` 与 `-o ServerAliveCountMax=3`（`tests/unit/ssh-watch-manager.test.ts`）
- [x] 2.3 新增单元测试：用户 `ssh_args` 提供同名 `-o ServerAliveInterval`/`-o ServerAliveCountMax` 时，用户值位于默认值之前（第一个生效、可覆盖）
- [x] 2.4 运行 `npm run test:unit`、`npm run test:integration` 与本地 e2e，确认 fake ssh fixture 行为不受影响（unit 21/21、integration 37/37 通过）

## 3. 文档

- [x] 3.1 README 的 `watch` 参数说明与“限制”章节补充：默认注入 `-o ServerAliveInterval=30 -o ServerAliveCountMax=3`，断连约 90 秒后触发 `close`；Agent 可用同名 `-o` 覆盖；只对新建 SSH 子进程生效（旧 watch 需重新登记）

## 4. 验证

- [x] 4.1 `npm run typecheck`
- [x] 4.2 `npm test`（python 11 + unit 21 + integration 37，共 58 个测试通过）
- [x] 4.3 `npm run build` 与 `npm run pack:check`
- [x] 4.4 `openspec validate --change add-ssh-server-alive-keepalive`（Change valid）
