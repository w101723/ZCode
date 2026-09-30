import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteWorkspaceSessionMutation,
  createRemoteTargetFromSnapshot,
} from "../src/lib/remoteWorkspaceHistory.js";

test("Server target persists token only via credential service and restores it on reconnect", () => {
  const mutation = buildRemoteWorkspaceSessionMutation({
    remoteSessions: [],
    workspacePath: "/work",
    target: { kind: "server", serverUrl: "https://server.example", token: "secret" },
    lastConnectionStatus: "connected",
    touchOpenedAt: true,
  });
  assert.equal(JSON.stringify(mutation.entry).includes("secret"), false);
  assert.equal(mutation.credentialsToSave.length, 1);
  assert.equal(mutation.credentialsToSave[0]?.value, "secret");
  assert.ok(mutation.entry.workspaceIdentity.startsWith("remote:server:"));
  const restored = createRemoteTargetFromSnapshot(mutation.entry.target, {
    password: null,
    privateKeyPassphrase: null,
    serverToken: "secret",
  });
  assert.equal(restored.kind, "server");
  if (restored.kind === "server") assert.equal(restored.token, "secret");
});

test("Web Server history never creates a credential key or writes a token to the host", () => {
  const mutation = buildRemoteWorkspaceSessionMutation({
    remoteSessions: [],
    workspacePath: "/work",
    target: { kind: "server", serverUrl: "https://server.example", token: "secret" },
    persistServerCredentials: false,
    lastConnectionStatus: "connected",
    touchOpenedAt: true,
  });
  assert.equal(mutation.entry.target.kind, "server");
  if (mutation.entry.target.kind === "server") {
    assert.equal(mutation.entry.target.tokenCredentialKey, undefined);
  }
  assert.deepEqual(mutation.credentialsToSave, []);
  assert.equal(JSON.stringify(mutation.nextRemoteSessions).includes("secret"), false);
});
