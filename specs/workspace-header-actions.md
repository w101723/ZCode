# 工作区标题操作

标题栏已有本机文件管理器打开、外部编辑器选择、复制工作区/任务路径和 Agent 工作区进程重载能力。复用当前 hook、平台服务与菜单，不另建原生调用或第二套运行态。重载不是页面刷新：在当前 `workspaceIdentity?.trim() || workspacePath` 与 session 归属下，由 task/agent 服务先终止并重新初始化工作区进程，失败保留原有失败反馈；进行中禁用重复操作。

文件管理器动作只对本地或可映射的 WSL 路径启用；SSH、Docker、Server 的远端路径不能作为本地路径打开；Web/移动端不展示不支持的原生动作。复制动作以实际 workspacePath 为值，绝不用 identity 代替文件路径。菜单项使用现有国际化、设计 token 与 no-drag 区域。

验收：macOS/Windows/Linux 标签与路径正确；本地与 WSL 可打开，SSH/Docker/Server 不误开本机路径；复制工作区/任务路径准确；点击重载只请求一次 Agent 重启并反馈状态，忙碌/断连/只读状态有明确门禁；Web 与手机菜单无不可用入口。
