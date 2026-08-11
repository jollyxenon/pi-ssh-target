## Why

大量租用 GPU/云服务器（如 gpuhome）只提供 root 密码认证，不开放密钥配置；当前 pi-ssh-target 的 spawn("ssh") 非交互连接在无 tty 下无法提示密码，导致这类服务器连接卡死直到启动超时。需要让工具直接支持密码认证。

## What Changes

- `pi_ssh_target` 的 `watch` 与 `start` action 增加可选 `password` 参数。
- 存在 `password` 时，插件通过 OpenSSH `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` 机制为非交互 spawn 提供密码，不引入外部依赖（sshpass 等），密码不进入命令行 argv。
- 密码通过一次性临时 askpass 脚本传入 ssh 进程环境；脚本以 0600 权限创建、ssh 子进程结束后立即删除，明文密码不落盘。
- `WatchConfig` 持久化 `password`，会话恢复（resume）时沿用密码重连。
- 校验：`password` 可选、必须非空、最长 512 字符。
- 更新 README 认证前提与安全注意事项。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `remote-process-monitoring`：`Watch input contract` 与 `Metadata limits` 增加 `password` 可选参数及长度限制；`SSH execution model` 移除"SHALL NOT 实现插件内密码交互"，改为要求通过 SSH_ASKPASS 机制支持密码认证并保证密码不进 argv、临时 askpass 脚本用完即删。
- `automatic-watch-management`：`start action 使用结构化启动参数` 的可接受参数列表增加 `password`。

## Impact

- 代码：`src/types.ts`（输入/配置类型）、`src/constants.ts`（校验与长度常量）、`src/index.ts`（工具参数 schema）、`src/ssh-watch-manager.ts`（askpass 环境注入与临时文件生命周期）、`src/session-state.ts`（形状校验不受影响）。
- 文档：`README.md` 认证前提、参数表、安全说明。
- 测试：`tests/unit/contracts.test.ts` 增加 password 校验；`tests/integration/ssh-watch-manager.test.ts` 增加 askpass 注入与临时文件清理验证；`tests/fixtures/ssh` 增加 env 上报能力。
- 依赖：无新增运行时依赖，要求 OpenSSH >= 8.4（本机 10.2）。
