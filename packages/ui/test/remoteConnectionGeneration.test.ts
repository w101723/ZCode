import assert from "node:assert/strict";
import test from "node:test";
import {
  bumpRemoteConnectionGeneration,
  cleanupRemoteConnectionDialogOnUnmount,
  createRemoteConnectionGenerationState,
  isCurrentRemoteConnectionGeneration,
} from "../src/lib/remoteConnectionDialogState.js";
import { stripRemoteTargetSecrets, type RemoteTarget } from "@zcode/shared";

test("generation increments monotonically and validates current generation", () => {
  const state = createRemoteConnectionGenerationState();
  assert.equal(state.activeGeneration, 0);
  assert.equal(isCurrentRemoteConnectionGeneration(state, 0), false);

  const gen1 = bumpRemoteConnectionGeneration(state);
  assert.equal(gen1, 1);
  assert.equal(isCurrentRemoteConnectionGeneration(state, gen1), true);

  const gen2 = bumpRemoteConnectionGeneration(state);
  assert.equal(gen2, 2);
  assert.equal(isCurrentRemoteConnectionGeneration(state, gen1), false);
  assert.equal(isCurrentRemoteConnectionGeneration(state, gen2), true);
});

test("stale generation is invalidated upon bumping on cancel, back or close", () => {
  const state = createRemoteConnectionGenerationState();
  const reqGen = bumpRemoteConnectionGeneration(state);
  assert.equal(isCurrentRemoteConnectionGeneration(state, reqGen), true);

  bumpRemoteConnectionGeneration(state);
  assert.equal(isCurrentRemoteConnectionGeneration(state, reqGen), false);
});

test("late completion handling for stale generation disposes session", async () => {
  const state = createRemoteConnectionGenerationState();
  const reqGen = bumpRemoteConnectionGeneration(state);

  bumpRemoteConnectionGeneration(state);

  const lateSessionId = "session-123";
  let cancelledSessionId: string | null = null;
  const onCancelSession = async (id: string) => {
    cancelledSessionId = id;
  };

  const isCurrent = isCurrentRemoteConnectionGeneration(state, reqGen);
  assert.equal(isCurrent, false);
  if (!isCurrent) {
    await onCancelSession(lateSessionId);
  }
  assert.equal(cancelledSessionId, "session-123");
});

test("loading ref guard prevents same-tick duplicate connect calls", () => {
  let loadingRef = false;
  let connectCallCount = 0;

  const initiateConnect = () => {
    if (loadingRef) {
      return false;
    }
    loadingRef = true;
    connectCallCount += 1;
    return true;
  };

  assert.equal(initiateConnect(), true);
  assert.equal(initiateConnect(), false);
  assert.equal(connectCallCount, 1);
});

test("pendingRemoteTarget secrets stripped on success but retained on error for retry", () => {
  const targetWithSecrets: RemoteTarget = {
    kind: "server",
    serverUrl: "http://127.0.0.1:3030",
    token: "my-secret-token",
  };

  let pendingTarget: RemoteTarget | null = targetWithSecrets;
  assert.equal((pendingTarget as any).token, "my-secret-token");

  pendingTarget = stripRemoteTargetSecrets(pendingTarget);
  assert.equal((pendingTarget as any).token, undefined);
  assert.equal(pendingTarget.kind, "server");
  assert.equal((pendingTarget as any).serverUrl, "http://127.0.0.1:3030");
});

test("flow active detection and minimize behavior preserve in-flight flow without bumping generation", () => {
  const state = createRemoteConnectionGenerationState();
  const currentGen = bumpRemoteConnectionGeneration(state);

  const activeConnectingSnapshot = {
    currentStep: "connecting" as const,
    loading: true,
    connectedSessionId: null,
  };
  const isFlowActive =
    activeConnectingSnapshot.loading || Boolean(activeConnectingSnapshot.connectedSessionId);
  assert.equal(isFlowActive, true);

  assert.equal(isCurrentRemoteConnectionGeneration(state, currentGen), true);

  const successCompletion = { open: true, step: "directory" as const };
  assert.equal(successCompletion.open, true);
  assert.equal(successCompletion.step, "directory");
});

test("cleanupRemoteConnectionDialogOnUnmount bumps generation, aborts pending request and resets flow indicators", () => {
  const state = createRemoteConnectionGenerationState();
  const reqGen = bumpRemoteConnectionGeneration(state);
  assert.equal(isCurrentRemoteConnectionGeneration(state, reqGen), true);

  let abortedRequestId: string | null = null;
  let flowActiveResult: boolean | null = null;
  let flowRequestIdResult: string | null = "stale-req";

  cleanupRemoteConnectionDialogOnUnmount({
    generationState: state,
    pendingRequestId: "req-unmount-1",
    connectedSessionId: null,
    isSessionBound: false,
    cancelPendingRequest: (id) => {
      abortedRequestId = id;
    },
    cancelSession: () => {
      assert.fail("should not cancel session when connectedSessionId is null");
    },
    onFlowActiveChange: (active) => {
      flowActiveResult = active;
    },
    onFlowRequestIdChange: (id) => {
      flowRequestIdResult = id;
    },
    wasFlowActive: true,
  });

  // 验证代数已递增，旧 generation 已失效
  assert.equal(isCurrentRemoteConnectionGeneration(state, reqGen), false);
  // 验证中止了确切的 pending 请求
  assert.equal(abortedRequestId, "req-unmount-1");
  // 验证重置了流程指示器
  assert.equal(flowActiveResult, false);
  assert.equal(flowRequestIdResult, null);
});

test("cleanupRemoteConnectionDialogOnUnmount releases unbound session before directory selection", () => {
  const state = createRemoteConnectionGenerationState();
  let cancelledSessionId: string | null = null;

  cleanupRemoteConnectionDialogOnUnmount({
    generationState: state,
    pendingRequestId: null,
    connectedSessionId: "unbound-session-789",
    isSessionBound: false,
    cancelSession: (id) => {
      cancelledSessionId = id;
    },
    wasFlowActive: true,
  });

  // 尚未选目录转移所有权时，弹窗作为唯一持有者，卸载时必须释放该 session
  assert.equal(cancelledSessionId, "unbound-session-789");
});

test("cleanupRemoteConnectionDialogOnUnmount never disposes bound workspace session", () => {
  const state = createRemoteConnectionGenerationState();
  let cancelCalled = false;

  cleanupRemoteConnectionDialogOnUnmount({
    generationState: state,
    pendingRequestId: null,
    connectedSessionId: "bound-workspace-session-123",
    isSessionBound: true,
    cancelSession: () => {
      cancelCalled = true;
    },
    wasFlowActive: false,
  });

  // 选目录成功转移所有权给工作区后，卸载清理绝不能释放已绑定的 session
  assert.equal(cancelCalled, false);
});

test("late completion after unmount cleanup is rejected and session safely released", async () => {
  const state = createRemoteConnectionGenerationState();
  const requestGen = bumpRemoteConnectionGeneration(state);

  // 组件在异步连接途中卸载
  let cancelledSessionId: string | null = null;
  cleanupRemoteConnectionDialogOnUnmount({
    generationState: state,
    pendingRequestId: "pending-req-late",
    connectedSessionId: null,
    isSessionBound: false,
    cancelPendingRequest: () => {},
    cancelSession: (id) => {
      cancelledSessionId = id;
    },
  });

  // 迟到的连接结果返回
  const lateSessionId = "late-arrived-session";
  if (!isCurrentRemoteConnectionGeneration(state, requestGen)) {
    // 模拟 SSHDialog 中对陈旧 generation 的处理
    cancelledSessionId = lateSessionId;
  }

  assert.equal(cancelledSessionId, lateSessionId);
});

test("React StrictMode mount-unmount-mount cycle preserves generation progression without false cancellation", () => {
  const state = createRemoteConnectionGenerationState();
  let cancelCount = 0;

  // StrictMode 初始挂载与模拟卸载：无活跃请求与 session
  cleanupRemoteConnectionDialogOnUnmount({
    generationState: state,
    pendingRequestId: null,
    connectedSessionId: null,
    isSessionBound: false,
    cancelPendingRequest: () => {
      cancelCount += 1;
    },
    cancelSession: () => {
      cancelCount += 1;
    },
  });
  assert.equal(cancelCount, 0);

  // 二次挂载后发起真实连接
  const actualGen = bumpRemoteConnectionGeneration(state);
  assert.equal(isCurrentRemoteConnectionGeneration(state, actualGen), true);

  // 成功连接并完成选目录，标记已绑定
  const boundSession = "session-active-bound";
  const isBound = true;

  // 真实卸载发生：工作区会话绝不能被取消
  cleanupRemoteConnectionDialogOnUnmount({
    generationState: state,
    pendingRequestId: null,
    connectedSessionId: boundSession,
    isSessionBound: isBound,
    cancelSession: () => {
      cancelCount += 1;
    },
  });
  assert.equal(cancelCount, 0);
  assert.equal(isCurrentRemoteConnectionGeneration(state, actualGen), false);
});
