# 模式文案与工作区运行时配置隔离

## 规则

当前执行引擎只支持 ZCode Agent（`glm`）。Claude、Codex、Gemini 与 OpenCode 的模式名称/权限说明是从 3.14.4 导入的展示兼容数据，不得据此在产品中开放无法执行的外部 Agent 或将模式作为模型 Provider 路由。模式接纳仍由现有 CLI/ExecutionState 拥有；危险权限模式应明显提示。

外部 Agent 原生配置路径按 `workspaceIdentity?.trim() || workspacePath` 的 SHA-256 前 12 位隔离，使用现有 `getWorkspaceHash`；GLM 继续使用原有全局 CLI 配置，不迁移、不静默重写。Claude 历史会话导入保留 `agent-config/claude/<hash>/projects` 布局；Gemini 的原生目录位于隔离根之下的 `.gemini`。路径解析由 services 单一函数持有，调用者不得自行拼接。

## 验收

- 当前只显示 ZCode Agent 可执行模式；兼容映射未被误报为可执行外部 Agent。
- `yolo`、`bypassPermissions`、`full-access`、`agent-full-access` 显示危险权限图标；默认、计划、自动编辑等图标与文案正确。
- 同一 workspacePath、不同 workspaceIdentity 解析为不同隔离目录；空白 identity 回退路径；GLM 目录与旧版本一致。
- Claude 历史导入仍写入原有路径，不创建第二份配置目录或访问外部用户真实原生配置。
