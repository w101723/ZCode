export type ModeDisplayFamily = "glm" | "claude" | "codex" | "gemini" | "opencode";

const modesByFamily: Record<ModeDisplayFamily, readonly string[]> = {
  glm: ["default", "build", "edit", "plan", "yolo"],
  claude: ["auto", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"],
  codex: ["read-only", "auto", "agent", "full-access", "agent-full-access"],
  gemini: ["default", "autoEdit", "yolo", "plan"],
  opencode: ["build", "plan"],
};

function createModeMessageIds(kind: "label" | "description") {
  return Object.fromEntries(
    Object.entries(modesByFamily).map(([family, modes]) => [
      family,
      Object.fromEntries(modes.map((mode) => [mode, `mode.${kind}.${family}.${mode}`])),
    ]),
  ) as Record<ModeDisplayFamily, Record<string, string>>;
}

export const ZCODE_MODE_OPTION_LABEL_IDS = createModeMessageIds("label");
export const ZCODE_MODE_OPTION_DESCRIPTION_IDS = createModeMessageIds("description");
