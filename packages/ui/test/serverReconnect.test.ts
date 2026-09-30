import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceSessionMutation } from "../src/lib/remoteWorkspaceHistory.js";
import { reconnectRemoteWorkspaceHistoryEntry } from "../src/root/reconnectRemoteWorkspaceHistoryEntry.js";
import {
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "../src/store/remoteWorkspaceSessionStore.js";
import { createTabStore } from "../src/store/tabStore.js";
import type { IServiceAccessor } from "@zcode/services";

test("Web reconnect uses a transient Token without loading or saving remote credentials", async () => {
  const initial = buildRemoteWorkspaceSessionMutation({
    remoteSessions: [],
    workspacePath: "/work",
    target: { kind: "server", serverUrl: "https://server.example", serverId: "srv-alpha" },
    lastConnectionStatus: "connected",
    touchOpenedAt: true,
  });
  let suppliedToken: string | undefined;
  await reconnectRemoteWorkspaceHistoryEntry({
    sessionEntry: initial.entry,
    persistServerCredentials: false,
    activateTabByPath: () => false,
    setReconnectingRemoteWorkspaceKeys: () => {},
    loadCredential: async () => {
      throw new Error("Web must not call host credential service");
    },
    connectRemoteWorkspaceTarget: async (target) => {
      assert.equal(target.kind, "server");
      if (target.kind === "server") suppliedToken = target.token;
      throw new Error("fixture stops after credential admission");
    },
    resolveRemoteWorkspaceCanonicalPath: async (_, path) => path,
    disposeRemoteWorkspaceSession: async () => {},
    bindRemoteWorkspaceSessionContext: async () => {},
    bindRemoteWorkspacePath: () => {},
    bindRemoteWorkspaceIdentity: () => {},
    upsertWorkspaceTab: () => {},
    commitRemoteWorkspaceSessionMutation: async (mutation) => {
      assert.deepEqual(mutation.credentialsToSave, []);
      assert.equal(JSON.stringify(mutation.entry).includes("ephemeral-secret"), false);
      return mutation.entry;
    },
    getRemoteSessions: () => [initial.entry],
    logger: { warn: () => {} },
    toast: () => {},
    options: { serverTokenOverride: "ephemeral-secret", showErrorToast: false },
  });
  assert.equal(suppliedToken, "ephemeral-secret");
});

test("Legacy server history upgrades the validated identity without duplicate history or tabs", async () => {
  // 模拟遗留历史记录：target 没有 serverId，但历史条目拥有基于 URL 的 fallback identity
  const legacyEntry = {
    kind: "remote" as const,
    workspacePath: "/work",
    workspaceIdentity: "remote:server:server.example:/work",
    target: {
      kind: "server" as const,
      serverUrl: "https://server.example",
      tokenCredentialKey: "token-key",
    },
    lastOpenedAt: 1000,
    lastConnectionStatus: "connected" as const,
  };

  let connectedContext: { workspacePath?: string; workspaceIdentity?: string } | undefined;
  let savedMutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation> | undefined;
  const tabStore = createTabStore(null);
  const tabId = tabStore.getState().addTab("/work", {
    workspaceIdentity: legacyEntry.workspaceIdentity,
    remoteTarget: legacyEntry.target,
  });
  const siblingId = tabStore.getState().ensureWorkspaceTab("/work", {
    workspaceIdentity: "remote:server:sibling:/work",
    remoteTarget: { kind: "server", serverUrl: "https://sibling.example", serverId: "sibling" },
  });
  registerRemoteWorkspaceSession({
    sessionId: "sess-new",
    target: { kind: "server", serverUrl: "https://server.example", serverId: "srv-real" },
    services: {
      zcodeTaskService: {
        listPinnedTasks: async () => [],
        listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
      },
    } as unknown as IServiceAccessor,
  });
  try {
    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry: legacyEntry,
      persistServerCredentials: true,
      activateTabByPath: tabStore.getState().activateTabByPath,
      setReconnectingRemoteWorkspaceKeys: () => {},
      loadCredential: async () => "saved-token",
      connectRemoteWorkspaceTarget: async (_target, _requestId, context) => {
        connectedContext = context;
        return "sess-new";
      },
      resolveRemoteWorkspaceCanonicalPath: async () => "/canonical/work",
      disposeRemoteWorkspaceSession: async () => {
        assert.fail("retained workspace must not be disposed");
      },
      bindRemoteWorkspaceSessionContext: async ({ workspaceIdentity }) => {
        assert.equal(workspaceIdentity, "remote:server:srv-real:/canonical/work");
      },
      bindRemoteWorkspacePath: () => {},
      bindRemoteWorkspaceIdentity: () => {},
      shouldKeepReconnectedWorkspace: ({ workspaceIdentity }) =>
        workspaceIdentity === legacyEntry.workspaceIdentity,
      upsertWorkspaceTab: tabStore.getState().ensureWorkspaceTab,
      commitRemoteWorkspaceSessionMutation: async (mutation) => {
        savedMutation = mutation;
        return mutation.entry;
      },
      getRemoteSessions: () => [legacyEntry],
      logger: { warn: () => {} },
      toast: () => {},
      options: { throwOnFailure: true },
    });
    assert.equal(connectedContext?.workspaceIdentity, undefined);
    assert.ok(savedMutation);
    assert.equal(savedMutation.entry.workspaceIdentity, "remote:server:srv-real:/canonical/work");
    assert.equal(
      savedMutation.entry.target.kind === "server" && savedMutation.entry.target.serverId,
      "srv-real",
    );
    assert.equal(savedMutation.nextRemoteSessions.length, 1);
    assert.deepEqual(savedMutation.credentialKeysToDelete, []);
    assert.equal(
      savedMutation.entry.target.kind === "server" && savedMutation.entry.target.tokenCredentialKey,
      "token-key",
    );
    const state = tabStore.getState();
    assert.equal(state.tabs.length, 2);
    assert.equal(state.activeTabId, tabId);
    assert.equal(state.activeWorkspaceIdentity, "remote:server:srv-real:/canonical/work");
    assert.ok(state.tabs.some((tab) => tab.id === siblingId));
    assert.equal(state.tabs.find((tab) => tab.id === tabId)?.workspacePath, "/canonical/work");
  } finally {
    unregisterRemoteWorkspaceSession("sess-new");
  }
});
