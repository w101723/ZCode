// 打包后 agent bundle 启动验收。
// 背景：bundle.mjs 原有的 verify 只覆盖 app.asar 依赖闭包与 native 越界，不覆盖 agent 的
// 运行健康。v3.14.3 合并时 shared help 表漏了 workflow 条目，zcode.cjs 模块加载期直接
// throw，安装包照常产出，用户首启才在 preparing_session_storage 阶段报兜底的
// transport_closed（桌面诊断会排空 agent stderr，崩溃原因完全不可见）。
// 这里在 bundle 阶段用与桌面 host 相同的存储准备协议做一次真实握手，让“agent 启动即崩”
// 的坏包直接在打包机上失败，而不是流到用户手里。

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const desktopDistDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
const desktopProductIdentity = resolveDesktopProductIdentity(process.env);

// 与桌面 host prepareSessionStorage 相同的 30s 首帧预算不同：打包机磁盘/杀软可能更慢，
// 这里给足 90s，超时按失败处理并保留 stderr 供定位。
const SMOKE_TIMEOUT_MS = 90_000;
const STDERR_TAIL_LIMIT = 40;

const osAliasMap = new Map([
  ["mac", "mac"],
  ["macos", "mac"],
  ["darwin", "mac"],
  ["osx", "mac"],
  ["win", "win"],
  ["windows", "win"],
  ["win32", "win"],
  ["linux", "linux"],
]);

const archAliasMap = new Map([
  ["x64", "x64"],
  ["amd64", "x64"],
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
]);

function normalizeOs(rawOs) {
  const normalizedOs = osAliasMap.get(String(rawOs).toLowerCase());
  if (!normalizedOs) {
    throw new Error(`不支持的目标操作系统: ${rawOs}`);
  }
  return normalizedOs;
}

function normalizeArch(rawArch) {
  const normalizedArch = archAliasMap.get(String(rawArch).toLowerCase());
  if (!normalizedArch) {
    throw new Error(`不支持的目标 CPU 架构: ${rawArch}`);
  }
  return normalizedArch;
}

/** 与 bundle.mjs resolveAppAsarPath 同一套 unpacked 布局；agent 固定落在 resources/glm。 */
export function resolvePackagedAgentEntryPath(os, arch) {
  const distRoot = resolve(desktopRoot, desktopDistDir);

  if (os === "mac") {
    return join(
      distRoot,
      arch === "arm64" ? "mac-arm64" : "mac",
      `${desktopProductIdentity.productName}.app`,
      "Contents",
      "Resources",
      "glm",
      "zcode.cjs",
    );
  }

  const archSuffix = arch === "arm64" ? "-arm64" : "";
  const unpackedDirName =
    os === "win" ? `win${archSuffix}-unpacked` : `linux${archSuffix}-unpacked`;
  return join(distRoot, unpackedDirName, "resources", "glm", "zcode.cjs");
}

function parseArgs(argv) {
  const options = {
    os: process.env.ZCODE_TARGET_OS ?? null,
    arch: process.env.ZCODE_TARGET_ARCH ?? null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--os" || arg === "-o") {
      options.os = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--os=")) {
      options.os = arg.slice("--os=".length);
      continue;
    }

    if (arg === "--arch" || arg === "-a") {
      options.arch = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--arch=")) {
      options.arch = arg.slice("--arch=".length);
      continue;
    }

    throw new Error(`不支持的参数: ${arg}`);
  }

  return {
    os: normalizeOs(options.os ?? (process.platform === "win32" ? "win" : "mac")),
    arch: normalizeArch(options.arch ?? process.arch),
  };
}

function buildStagingMetaCheck(agentEntryPath) {
  const agentDir = resolve(agentEntryPath, "..");
  const metaPath = join(agentDir, ".node-bundle-meta.json");
  if (!existsSync(metaPath)) {
    throw new Error(`打包产物缺少 agent bundle 元数据: ${metaPath}`);
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch (error) {
    throw new Error(`agent bundle 元数据不可解析: ${metaPath} (${error.message})`);
  }

  if (meta.entry !== "zcode.cjs" || !existsSync(agentEntryPath)) {
    throw new Error(
      `agent bundle 元数据与产物不一致: entry=${meta.entry} exists=${existsSync(agentEntryPath)} (${agentEntryPath})`,
    );
  }
}

function collectStderrTail(stderrChunks) {
  const text = stderrChunks.join("").trim();
  if (!text) {
    return "(stderr 为空)";
  }

  const lines = text.split(/\r?\n/);
  return lines.slice(-STDERR_TAIL_LIMIT).join("\n");
}

/**
 * 用与桌面 host 相同的 startup/storagePath → storagePathReady → storagePrepared
 * 协议真实跑一遍 --prepare-storage。任何启动期崩溃（模块加载 throw、native 缺失、
 * 协议帧缺失、非零退出）都会在这里带完整 stderr 失败。
 */
export function runAgentStoragePreparationSmoke({ agentEntryPath, timeoutMs = SMOKE_TIMEOUT_MS }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;

    void (async () => {
      // 存储准备会真实建库/迁移。ZCODE_DATA_BASE_DIR 优先级高于 homedir
      // （packages/services/src/paths.ts），把所有写入隔离进临时目录，
      // 打包机（尤其开发机）上的真实 ~/.zcode 不会被冒烟触碰。
      const isolatedDataRoot = await mkdtemp(join(tmpdir(), "zcode-agent-smoke-home-"));
      const smokeCwd = await mkdtemp(join(tmpdir(), "zcode-agent-smoke-cwd-"));
      await writeFile(join(smokeCwd, "README.md"), "agent storage preparation smoke\n");

      const child = spawn(
        process.execPath,
        [agentEntryPath, "app-server", "--stdio", "--prepare-storage", "--cwd", smokeCwd],
        {
          cwd: smokeCwd,
          env: {
            ...process.env,
            ZCODE_DATA_BASE_DIR: isolatedDataRoot,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      const stderrChunks = [];
      const cleanup = () =>
        // 冒烟产生的隔离目录用完即清，避免打包机上累积。
        Promise.all([
          rm(isolatedDataRoot, { recursive: true, force: true }),
          rm(smokeCwd, { recursive: true, force: true }),
        ]);
      let receivedStoragePath = false;
      let receivedPrepared = false;
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk) => {
        stderrChunks.push(chunk);
      });

      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void child.kill("SIGKILL");
        void cleanup();
        rejectPromise(
          new Error(
            `${message}\nagent entry: ${agentEntryPath}\nstderr 尾部:\n${collectStderrTail(stderrChunks)}`,
          ),
        );
      };

      const timer = setTimeout(() => {
        fail(
          receivedStoragePath
            ? `agent 存储准备握手超时 (${timeoutMs}ms)，已收到 startup/storagePath 但未完成 storagePrepared`
            : `agent 存储准备握手超时 (${timeoutMs}ms)，未收到 startup/storagePath`,
        );
      }, timeoutMs);

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (settled) return;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          fail(`agent 输出了非 JSON 控制帧: ${line.slice(0, 200)}`);
          return;
        }

        if (frame.method === "startup/storagePath") {
          receivedStoragePath = true;
          child.stdin.write(
            `${JSON.stringify({ method: "startup/storagePathReady", reuse: true })}\n`,
          );
          return;
        }

        if (frame.method === "startup/storagePrepared") {
          receivedPrepared = true;
          child.stdin.end();
        }
      });

      child.once("error", (error) => {
        fail(`agent 冒烟进程启动失败: ${error.message}`);
      });

      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        void cleanup();
        if (code === 0 && receivedStoragePath && receivedPrepared) {
          resolvePromise();
          return;
        }

        rejectPromise(
          new Error(
            `agent 存储准备冒烟失败: exit=${code} storagePath=${receivedStoragePath} storagePrepared=${receivedPrepared}\nagent entry: ${agentEntryPath}\nstderr 尾部:\n${collectStderrTail(stderrChunks)}`,
          ),
        );
      });
    })().catch((error) => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });
  });
}

export async function verifyPackagedAgentBundle({ os, arch, timeoutMs }) {
  const agentEntryPath = resolvePackagedAgentEntryPath(os, arch);
  if (!existsSync(agentEntryPath)) {
    throw new Error(`打包产物缺少 agent bundle: ${agentEntryPath}`);
  }

  buildStagingMetaCheck(agentEntryPath);
  await runAgentStoragePreparationSmoke({ agentEntryPath, timeoutMs });
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  try {
    const { os, arch } = parseArgs(process.argv.slice(2));
    await verifyPackagedAgentBundle({ os, arch });
    console.log(`[verify-agent] OK target=${os}/${arch}`);
  } catch (error) {
    console.error(`[verify-agent] FAILED: ${error.message}`);
    process.exit(1);
  }
}
