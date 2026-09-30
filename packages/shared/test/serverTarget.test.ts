import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  stripRemoteTargetSecrets,
  buildRemoteEnvironmentKey,
  remoteTargetSchema,
  serverConnectOptionsSchema,
  type ServerConnectOptions,
} from "../src/index.js";

test("server remote target schema and validation", () => {
  const validTarget: ServerConnectOptions = {
    kind: "server",
    serverUrl: "http://127.0.0.1:3030",
    name: "Local Test Server",
    token: "secret-token-123",
    serverId: "srv-001",
  };

  const parsed = serverConnectOptionsSchema.safeParse(validTarget);
  assert.equal(parsed.success, true);

  const parsedUnion = remoteTargetSchema.safeParse(validTarget);
  assert.equal(parsedUnion.success, true);

  const invalidTarget = {
    kind: "server",
    serverUrl: "",
  };
  assert.equal(serverConnectOptionsSchema.safeParse(invalidTarget).success, false);
});

test("stripRemoteTargetSecrets removes token but preserves other fields", () => {
  const target: ServerConnectOptions = {
    kind: "server",
    serverUrl: "http://127.0.0.1:3030",
    token: "super-secret-token",
    name: "My Server",
    serverId: "srv-123",
    tokenCredentialKey: "cred-key-abc",
  };

  const stripped = stripRemoteTargetSecrets(target) as ServerConnectOptions;
  assert.equal(stripped.token, undefined);
  assert.equal(stripped.serverUrl, "http://127.0.0.1:3030");
  assert.equal(stripped.name, "My Server");
  assert.equal(stripped.serverId, "srv-123");
  assert.equal(stripped.tokenCredentialKey, "cred-key-abc");
});

test("server remote workspace identity and environment key", () => {
  const target: ServerConnectOptions = {
    kind: "server",
    serverUrl: "http://localhost:3030",
    serverId: "node-cluster-a",
  };

  const identity = buildRemoteWorkspaceIdentity("/home/user/project", target);
  assert.equal(identity, "remote:server:node-cluster-a:/home/user/project");

  const parsed = parseRemoteWorkspaceIdentity(identity);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.kind, "server");
  assert.equal(parsed?.workspacePath, "/home/user/project");

  const envKey = buildRemoteEnvironmentKey(target);
  assert.equal(envKey, "server:node-cluster-a");
});
