import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const stagedGlmDir = resolve("packages/desktop/bundled-agents/darwin-arm64/glm");
const packagesDir = join(stagedGlmDir, "packages");

console.log("Staged GLM packages directory:", packagesDir);

if (!existsSync(packagesDir)) {
  console.error("packages dir does not exist!");
  process.exit(1);
}

const entries = readdirSync(packagesDir);
console.log("Found staged packages:", entries);

// Check definitions from official-plugin-definitions.ts
const definitionsText = readFileSync(
  "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
  "utf-8",
);

// We verify each of the 14 official plugins
const expectedPlugins = [
  { name: "node-repl-host", dir: "packages/node-repl-host", required: ["dist/mcp/server.js"] },
  { name: "android-emulator", dir: "packages/android-emulator-plugin" },
  {
    name: "browser-use",
    dir: "packages/browser-use-plugin",
    required: [
      "docs/api.json",
      "docs/documents.json",
      "docs/overview.md",
      "docs/recording.md",
      "docs/workflow.md",
      "scripts/browser-client.mjs",
      "skills/control-browser/SKILL.md",
      "skills/web-gui-tester/SKILL.md",
    ],
  },
  {
    name: "documents",
    dir: "packages/documents-plugin",
    required: ["agents/visual-judge.md", "skills/docx/SKILL.md"],
  },
  {
    name: "pdf",
    dir: "packages/pdf-plugin",
    required: ["agents/visual-judge.md", "skills/pdf/SKILL.md"],
  },
  {
    name: "presentations",
    dir: "packages/presentations-plugin",
    required: ["agents/visual-judge.md", "skills/pptx/SKILL.md"],
  },
  {
    name: "spreadsheets",
    dir: "packages/spreadsheets-plugin",
    required: ["agents/visual-judge.md", "skills/xlsx/SKILL.md"],
  },
  { name: "image-search", dir: "packages/image-search-plugin", required: [".mcp.json"] },
  { name: "ios-simulator", dir: "packages/ios-simulator-plugin" },
  { name: "restore-legacy-sessions", dir: "packages/restore-legacy-sessions-plugin" },
  {
    name: "plugin-creator",
    dir: "packages/plugin-creator-plugin",
    required: [
      "skills/plugin-creator/SKILL.md",
      "skills/plugin-creator/scripts/create-basic-plugin.mjs",
      "skills/plugin-creator/scripts/marketplace-files.mjs",
      "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
      "skills/plugin-creator/scripts/scaffold-files.mjs",
      "skills/plugin-creator/scripts/validate-plugin.mjs",
      "skills/plugin-creator/references/plugin-json-spec.md",
      "skills/plugin-creator/references/installing-and-updating.md",
    ],
  },
  { name: "skill-creator", dir: "packages/skill-creator-plugin" },
  {
    name: "zcode-guide",
    dir: "packages/zcode-guide-plugin",
    required: [
      "commands/workflow.md",
      "skills/dynamic-workflows/SKILL.md",
      "skills/dynamic-workflows/examples.md",
      "skills/dynamic-workflows/patterns.md",
    ],
  },
  {
    name: "computer-use",
    dir: "packages/zcode-cua-plugin",
    required: [
      "docs/computer-use.md",
      "scripts/computer-use-client.mjs",
      "skills/computer-use/SKILL.md",
    ],
  },
];

let errors = 0;
for (const p of expectedPlugins) {
  const pluginDir = join(stagedGlmDir, p.dir);
  if (!existsSync(pluginDir)) {
    console.error(`❌ Plugin directory missing: ${p.dir}`);
    errors++;
    continue;
  }
  const manifestFile = join(pluginDir, ".zcode-plugin/plugin.json");
  if (!existsSync(manifestFile)) {
    console.error(`❌ Plugin manifest missing: ${manifestFile}`);
    errors++;
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));

  let missingReq = [];
  for (const req of p.required || []) {
    if (!existsSync(join(pluginDir, req))) {
      missingReq.push(req);
    }
  }

  if (missingReq.length > 0) {
    console.error(
      `❌ Plugin ${p.name} (v${manifest.version}) missing required seed assets: ${missingReq.join(", ")}`,
    );
    errors++;
  } else {
    console.log(
      `✅ [${p.name}] v${manifest.version} located at ${p.dir} with all required seed files`,
    );
  }
}

if (errors === 0) {
  console.log(
    `\n🎉 Verification Passed: All ${expectedPlugins.length} official plugins are fully intact and ready in staged GLM bundle!`,
  );
} else {
  console.error(`\n❌ Failed: ${errors} plugin error(s) detected.`);
  process.exit(1);
}
