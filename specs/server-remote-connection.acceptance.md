# Server 直连验收记录

## 环境

当前开发仓库，Web 开发页 `http://127.0.0.1:5173`，基础 Server 为 loopback 3030，目标 Server 为 loopback 3031。目标启用测试认证及明确的可信 Web Origin。两端最终均以独立的 HOME、ZCODE_DESKTOP_HOME_DIR 和 ZCODE_DATA_BASE_DIR 启动，不使用真实账号或模型凭据。

## 实际 GUI 验收

- Web 输入框工作区菜单的连接向导仅提供 Server，不展示 SSH、Docker 或 WSL。
- 输入目标 URL 和临时测试凭据后，完成跨域握手，进入远端目录浏览器。
- 选择隔离远端目录后，侧栏及工作区选择器显示该远端工作区。
- 页面重开后保留脱敏历史，条目显示 Reconnect；点击后显示空白临时 Token 表单及不保存凭据的说明。
- 在代码停止热更新的条件下提交正确凭据，连接恢复且工作区选择器切换到远端目录。
- 取消临时凭据弹窗后保持断开状态，重新打开时 Token 字段为空。
- 提交错误凭据后连接被拒绝，历史仍保留并显示 Not connected。持久化错误为 `Server ticket request failed (401)`，不包含凭据。
- 浏览器 localStorage/sessionStorage 未发现测试凭据，IndexedDB 数据库列表为空；两个隔离 Server 的数据目录扫描均无测试凭据。历史保存真实 serverId、规范 workspaceIdentity、路径和脱敏 target，不含 tokenCredentialKey。

## 回归与仓库检查

- UI 测试目录：26 个用例通过，包括现有兼容回归，不将其全部称为新增用例。
- Desktop registry、Server HTTP/connector、配置路径、shared target、Web ticket adapter、Server Core 聚焦测试：17 个用例通过。
- 合计 43 个用例通过，无失败或跳过。
- 旧 Server 历史回归使用真实 Tab Store 和注册 session：先验证原实现会误回收保留的工作区，再验证实际 serverId 与 canonical path 升级、原 tab id/焦点保留、同路径其它 Server 不变、历史不重复且原凭据 key 不被误删。
- 组件卸载清理测试调用生产生命周期 helper，覆盖确切 pending request 取消、迟到结果失效、未绑定 session 释放、已转交 session 不释放及 StrictMode 场景。它们不是 mounted-component E2E。
- 头部 reload 的生产 helper 测试覆盖防重复时间窗和结构化错误；未以复制 UI 表达式的自证测试替代交互验收。
- freshness 检查通过：main 与 origin/main 同步。
- `pnpm typecheck` 通过。
- `pnpm lint` 通过：70 warnings、0 errors；未断言所有 warning 均为基线。
- 最终 `pnpm fmt:check` 通过。中途发现三个新增/修改文件格式问题，格式化后重新检查通过。
- `pnpm architecture:check --changed` 通过：0 violations、0 new。
- `git diff --check` 通过。

## 不能宣称已验证的边界

- 未执行 Desktop 应用层完整连接、目录选择及重连 E2E。
- 未执行头部 reload 的 mounted UI E2E，busy/read-only 门禁与原生文件管理器边界目前为源码检查，而非平台实际点击验证。
- GUI 验收未运行模型任务：隔离 Server 没有可用模型配置；日志中的 runtime unavailable 不能算任务运行验收通过。
- 未完成断网快照补洞、真实 TLS/反向代理部署、各平台原生操作和连接中快速取消的全套 GUI 场景。
- 初始仅隔离数据目录的测试曾读取真实用户设置，可能写入引导偏好；后续已停止并改为完整隔离。只读检查未发现真实设置中保存测试 Server/临时工作区，但无法无备份证明引导偏好未改变，因此没有盲目恢复真实配置。
- Claude 插件生态已有兼容能力保留；本任务没有证实必须新增的插件兼容实现，不把现有功能算成新移植。
- 外部 Agent 模式仅是展示兼容，不提供 Claude/Codex/Gemini/OpenCode 的实际执行。

## 对比审查后的缺陷修复回归

- Desktop 握手取消使用隔离子进程和真实 HTTP/WS upgrade fixture，连续三次在 CONNECTING 阶段取消：连接 Promise 拒绝、服务端观察到 socket 关闭、无 uncaughtException、未发布活跃连接关闭事件。另覆盖预先取消的 signal，不启动握手。该测试不是 Desktop GUI E2E。
- Web 历史身份不符时仅发起无 Authorization 的公开 server-info 请求，禁止申请票据；预期身份匹配时正常换票，无预期身份的首次/旧历史仍沿用既有流程。协议不符同样在发送凭据前失败。
- 本次定向回归共 42 项通过（22 项 Server/Web/shared/desktop/services，20 项 UI）；不将这些全部计为新增测试。
- 本次 `pnpm typecheck` 通过；`pnpm lint` 为 70 warnings、0 errors。本次未重新进行 GUI、真实 TLS/代理或跨平台验收。

## 清理

本任务启动的 Vite 和两个隔离 Server 已停止，3030、3031、5173 无监听。保留隔离数据和日志供核查；没有提交或推送代码。
