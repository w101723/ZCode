import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Logger, SkillRoot } from "@zcode/contracts";

const BUNDLED_SKILLS_PACK_DIR_NAME = "bundled-skills";
const BUNDLED_SKILLS_SUBDIR_NAME = "skills";
const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

const REQUIRED_DYNAMIC_WORKFLOW_PATHS = [
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/SKILL.md`,
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/patterns.md`,
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/examples.md`,
] as const;

const CANDIDATE_PACK_ROOTS = [
  `packages/${BUNDLED_SKILLS_PACK_DIR_NAME}`,
  `apps/zcode-cli/packages/${BUNDLED_SKILLS_PACK_DIR_NAME}`,
  `../${BUNDLED_SKILLS_PACK_DIR_NAME}`,
  `../../${BUNDLED_SKILLS_PACK_DIR_NAME}`,
  `../../../${BUNDLED_SKILLS_PACK_DIR_NAME}`,
] as const;

const SEA_ASSET_PREFIX = "zcode-bundled-skills/";
const SEA_MANIFEST_ASSET_KEY = `${SEA_ASSET_PREFIX}manifest.json`;
const SEED_MARKER_FILE = ".zcode-bundled-skills-seed.json";
const BUNDLED_SKILLS_PRIORITY = 1_000_000;

interface SeaBundledSkillManifest {
  files: Array<{
    mode?: number;
    path: string;
    sha256: string;
  }>;
  hash: string;
  version: 1;
}

type SeaModule = typeof import("node:sea");

export interface ResolveBundledSkillRootsOptions {
  cliStorageRoot?: string;
  logger?: Logger;
}

export function resolveBundledSkillRoots(
  options: ResolveBundledSkillRootsOptions = {},
): SkillRoot[] {
  const packRoot = materializeSeaBundledSkillPack(options) ?? resolveFilesystemBundledSkillPackRoot();
  if (packRoot) {
    return [
      {
        path: join(packRoot, BUNDLED_SKILLS_SUBDIR_NAME),
        priority: BUNDLED_SKILLS_PRIORITY,
        scope: "system",
        source: "bundled",
      },
    ];
  }

  options.logger?.warn("Bundled skill pack unavailable", {
    module: "bootstrap.bundled_skills",
    requiredPaths: [...REQUIRED_DYNAMIC_WORKFLOW_PATHS],
  });
  return [];
}

export function findMissingBundledSkillPackPaths(packRoot?: string): string[] {
  if (!packRoot) return [...REQUIRED_DYNAMIC_WORKFLOW_PATHS];
  return REQUIRED_DYNAMIC_WORKFLOW_PATHS.filter(
    (requiredPath) => !existsSync(join(packRoot, ...requiredPath.split("/"))),
  );
}

export function resolveFilesystemBundledSkillPackRoot(): string | undefined {
  for (const baseDir of candidateBaseDirs()) {
    for (const relativePath of CANDIDATE_PACK_ROOTS) {
      const candidateRoot = resolve(baseDir, relativePath);
      if (
        existsSync(join(candidateRoot, BUNDLED_SKILLS_SUBDIR_NAME)) &&
        findMissingBundledSkillPackPaths(candidateRoot).length === 0
      ) {
        return candidateRoot;
      }
    }
  }
  return undefined;
}

function candidateBaseDirs(): string[] {
  return [
    process.argv[1] ? dirname(process.argv[1]) : undefined,
    typeof __dirname === "string" ? __dirname : undefined,
    process.cwd(),
  ].filter((entry): entry is string => typeof entry === "string");
}

function materializeSeaBundledSkillPack(
  options: ResolveBundledSkillRootsOptions,
): string | undefined {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;

  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;

  const storageRoot =
    options.cliStorageRoot ??
    join(process.env.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".zcode"), "cli");
  const bundledSkillsStorageDir = join(storageRoot, BUNDLED_SKILLS_PACK_DIR_NAME);
  const targetRoot = join(bundledSkillsStorageDir, manifest.hash);

  if (isSeedComplete(targetRoot, manifest.hash)) {
    return targetRoot;
  }

  const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(temporaryRoot, { recursive: true });
    for (const file of manifest.files) {
      const rawAsset = Buffer.from(sea.getRawAsset(`${SEA_ASSET_PREFIX}${file.path}`));
      if (hashBytes(rawAsset) !== file.sha256) {
        throw new Error(`Bundled skill asset hash mismatch: ${file.path}`);
      }
      const destinationPath = join(temporaryRoot, ...file.path.split("/"));
      mkdirSync(dirname(destinationPath), { recursive: true });
      writeFileSync(destinationPath, rawAsset, { mode: file.mode ?? 0o644 });
    }
    writeFileSync(
      join(temporaryRoot, SEED_MARKER_FILE),
      JSON.stringify({ hash: manifest.hash, version: 1 }, null, 2),
    );
    mkdirSync(bundledSkillsStorageDir, { recursive: true });
    renameSync(temporaryRoot, targetRoot);
    return targetRoot;
  } catch (error) {
    rmSync(temporaryRoot, { force: true, recursive: true });
    if (isSeedComplete(targetRoot, manifest.hash)) {
      return targetRoot;
    }
    const fallbackRoot = findUsableSeededPack(bundledSkillsStorageDir);
    options.logger?.warn("Bundled skill pack seed degraded", {
      error: error instanceof Error ? error.message : String(error),
      fallbackRoot,
      module: "bootstrap.bundled_skills",
      targetRoot,
    });
    return fallbackRoot;
  }
}

function isSeedComplete(rootPath: string, expectedHash: string): boolean {
  try {
    const rawMarker = readFileSync(join(rootPath, SEED_MARKER_FILE), "utf8");
    const marker = JSON.parse(rawMarker) as { hash?: string };
    if (marker.hash !== expectedHash) return false;
  } catch {
    return false;
  }
  return findMissingBundledSkillPackPaths(rootPath).length === 0;
}

function findUsableSeededPack(storageDir: string): string | undefined {
  let entries;
  try {
    entries = readdirSync(storageDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.includes(".tmp-"))
    .map((entry) => join(storageDir, entry.name))
    .find((candidateRoot) => {
      try {
        const marker = JSON.parse(
          readFileSync(join(candidateRoot, SEED_MARKER_FILE), "utf8"),
        ) as { hash?: string };
        return typeof marker.hash === "string" && isSeedComplete(candidateRoot, marker.hash);
      } catch {
        return false;
      }
    });
}

function readSeaManifest(sea: SeaModule): SeaBundledSkillManifest | undefined {
  try {
    const manifest = JSON.parse(sea.getAsset(SEA_MANIFEST_ASSET_KEY, "utf8")) as SeaBundledSkillManifest;
    return manifest.version === 1 && typeof manifest.hash === "string" && Array.isArray(manifest.files)
      ? manifest
      : undefined;
  } catch {
    return undefined;
  }
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
