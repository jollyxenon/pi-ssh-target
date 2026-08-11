## 1. 类型与校验

- [ ] 1.1 `src/types.ts`：`WatchMetadataInput` 与 `WatchConfig` 增加可选 `password?: string`
- [ ] 1.2 `src/constants.ts`：新增 `MAX_PASSWORD_LENGTH = 512`；`validateMetadata` 校验 password 非空且 ≤ 512；`normalizeWatchConfig` 透传 password
- [ ] 1.3 `src/index.ts`：`ToolParameters` 增加 `password` 可选参数（maxLength 512）

## 2. SSH 密码认证实现

- [ ] 2.1 `src/ssh-watch-manager.ts`：新增 askpass 工具函数（生成 0700 临时脚本、构造含 SSH_ASKPASS / SSH_ASKPASS_REQUIRE=force / SSH_TARGET_PASSWORD 的 env）
- [ ] 2.2 `startInternal` 在提供 password 时注入 env；在 child close 与 error 回调删除临时脚本；`ActiveWatch` 记录 askpass 路径

## 3. 测试

- [ ] 3.1 `tests/unit/contracts.test.ts`：password 校验（合法通过、超长拒绝、空字符串拒绝、start/watch 均透传）
- [ ] 3.2 `tests/fixtures/ssh`：增加 env 上报（FAKE_SSH_REPORT_ENV_FILE 存在时写入 SSH_ASKPASS 等环境变量）
- [ ] 3.3 `tests/integration/ssh-watch-manager.test.ts`：带 password 启动——断言 env 注入正确、askpass 脚本可执行且输出密码、进程结束后脚本被删除；无 password 时 env 不含 askpass 变量

## 4. 文档与规格

- [ ] 4.1 `README.md`：更新认证前提、参数表与安全说明
- [ ] 4.2 `openspec validate` 通过，同步 delta spec 到 `openspec/specs/`，归档 change

## 5. 验证

- [ ] 5.1 `npm run typecheck` 通过
- [ ] 5.2 `npm run test:unit` 与 `npm run test:integration` 通过
- [ ] 5.3 对 gpuhome 服务器（root@sh02-ssh.gpuhome.cc:30147）实测带密码 start/watch 全流程
