import assert from "node:assert/strict";
import test from "node:test";
import { buildAvailableKinds } from "../src/hooks/useRemoteConnectionForm.js";

test("Web remote wizard only offers the Server kind", () => {
  assert.deepEqual(buildAvailableKinds({ isWindowsDesktop: false, supportedKinds: ["server"] }), [
    "server",
  ]);
});

test("Desktop remote wizard retains the supported connection kinds", () => {
  assert.deepEqual(buildAvailableKinds({ isWindowsDesktop: false }), ["ssh", "docker", "server"]);
  assert.deepEqual(buildAvailableKinds({ isWindowsDesktop: true }), [
    "ssh",
    "wsl",
    "docker",
    "server",
  ]);
});
