# macOS 本地开发包签名与本地网络权限

## 产品规则与边界

- macOS 本地开发安装包没有 Apple 证书时，必须使用 electron-builder 原生的 ad-hoc 签名（`mac.identity: "-"`），不能用 `null` 跳过签名。此规则覆盖 arm64 与 x64。
- 发布签名仍由 `ZCODE_ENABLE_MAC_SIGN=1` 与现有证书身份控制；显式开启发布签名但缺少身份时必须报错，不静默降级为本地包。
- 主应用声明 `NSLocalNetworkUsageDescription`，说明连接局域网设备和开发服务的用途。不开启 App Sandbox，不以 network.client/server entitlement 代替用户授权。
- 本地包主程序的 Mach-O `LC_UUID` 由应用 bundle ID 与架构确定，区别于上游 Electron、生产版与 Preview 的身份；同一身份和架构重复构建保持 UUID 稳定。只在本地包的 afterPack 阶段修改，发布签名包不改变 UUID。
- ad-hoc 签名修复当前 linker-signed 二进制的身份与 Info.plist 不绑定问题，但不保证 macOS 在每次构建后都保留授权。Apple 签发的证书仍是发行包可靠身份跟踪的要求。

## 唯一所有者和执行顺序

打包身份由现有 `desktopProductIdentity` 管理；系统设置中的本地网络授权由 macOS 管理。运行时不保存第二份授权状态，也不绕过用户拒绝。

```text
构建资源 → afterPack 完成资源写入
         → 本地包主程序 UUID 归一化
         → electron-builder 按嵌套顺序签名（Helper / Framework / 主应用）
         → afterSign 校验主应用和所有 Electron Helper
         → 生成 DMG / ZIP

用户安装新包 → 退出旧进程链 → 启动新应用 → macOS 识别负责的应用 → 用户授权
                                                        → Agent 网络连接
```

签名后不得再修改应用内容。不会自动覆盖正在运行的 `/Applications/ZCode.app`、重置系统隐私数据库或修改网络配置。此变更不涉及会话、Host 业务状态与桌面/手机 stream 语义。

## 校验与失败语义

- 使用 `codesign --verify --deep --strict` 校验签名完整性。
- 主应用与 Electron Helper 的签名 Identifier 必须匹配各自 Info.plist 的 CFBundleIdentifier；拒绝 `Info.plist=not bound`、缺少资源封印及残留 `linker-signed`。
- 不支持的 Mach-O、缺失/重复 LC_UUID、越界 load command 必须在签名前报错，不生成身份不明确的包。
- 校验失败时构建失败，不发布带缺陷的安装产物。保留现有预签名 CUA Helper 的 signIgnore 边界。

## 验收场景

1. 无证书的 macOS arm64/x64 包选择 `identity: "-"`，发布包保持证书身份及 hardened runtime 配置。
2. 显式开启证书签名但未提供身份时失败；不会因为环境遗漏被当作成功发布包。
3. 本地包用途声明非空；主程序 UUID 同身份同架构稳定，不同应用身份不相同。thin 与 universal Mach-O 均正确处理。
4. 主应用与 Electron Helper 都通过严格签名校验，Identifier 不再为 Electron / Electron Helper。
5. 非 macOS 构建不执行 UUID 或 codesign 检查。
6. 新应用启动并由用户授权后，从其 Agent 用 Network.framework 连接局域网，不能再出现 `localNetworkDenied`。TCP 拒绝或 ICMP 超时不单独判定为权限失败。
7. 未重启当前应用或无法进行系统授权交互时，明确报告运行时验收尚未完成，不将产物签名通过写成网络修复已验证。
