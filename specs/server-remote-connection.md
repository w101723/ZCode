# 已运行 ZCode Server 直连

## 产品规则

桌面端的 `server` 远程目标连接已经运行的 ZCode Server，不部署或启动远端 CLI；Web 端可连接已明确配置可信 Web 来源的独立 Server。Server URL 与显示名称属于脱敏目标；Token 仅在凭据边界处理，不进入连接历史、广播、日志或工作区 identity。既有 SSH、WSL、Docker 的启动与身份语义不变。

Server 以元信息返回的真实 `serverId` 加真实 `workspacePath` 生成隔离 identity；首次桌面连接不能在元信息返回之前按 URL 主机名固定 identity，连接描述符与历史必须传播 `serverId`。路径只供远端 IO，身份键统一为 `workspaceIdentity?.trim() || workspacePath`。会话拥有者为窗口级连接注册表（桌面）或 Web 连接注册表；Main 与 HTTP 网关只负责路由、鉴权和 attachment，不保存任务队列或快照。

## 鉴权与时序

```text
表单草稿 → 凭据服务/临时内存 Token → server-info / 版本校验
         → 授权 → 一次性短期票据 → WebSocket 握手 → 注册 session/identity
         → 选择远端路径 → Host/CLI 会话所有者 → UI 投影
```

桌面 Node Host 只通过鉴权后的 `POST /api/rpc-host-capability` 获取短期、一次性 host capability，并在 `/ws/host` 握手提交 header，使用 `desktop-continuous`。没有 Token 的公网服务不允许将发放 host capability 视为可信认证。浏览器**不得**申请 host capability 或使用 `/ws/host`；跨域浏览器必须先通过服务端显式配置的可信 Origin，使用短期、一次性、与 Origin 绑定的 Web 票据连接普通 `/ws`，永远为 `web-remote-replayable`。Web 不将长期 Token 写入浏览器持久存储或 URL；Web 的现有 Credential Service 是连接到当前 Server 的 RPC 代理，不能作为浏览器端可信凭据存储。Web 保存 Server 工作区历史时只保留脱敏 URL、serverId 和路径，不生成或加载 Token 凭据键；Web 点击历史重连时先显示临时 Token 输入弹窗（无认证目标可留空），提交后沿用既有按 workspace key 的重连流程。Token 只作为本次命令的临时参数，取消或完成后清空；重连失败保留脱敏历史与错误，不将其转存到另一个 Server。Desktop 可通过本机 Credential Service 的独立键保存 Token，用于重连；两端普通设置与目标快照均不得包含明文 Token。未配置可信 Origin 时跨域 fail-closed。服务端对 WebSocket 校验 Origin，拒绝跨站套用 cookie。查询票据只允许短期值，不记录请求 URL；重复消费、过期、来源不符一律拒绝。

取消、连接失败或断线先撤销待使用票据，再按 session generation 清理旧 attachment；陈旧响应不能覆盖新连接。桌面 live stream 与手机/Web replayable 快照/补洞语义分别验收。Token 必须经过安全传输（HTTPS/WSS；loopback 开发可用 HTTP/WS），认证失败不回显 secret。携带 Bearer 的请求禁止自动跟随 HTTP 重定向，避免目标 Server 将凭据转发到其他 Origin。反向代理的 `Host`、`X-Forwarded-Host`、`X-Forwarded-Proto` 不可由不可信客户端自行声明为 HTTPS 或同源；只有明确配置的可信代理入口才可使用转发头。Web ticket 消费必须提供与签发时相同的 Origin，缺失 Origin、跨来源或重放一律失败。遗留 `/ws/remote/*` 不可作为绕开普通 `/ws` 认证和角色限制的跨域入口。

## 兼容边界

现有 `packages/server` 和常驻 `packages/zcode-server-cli` 的 Core HTTP 服务都暴露 `/api/server-info`、`/api/rpc-host-capability`、`/ws`、`/ws/host`；新增目标应核对这两个出口，不能仅在一个实现增加保护。协议版本不符要明确失败，不隐式切换为 SSH 部署。已有同源 Web 工作区不依赖跨域远程票据，照旧工作。

对于缺少 `serverId` 的遗留历史条目（Legacy History），重连入口不得将基于 URL 的 fallback identity 提前作为已认证身份透传给连接层（Registry 守卫禁止未校验 server 指定 identity）；应仅传递 workspacePath，待连接成功且服务端下发校验过的真实 `serverId` 后，按真实 `serverId` 构造规范 identity 并就地升级原有历史记录，不得放松底层 Registry 安全守卫，且升级时避免生成重复条目。Web 路径同样不应使用未验证的旧 fallback identity。迁移过程中的取消/移除校验仍检查原历史身份；握手后若 session 缺少真实 serverId，则回收连接并失败，不退回 URL 身份。成功提交以原 workspace key 精确替换历史和断连标签，在 Tab Store 内原子更新身份、路径与 session，保持 tab id、焦点及同路径其它 Server 的隔离；失败不升级旧历史。

## 握手取消与凭据发送前的身份校验

- Desktop connector 是握手期 WebSocket 的唯一生命周期所有者；取消时立即拒绝连接 Promise 并关闭 socket，但 `error`/`close` 监听必须保留到关闭完成。不能先移除 `error` 监听再关闭 CONNECTING socket，否则 `ws` 异步发出的错误会逃逸为 Host 的 fatal uncaughtException。迟到 `open` 不得使已取消的连接成功，关闭后释放握手监听与 AbortSignal 监听。
- Web ticket adapter 接收历史目标的预期 `serverId`；公开元信息通过共享协议 schema 校验后，必须在发送带 Token 的票据请求前核对该身份。身份不匹配时失败，不申请票据、不建立 WS、不更新历史；首次连接或缺少 `serverId` 的旧历史仍可连接，并沿用既有真实身份升级流程。

```text
Desktop connector: WS CONNECTING → cancel → Promise 拒绝 / socket 关闭
                                        → error 被握手所有者接收 → close 清理监听
Web ticket adapter: public server-info → schema / expected serverId 校验
                                     → 匹配才发送 Bearer → ticket → replayable WS
```

## 验收场景

1. 桌面提供正确 Token 时可直连现有 Server、选择远端目录、重连同一 serverId/workspacePath；无效 Token 或版本不符不建立会话；日志/持久记录不含 Token。
2. Web 在允许的 Origin 上通过短时票据连接；另一个 Origin、缺失/过期/重放票据不能升级；浏览器无法取得 `trusted-host-relay` 或 Provider Provisioning 写接口。
3. 跨域未配置白名单、HTTP 非 loopback 携带长期 Token、未认证 host capability 均拒绝；允许的安全来源完成 CORS 预检与 WS 握手。
4. 中途取消、断线、快速重连时旧 generation 不影响新会话；桌面连续事件与 Web 恢复快照分开验证。
5. SSH/WSL/Docker 连接及同源 Web 原有路径无回归。
6. 远程连接弹窗（SSHDialog）以 active request ref/generation 为唯一所有者：取消、返回、重新打开或同 tick 重复点击触发时，过期的异步连接完成既不自动重新打开弹窗也不覆盖当前 UI 步骤；若过期成功的 session 迟到返回，立即通过 onCancelSession 安全释放；正在连接中（loading ref 守卫）阻止并发或同 tick 重复发起；弹窗彻底关闭以及连接成功时清空 Token，并在成功后将 pendingRemoteTarget 脱敏，仅在连接失败时保留 secret 以便用户重试。
7. 远程连接弹窗（SSHDialog）组件卸载（unmount）与所有权转移生命周期：弹窗是 pending 请求与未绑定会话的唯一所有者；组件卸载时必须递增 generation 使陈旧异步连接失效、终止当前 pending 请求（调用 cancelPendingRemoteConnection 并传入确切 requestId）、释放尚未转交的未确认会话（调用 onCancelSession），并同步通知 onFlowActiveChange(false) 与 onFlowRequestIdChange(null)。成功选择远程目录并将所有权转移给工作区后，该会话绝不可被弹窗卸载清理释放；使用同步 ref 跟踪会话绑定状态与待处理请求，避免异步闭包陈旧与 React StrictMode 重复挂载/卸载误取消活跃已绑定会话。弹窗收起（minimize）仅隐藏界面并保持 in-flight 连接与步骤，连接成功后按完成状态弹回。
