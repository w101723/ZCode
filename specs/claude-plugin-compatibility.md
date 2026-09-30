# Claude 插件格式与市场兼容

ZCode 官方市场 `zcode-plugins-official` 仍是唯一具有内置/官方授权与默认启用语义的市场。Claude 的 `.claude-plugin/marketplace.json`、`.claude-plugin/plugin.json` 和 `CLAUDE_PLUGIN_ROOT` 属于兼容格式；名称 `claude-plugins-official` 不赋予 ZCode 内部 broker 凭据、系统插件来源或默认启用能力。

外部 Claude 市场由用户显式添加，沿用现有来源下载、完整性、路径逃逸和权限限制。manifest 的未知组件仅给诊断，不将其悄悄当作已安装的工具。对市场来源与清单命名分别校验，保留 ZCode 官方 ID 防冒名。验收：兼容清单可发现/安装、运行时可展开 Claude 根目录变量、伪造 ZCode 官方市场遭拒、外部市场不获得内部授权。
