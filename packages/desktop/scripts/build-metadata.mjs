import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = import.meta.dirname;

function findPackageDir(packageName, startDirs) {
  for (const startDir of startDirs) {
    let currentDir = resolve(startDir);

    while (true) {
      const packageJsonPath = resolve(currentDir, "package.json");
      if (existsSync(packageJsonPath)) {
        try {
          const packageJson = readJson(packageJsonPath);
          if (packageJson.name === packageName) {
            return currentDir;
          }
        } catch {
          // ignore invalid package.json and continue walking up
        }
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  throw new Error(`Unable to find package directory for ${packageName}`);
}

const desktopDir = findPackageDir("@zcode/desktop", [
  moduleDir,
  resolve(moduleDir, ".."),
  process.cwd(),
]);
const workspaceDir = resolve(desktopDir, "../..");
const metadataDir = resolve(desktopDir, "out/metadata");
const metadataPath = resolve(metadataDir, "build-meta.json");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function normalizeVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    return "unknown";
  }

  const normalized = version.replace(/^[^\d]*/, "");
  return normalized || version;
}

/**
 * 展示版本动态拼接 git 短 hash：`dev-3.14.3` → `dev-3.14.3-<8位hash>`。
 *
 * 之前 appVersion 静态钉在 package.json 的 `dev-3.14.3`，同一基线先后打的包
 * 无法从 About/文件名区分（只能翻 build-meta 的 commitId）。electron-builder 的
 * 硬约束只落在 packageVersion（extraMetadata.version，semver 校验；Windows 版本
 * 资源按 major.minor.patch 数字解析），appVersion 只进展示串与产物文件名，追加
 * `-<hash>` 后缀是安全的；所有版本比较处（autoUpdater 的 semver.coerce、远端部署
 * 的整串不等判断）对动态后缀的行为都符合预期。
 *
 * hash 与 buildCommitId 同源同精度（git rev-parse --short=8）；非 git 环境
 * （源码 zip、CI 浅导出）回退纯 base，保证可构建性。
 */
function buildDynamicAppVersion(baseVersion, commitId) {
  const base = typeof baseVersion === "string" ? baseVersion.trim() : "";
  if (!base) return "unknown";
  if (!commitId || commitId === "unknown") return base;
  return `${base}-${commitId}`;
}

function resolveInstalledPackageVersion(packageName, fallbackVersion) {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [desktopDir] });
    return normalizeVersion(readJson(packageJsonPath).version);
  } catch {
    return normalizeVersion(fallbackVersion);
  }
}

function resolveCommitId() {
  try {
    return execSync("git rev-parse --short=8 HEAD", {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return process.env.ZCODE_COMMIT ?? "unknown";
  }
}

export function collectBuildMetadata() {
  const rootPackageJson = readJson(resolve(workspaceDir, "package.json"));
  const desktopPackageJson = readJson(resolve(desktopDir, "package.json"));
  const rawVersion =
    typeof rootPackageJson.version === "string" ? rootPackageJson.version.trim() : "unknown";
  const buildCommitId = resolveCommitId();

  return {
    // 展示版本 = package.json 基线 + git 短 hash（如 dev-3.14.3-07fc6b58），
    // 让 About/文件名可直接区分同一基线下的不同构建。
    appVersion: buildDynamicAppVersion(rawVersion, buildCommitId),
    // 打包元数据版本：去掉前缀取数字（semver），供 electron-builder extraMetadata 使用。
    packageVersion: normalizeVersion(rawVersion),
    buildCommitId,
    buildTime: new Date().toISOString(),
    electronBuilderVersion: resolveInstalledPackageVersion(
      "electron-builder",
      desktopPackageJson.devDependencies?.["electron-builder"],
    ),
  };
}

export function readBuildMetadata() {
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    return readJson(metadataPath);
  } catch {
    return null;
  }
}

export function getBuildMetadata() {
  return readBuildMetadata() ?? collectBuildMetadata();
}

export function writeBuildMetadata() {
  // About 之前分别在 tsup、vite 里各算一份 commit 和时间。
  // 问题原因：两次构建是独立进程，时间点天然不一致；后面再打包时，最终安装包里展示的信息也不一定对应同一次产物。
  // 这里先统一落盘成 build-meta.json，再让构建和运行时都复用同一份数据，保证 about 可追溯。
  const metadata = collectBuildMetadata();
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  return metadata;
}

export function getBuildMetadataPath() {
  return metadataPath;
}

const entryFilePath = process.argv[1] ? resolve(process.argv[1]) : null;
const currentFilePath = fileURLToPath(import.meta.url);

if (entryFilePath === currentFilePath) {
  const metadata = writeBuildMetadata();
  process.stdout.write(`[build-meta] wrote ${metadataPath}\n`);
  process.stdout.write(
    `[build-meta] commit=${metadata.buildCommitId} time=${metadata.buildTime}\n`,
  );
}
