import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

interface RemoteConnectionDialogSnapshot {
  currentStep: RemoteWizardStep;
  loading: boolean;
  connectedSessionId: string | null;
}

type RemoteConnectionCompletionStatus = "success" | "error";

interface RemoteConnectionCompletionDialogState {
  open: boolean;
  step: RemoteWizardStep;
}

interface RemoteConnectionDirectoryFailureState {
  connectedSessionId: string | null;
  step: RemoteWizardStep;
}

export interface RemoteConnectionGenerationState {
  activeGeneration: number;
}

export function createRemoteConnectionGenerationState(): RemoteConnectionGenerationState {
  return { activeGeneration: 0 };
}

export function bumpRemoteConnectionGeneration(state: RemoteConnectionGenerationState): number {
  state.activeGeneration += 1;
  return state.activeGeneration;
}

export function isCurrentRemoteConnectionGeneration(
  state: RemoteConnectionGenerationState,
  generation: number,
): boolean {
  return generation > 0 && state.activeGeneration === generation;
}

export function isRemoteConnectionFlowActive(snapshot: RemoteConnectionDialogSnapshot): boolean {
  return snapshot.loading || Boolean(snapshot.connectedSessionId);
}

export function shouldResetRemoteConnectionOnOpen(
  snapshot: RemoteConnectionDialogSnapshot,
): boolean {
  return !isRemoteConnectionFlowActive(snapshot);
}

export function getRemoteConnectionCompletionDialogState(
  status: RemoteConnectionCompletionStatus,
): RemoteConnectionCompletionDialogState {
  return {
    // 远程连接弹窗收起后，连接完成只更新内部步骤但没有重新展示弹窗，
    // 用户会停留在其它页面且看不到选目录或失败原因。连接完成后统一拉起弹窗到结果步骤。
    open: true,
    step: status === "success" ? "directory" : "connecting",
  };
}

export function getRemoteConnectionDirectoryFailureState(params: {
  connectedSessionId: string;
  sessionStillRegistered: boolean;
}): RemoteConnectionDirectoryFailureState {
  if (params.sessionStillRegistered) {
    return {
      connectedSessionId: params.connectedSessionId,
      step: "directory",
    };
  }

  // workspace 初始化失败会回收未确认 logical session。
  // 目录步骤继续持有旧 sessionId 时只能拿到空 services，并永久显示“加载中”。
  return {
    connectedSessionId: null,
    step: "settings",
  };
}

export interface RemoteConnectionUnmountCleanupParams {
  generationState: RemoteConnectionGenerationState;
  pendingRequestId?: string | null;
  connectedSessionId?: string | null;
  isSessionBound: boolean;
  cancelPendingRequest?: (requestId: string) => Promise<void> | void;
  cancelSession?: (sessionId: string) => Promise<void> | void;
  onFlowActiveChange?: (active: boolean) => void;
  onFlowRequestIdChange?: (requestId: string | null) => void;
  wasFlowActive?: boolean;
}

/**
 * 远程连接向导卸载清理：
 * 弹窗为 pending 请求及尚未转交工作区的会话的唯一所有者。
 * 卸载时递增 generation 使异步回调失效、中止确切的 pending 请求并释放未绑定会话；
 * 成功选择目录并转交所有权后绝不释放工作区会话。
 */
export function cleanupRemoteConnectionDialogOnUnmount(
  params: RemoteConnectionUnmountCleanupParams,
): void {
  // 卸载时递增代数，使迟到的异步连接结果无法覆盖已卸载组件或泄漏新会话
  bumpRemoteConnectionGeneration(params.generationState);

  // 中止确切的进行中连接请求，防止后台进程与网络资源挂起
  if (params.pendingRequestId) {
    try {
      void params.cancelPendingRequest?.(params.pendingRequestId);
    } catch {
      // 卸载阶段异常做防御性静默，确保后续清理逻辑顺利执行
    }
  }

  // 弹窗仅在会话尚未转交工作区时拥有生命周期管理权；已绑定工作区会话绝不能释放
  if (params.connectedSessionId && !params.isSessionBound) {
    try {
      void params.cancelSession?.(params.connectedSessionId);
    } catch {
      // 卸载阶段异常防御
    }
  }

  // 流程结束，重置父组件流转指示器
  if (params.wasFlowActive || params.onFlowActiveChange) {
    params.onFlowActiveChange?.(false);
  }
  if (params.pendingRequestId || params.onFlowRequestIdChange) {
    params.onFlowRequestIdChange?.(null);
  }
}
