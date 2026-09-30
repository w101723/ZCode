import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
  signal?: AbortSignal;
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new Error("WebSocket connection cancelled"));
      return;
    }
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const onAbort = () => {
      ws.close();
      if (!settled) {
        settled = true;
        reject(new Error("WebSocket connection cancelled"));
      }
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        // 一次性连接票据位于握手 URL，错误对象也可能进入 UI 日志，不能原样带出查询串。
        reject(
          new Error(
            `WebSocket connection failed: ${new URL(wsUrl).origin}${new URL(wsUrl).pathname}`,
          ),
        );
      }
    });
    ws.addEventListener("close", (event) => {
      options?.signal?.removeEventListener("abort", onAbort);
      options?.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (!settled) {
        settled = true;
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
    });

    ws.addEventListener("open", () => {
      if (options?.signal?.aborted) {
        ws.close();
        return;
      }
      settled = true;
      options?.signal?.removeEventListener("abort", onAbort);
      options?.onOpenSocket?.(ws);
      const socket = wrapBrowserWebSocket(ws);
      resolve(connectViaProtocol(new SocketProtocol(socket)));
    });
  });
}

export function connectViaProtocol(protocol: IMessagePassingProtocol): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client);
}
