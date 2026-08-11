## Context

动机见 proposal.md。当前 `SshWatchManager.startInternal` 直接 `spawn("ssh", args)`，stdio 全部为 pipe、无 tty；对只开放密码认证的服务器（gpuhome 等租用平台），ssh 无法提示输入密码，认证卡死直至 `startup_timeout_seconds` 超时。本机 OpenSSH 10.2p1（>= 8.4）。

## Goals / Non-Goals

**Goals:**
- 让 `watch` / `start` 通过可选 `password` 参数完成非交互密码认证
- 密码不出现在进程 argv（防 ps 泄露）
- 明文密码不落盘（临时 askpass 脚本不包含密码内容）
- 无新增外部运行时依赖

**Non-Goals:**
- 不实现交互式密码提示（仍要求工具调用时提供 password）
- 不把密码用于审计自动补建的 Watcher（Judge 重建时仍走密钥/config）
- 不支持密码文件的持久化存储方案（如 sshpass 文件模式）

## Decisions

### 用 SSH_ASKPASS + SSH_ASKPASS_REQUIRE=force 提供密码，而非 sshpass 包装
- 理由：OpenSSH 8.4+ 原生支持 `SSH_ASKPASS_REQUIRE=force`，无 tty 也会强制调用 askpass 程序；本机 10.2p1 满足。sshpass 是第三方二进制，用户机器未必安装，且 `-p` 模式密码进 argv。
- 备选：sshpass `-e`（密码进 env）——仍依赖外部二进制；Node pty（`node-pty`）——新增重依赖。

### 临时 askpass 脚本只读环境变量，明文密码不写入脚本
- 生成一次性脚本（`tmpdir()/pi-ssh-target-askpass-<uuid>`，mode 0700），内容为 `printf '%s\n' "$SSH_TARGET_PASSWORD"`；密码通过 spawn `env` 的 `SSH_TARGET_PASSWORD` 传入。askpass 脚本继承 ssh 子进程环境，读变量输出密码。
- 理由：脚本不含密码明文，即使脚本残留也不泄露；`env` 只对同用户可见，与 SSH 标准 askpass 行为一致。
- 备选：把密码直接写进脚本（JSON 转义）——脚本残留即泄露，弃用。

### 临时脚本在 SSH 子进程 close/error 时删除
- 在 `child.on("close")` 与 `child.on("error")` 两个回调中统一 `rmSync(askpassPath, { force: true })`。cancel/closeAll/超时路径都经由 kill → close，天然覆盖。
- 用 `randomUUID()` 生成文件名避免多 watch 冲突。

### 密码随 WatchConfig 持久化并参与 resume
- `normalizeWatchConfig` 透传 password；`persist` 把 config（含 password）写入会话记录，`restoreStarted` resume 时沿用。`stripLaunchFields` 不移除 password。
- 理由：会话恢复必须能重连。与 `ssh_args` 同等对待：仅存本机 Pi 会话，README 说明。
- 注：`startInternal` 构造的 remoteConfig 不包含 password，密码不会随 Watcher 协议发往远程。

### 校验与 schema
- `password?: string` 加入 `WatchMetadataInput` / `WatchConfig` / 工具 `ToolParameters`；校验非空、≤ 512 字符（`MAX_PASSWORD_LENGTH`）。
- audit 流程构建的 WatchInput 不含 password，白名单校验不受影响。

## Risks / Trade-offs

- [SSH_ASKPASS_REQUIRE 需要 OpenSSH >= 8.4] → 本机 10.2 满足；启动失败会带出 ssh stderr 尾部诊断，可定位。
- [密码存于会话记录，恢复时沿用] → 与 ssh_args 同级风险，README 明示；askpass 脚本不含明文，磁盘无密码残留。
- [测试用 fake ssh 无法从 remoteConfig 感知密码（协议不传 password）] → fixture 改为检测 spawn 环境变量并上报，端到端验证注入与清理。

## Migration Plan

- 纯增量：新增可选参数，默认行为（无 password）不变，不影响既有密钥登录用户。
- 发布后旧会话恢复逻辑不变（password 缺失时走原认证路径）。

## Open Questions

无。
