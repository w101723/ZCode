import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkspaceSessionReloadDraftError,
  shouldDebounceWorkspaceSessionReload,
} from "../src/lib/workspaceSessionReloadPlan.js";

test("reload session debounce prevents duplicate calls within debounce window", () => {
  const t0 = 10000;
  assert.equal(shouldDebounceWorkspaceSessionReload(t0, t0 + 500), true);
  assert.equal(shouldDebounceWorkspaceSessionReload(t0, t0 + 1199), true);
  assert.equal(shouldDebounceWorkspaceSessionReload(t0, t0 + 1201), false);
  assert.equal(shouldDebounceWorkspaceSessionReload(t0, t0 + 2000), false);
  assert.equal(shouldDebounceWorkspaceSessionReload(null, t0), false);
});

test("reload session draft error builds structured error with retry reason", () => {
  const err = new Error("Failed to restart agent process");
  const draftError = buildWorkspaceSessionReloadDraftError(err, {
    workspacePath: "/home/user/project",
    provider: "zcode",
  });

  assert.ok(draftError);
  assert.equal(draftError.code, "WORKSPACE_PREPARE_FAILED");
  assert.equal(
    draftError.detail,
    "workspace=/home/user/project provider=zcode reason=reload-session attempt=1/1",
  );
  assert.ok(draftError.message.includes("Failed to restart agent process"));
});
