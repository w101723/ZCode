import assert from "node:assert/strict";
import test from "node:test";
import { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";

test("Server identity uses the validated serverId in the descriptor and session", async () => {
  let connectionCount = 0;
  let nextId = 0;
  const registry = createWindowRemoteConnectionRegistry({
    createId: () => `session-${++nextId}`,
    connect: async () => {
      connectionCount++;
      return {
        services: {},
        serverInfo: {
          serverId: "srv-alpha",
          version: "3.14.4",
          protocolVersion: 1 as const,
          authRequired: true,
          workspaces: [],
          capabilities: { desktopContinuous: true as const, websocketRpc: true as const },
        },
        dispose: () => {},
      };
    },
  });
  try {
    const target = {
      kind: "server" as const,
      serverUrl: "https://server.example",
      token: "secret",
    };
    const first = await registry.connect({
      requestId: "first",
      target,
      remoteAssets: {},
      workspacePath: "/work",
    });
    assert.equal(first.target.kind, "server");
    if (first.target.kind === "server") {
      assert.equal(first.target.serverId, "srv-alpha");
      assert.equal(first.target.token, undefined);
    }
    assert.equal(first.workspaceIdentity, "remote:server:srv-alpha:/work");
    assert.equal(
      registry.getSession(first.remoteSessionId)?.workspaceIdentity,
      first.workspaceIdentity,
    );

    const second = await registry.connect({
      requestId: "second",
      target: { ...target, serverId: "srv-alpha" },
      remoteAssets: {},
      workspacePath: "/other",
      workspaceIdentity: "remote:server:srv-alpha:/other",
    });
    assert.equal(connectionCount, 1);
    assert.equal(second.workspaceIdentity, "remote:server:srv-alpha:/other");
  } finally {
    await registry.dispose();
  }
});
