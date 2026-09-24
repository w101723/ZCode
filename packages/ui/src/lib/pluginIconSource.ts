import androidEmulatorIconUrl from "@/assets/plugin-icons/android-emulator.png";
import browserUseIconUrl from "@/assets/plugin-icons/browser-use.png";
import computerUseIconUrl from "@/assets/plugin-icons/computer-use.png";
import documentsIconUrl from "@/assets/plugin-icons/documents.png";
import imageSearchIconUrl from "@/assets/plugin-icons/image-search.png";
import iosSimulatorIconUrl from "@/assets/plugin-icons/ios-simulator.png";
import pdfIconUrl from "@/assets/plugin-icons/pdf.png";
import pluginCreatorIconUrl from "@/assets/plugin-icons/plugin-creator.png";
import presentationsIconUrl from "@/assets/plugin-icons/presentations.png";
import restoreLegacySessionsIconUrl from "@/assets/plugin-icons/restore-legacy-sessions.png";
import skillCreatorIconUrl from "@/assets/plugin-icons/skill-creator.png";
import spreadsheetsIconUrl from "@/assets/plugin-icons/spreadsheets.png";
import zcodeGuideIconUrl from "@/assets/plugin-icons/zcode-guide.png";
import { isTrustedImageUrl } from "@/lib/trustedImageUrl.js";

const OFFICIAL_PLUGIN_ICON_BY_ID: Readonly<Record<string, string>> = {
  "android-emulator@zcode-plugins-official": androidEmulatorIconUrl,
  "browser-use@zcode-plugins-official": browserUseIconUrl,
  "computer-use@zcode-plugins-official": computerUseIconUrl,
  "document-skills@zcode-plugins-official": documentsIconUrl,
  "documents@zcode-plugins-official": documentsIconUrl,
  "image-search@zcode-plugins-official": imageSearchIconUrl,
  "ios-simulator@zcode-plugins-official": iosSimulatorIconUrl,
  "pdf@zcode-plugins-official": pdfIconUrl,
  "plugin-creator@zcode-plugins-official": pluginCreatorIconUrl,
  "presentations@zcode-plugins-official": presentationsIconUrl,
  "restore-legacy-sessions@zcode-plugins-official": restoreLegacySessionsIconUrl,
  "skill-creator@zcode-plugins-official": skillCreatorIconUrl,
  "spreadsheets@zcode-plugins-official": spreadsheetsIconUrl,
  "zcode-guide@zcode-plugins-official": zcodeGuideIconUrl,
};

const TRUSTED_BUNDLED_PLUGIN_ICONS = new Set(Object.values(OFFICIAL_PLUGIN_ICON_BY_ID));

/** 按完整身份解析客户端自有图标，避免商店、候选和消息各自维护不同例外。 */
export function resolvePluginIconSource(
  pluginId: string | undefined,
  icon?: string,
): string | undefined {
  if (pluginId) {
    // 优先匹配完整 ID；兼容裸插件名回退到官方市场 ID，保证离线与无网环境下官方内置图标稳定加载
    const bundledIcon =
      OFFICIAL_PLUGIN_ICON_BY_ID[pluginId] ??
      (pluginId.includes("@")
        ? undefined
        : OFFICIAL_PLUGIN_ICON_BY_ID[`${pluginId}@zcode-plugins-official`]);
    if (bundledIcon) return bundledIcon;
  }
  return isTrustedImageUrl(icon) ? icon : undefined;
}

/** Session 投影已完成身份匹配；仅放行固定打包资源，不放宽任意本地 URL。 */
export function isTrustedPluginIconSource(icon: string | undefined): icon is string {
  return Boolean(icon && TRUSTED_BUNDLED_PLUGIN_ICONS.has(icon)) || isTrustedImageUrl(icon);
}
