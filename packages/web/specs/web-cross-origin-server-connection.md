# Web 跨域独立 Server 直连规格说明

## 1. 目标与范围

本规格仅针对 Web 客户端（`packages/web`），实现在浏览器端跨域连接独立运行的 ZCode Server（`server` / `zcode-server-cli`）。
不修改 `packages/server`、`packages/shared`、`packages/desktop`，仅在 Web 端严格按照与 Server 端约定的规范对接。

## 2. Server 协议契约（与协调者对齐）

1. **短期单次票据签发（HTTP API）**：
   - 请求：`POST <serverUrl>/api/rpc-web-ticket`
   - 鉴权：`Authorization: Bearer <token>`（若 Server 启用了 Token 校验）
   - 跨域：浏览器跨域发出，Server 端按 `ZCODE_SERVER_ALLOWED_WEB_ORIGINS` 白名单校验 `Origin` 并返回 CORS 头；未在白名单中时 Fail-Closed。
   - 响应结构：`{ ticket: string; expiresAt: number }`

2. **WebSocket 握手（单次票据消费）**：
   - 路径：`GET <wsUrl>/ws?ticket=<ticket>`
   - 约束：
     - 单次消费（One-time consumed），重复消费或超时拒绝。
     - 链路模式：`web-remote-replayable`。
     - 浏览器携带对应 Origin，Server 端校验与票据生成时的一致性。

3. **服务端元信息查询（公开、不携带 Token）**：
   - 请求：`GET <serverUrl>/api/server-info`
   - 响应包含：`ServerRemoteInfo`（`serverId`, `version`, `workspaces` 等）。

4. **安全与凭据边界**：
   - 浏览器 Web 客户端**禁止**持久化长期 Token 到 `localStorage` / `IndexedDB`，也不能借当前 Server 的 RPC Credential Service 存储另一个 Server 的 Token。历史只保存脱敏目标；页面重开后需要用户再次输入认证 Token。Web 向导仅展示 `server` 目标，不能展示 Web 平台不支持的 SSH、WSL、Docker。类型集合由 `IPlatformService.remoteConnectionKinds` 唯一提供，Root 与输入框等各弹窗入口都通过同一 form hook 读取，不逐层复制平台判断。
   - URL 中的敏感查询参数（`token`）一旦发现应立即通过 `history.replaceState` 清理并拒绝消费，避免历史记录泄漏或书签保存泄漏。
   - 票据为单次短期使用，换取 WebSocket 连接后不再保留。

## 3. Web 端参数解析与引导状态机

Web 端通过可保存的 Server URL 与临时凭据输入界面指定独立远端 Server；URL 参数只能定位公开的 Server URL 与工作区：

- `server` 或 `serverUrl`：目标 Server 的 HTTP(S) 地址（例如 `https://server.example.com:3030` 或 `http://localhost:3030`）。
- 长期 Token 由用户在安全输入框临时提供，仅保留在当前内存中；不得通过 URL 参数传入。旧链接中的 `token` 参数应立即清除并拒绝使用。
- `workspace` / `workspaceIdentity`：指定的远端工作区路径或 Identity（可选，未指定时默认从 `/api/server-info` 获取首个工作区）。

### 连接流程时序：

```text
浏览器启动 (解析不含凭据的 URL / 用户在安全表单临时输入 Token)
   │
   ├── 是否为同源模式？
   │      └── 是 -> 走原有 /api/server-info 与 /ws 流程
   │
   └── 否 (存在跨域 server 参数)
          │
          ├── 1. 获取公开 server-info：GET <serverOrigin>/api/server-info (不发送 Token)
          │      ticket adapter 校验共享协议 schema；重连时先比对历史中的 expectedServerId
          │      身份不匹配立即失败，禁止发送票据请求与 Token；首次/旧历史无预期身份时沿用身份升级
          │
          ├── 2. 获取一次性票据：POST <serverOrigin>/api/rpc-web-ticket
          │      Header: Authorization: Bearer <token> (若提供)
          │      返回: { ticket }
          │
          ├── 3. 构造 WebSocket URL: <wsOrigin>/ws?ticket=<ticket>
          │      (http: -> ws:, https: -> wss:)
          │
          ├── 4. 安全清理：请求完成立即清除内存中的一次性票据与临时 Token
          │
          └── 5. 建立 WebSocket RPC 连接，挂载 UI
```

## 4. 容错与失败反馈

- **票据获取失败**（CORS 拒绝 / 401 认证失败 / 403 来源未允许 / 网络错误）：
  - 抛出结构化错误，通过 `WebBootstrapErrorScreen` 展现清晰提示（如 “Server cross-origin connection rejected: check CORS allowlist or token”）。
- **WebSocket 握手失败**（票据无效 / 握手被拒）：
  - 同样触发引导失败页面，并提供重试按钮。

## 5. 验收标准与测试

- **单元测试**：
  - URL 与协议参数解析：正确识别同源 vs 跨域 server URL，支持 http/https 到 ws/wss 的协议转换。
  - 票据申请与请求头构造：正确携带 `Authorization: Bearer <token>` 与 `Accept: application/json`。
  - 身份校验顺序：预期 serverId 与公开元信息不符、协议不兼容时，仅允许无凭据的元信息请求；不得发起票据请求。身份匹配与未提供预期身份（首次/旧历史）时正常连接。
  - Token 安全边界：拒绝从 URL 接收长期 Token；输入的凭据不写入浏览器持久存储，旧链接的 token 参数立即移除。
  - 异常分支覆盖：HTTP 错误（401, 403, 500）、非 JSON 响应、票据字段缺失等场景能明确抛出易诊断的异常。
