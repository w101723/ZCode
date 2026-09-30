import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  getAppConfigDir,
  getProviderWorkspaceConfigDir,
  getProviderWorkspaceZCodeConfigIsolationDir,
  getWorkspaceHash,
} from "../src/paths.js";

test("外部运行时目录按 workspace identity 隔离，路径在无 identity 时回退", () => {
  const workspacePath = "/projects/demo";
  const one = getProviderWorkspaceConfigDir("claude", workspacePath, "remote:ssh:a:/projects/demo");
  const two = getProviderWorkspaceConfigDir("claude", workspacePath, "remote:ssh:b:/projects/demo");
  assert.notEqual(one, two);
  assert.equal(
    getProviderWorkspaceConfigDir("claude", workspacePath, "  "),
    join(getAppConfigDir(), "agent-config", "claude", getWorkspaceHash(workspacePath)),
  );
});

test("Gemini 原生目录从隔离根内读取，GLM 原有目录不依工作区改变", () => {
  const root = getProviderWorkspaceZCodeConfigIsolationDir("gemini", "/projects/demo");
  assert.equal(getProviderWorkspaceConfigDir("gemini", "/projects/demo"), join(root, ".gemini"));
  assert.equal(
    getProviderWorkspaceConfigDir("glm", "/projects/demo"),
    getProviderWorkspaceConfigDir("glm", "/projects/other"),
  );
});
