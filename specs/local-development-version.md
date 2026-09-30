# 本地开发版本

## 产品规则与唯一来源

- 根目录 `package.json.version` 是本地应用版本基数的唯一来源。本次从 `dev-3.14.3` 提升为 `dev-3.14.4`，保留开发构建标识。
- Desktop 继续通过现有 `collectBuildMetadata` 派生展示版本 `dev-3.14.4-<git短hash>` 和用于 electron-builder 的数字版本 `3.14.4`，不新增第二套版本配置。
- 非 Git 环境保持现有 commit 回退规则；本次不修改版本生成算法、CLI 独立版本轴、远程资源地址或历史版本记录。
- 已存在的 build metadata 通过现有生成入口刷新，避免继续消费旧缓存。修改版本配置不代表已重新打包或替换安装中的应用。

## 验收

1. `collectBuildMetadata()` 返回 `packageVersion === "3.14.4"`；有有效 commit 时，`appVersion === "dev-3.14.4-" + buildCommitId`，否则为 `dev-3.14.4`。
2. 现有 `writeBuildMetadata()` 生成的 metadata 与上述派生结果一致。
3. 执行类型检查、Lint、格式检查及 changed 架构检查，保留与本次无关的本地变更。
