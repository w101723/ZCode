import WebSocket from "ws";
import { Emitter, VSBuffer, SocketProtocol, ChannelClient, type ISocket } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  serverRemoteInfoSchema,
  serverRemoteHostCapabilitySchema,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  type ServerConnectOptions,
  type ServerRemoteInfo,
} from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment, StdioStream } from "./backend.js";
import type { RemoteConnection } from "./connect.js";

function wrapNodeWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
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

export function normalizeServerHttpUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Server URL 只允许填写服务地址，不得包含路径、凭据或查询参数");
  }
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("非本地 Server 直连必须使用 HTTPS");
  }
  return url.origin;
}

export function toWebSocketUrl(httpUrl: string, path: string): string {
  const parsed = new URL(httpUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = path;
  parsed.search = "";
  return parsed.toString();
}

export interface ConnectServerRemoteResult extends RemoteConnection {
  backend: IRemoteBackend;
  serverInfo: ServerRemoteInfo;
}

export async function connectServerRemote(options: {
  target: ServerConnectOptions;
  signal?: AbortSignal;
  onDidRemoteClose?: (event: { code: number }) => void;
}): Promise<ConnectServerRemoteResult> {
  const { target, signal, onDidRemoteClose } = options;
  if (signal?.aborted) {
    throw new Error("远程连接已取消");
  }

  const baseUrl = normalizeServerHttpUrl(target.serverUrl);

  // 1. 获取 server-info 并校验协议版本
  const serverInfoUrl = `${baseUrl}/api/server-info`;
  const infoRes = await fetch(serverInfoUrl, {
    method: "GET",
    redirect: "error",
    signal,
  });

  if (!infoRes.ok) {
    throw new Error(`连接 Server 失败: ${infoRes.status} ${infoRes.statusText}`);
  }

  const infoRaw = await infoRes.json();
  const parsedInfo = serverRemoteInfoSchema.safeParse(infoRaw);
  if (!parsedInfo.success) {
    throw new Error(`Server 元数据校验失败: 协议不兼容或返回格式错误`);
  }
  const serverInfo = parsedInfo.data;

  if (serverInfo.protocolVersion !== SERVER_REMOTE_PROTOCOL_VERSION) {
    throw new Error(
      `Server 协议版本不匹配: 本地期望 ${SERVER_REMOTE_PROTOCOL_VERSION}, 远端为 ${serverInfo.protocolVersion}`,
    );
  }

  if (target.serverId && target.serverId !== serverInfo.serverId) {
    throw new Error(`Server ID 不匹配: 期望 ${target.serverId}, 实际为 ${serverInfo.serverId}`);
  }

  if (signal?.aborted) {
    throw new Error("远程连接已取消");
  }

  // 2. POST /api/rpc-host-capability 获取 host capability
  const capabilityUrl = `${baseUrl}/api/rpc-host-capability`;
  const headers: Record<string, string> = {};
  if (target.token?.trim()) {
    headers["Authorization"] = `Bearer ${target.token.trim()}`;
  }

  const capRes = await fetch(capabilityUrl, {
    method: "POST",
    headers,
    redirect: "error",
    signal,
  });

  if (!capRes.ok) {
    throw new Error(`获取 Server Host Capability 失败 (${capRes.status})`);
  }

  const capRaw = await capRes.json();
  const parsedCap = serverRemoteHostCapabilitySchema.safeParse(capRaw);
  if (!parsedCap.success) {
    throw new Error("Server 返回的 Host Capability 格式错误");
  }
  const { capability } = parsedCap.data;

  if (signal?.aborted) {
    throw new Error("远程连接已取消");
  }

  // 3. WebSocket 握手连接 /ws/host
  const wsUrl = toWebSocketUrl(baseUrl, "/ws/host");
  const ws = new WebSocket(wsUrl, {
    headers: {
      [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability,
    },
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const rejectConnection = (error: Error) => {
      if (settled) return;
      settled = true;
      ws.off("open", onOpen);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onOpen = () => {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      rejectConnection(err);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      rejectConnection(new Error(`WebSocket 连接关闭 (${code}): ${reason.toString()}`));
    };
    const onAbort = () => {
      rejectConnection(new Error("远程连接已取消"));
      // CONNECTING 时 close 会异步发出 error；保留 error/close 监听至关闭完成，避免取消升级为 Host 致命异常。
      try {
        ws.close();
      } catch {}
    };

    function cleanup() {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    }

    ws.on("open", onOpen);
    ws.on("error", onError);
    ws.on("close", onClose);
    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) onAbort();
  });

  let hasReportedClose = false;
  const reportClose = (code: number) => {
    if (hasReportedClose) return;
    hasReportedClose = true;
    onDidRemoteClose?.({ code });
  };

  ws.on("close", (code) => {
    reportClose(code);
  });

  const socket = wrapNodeWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  const services = new RemoteServiceAccess(client);

  const dummyBackend: IRemoteBackend = {
    detect: async (): Promise<RemoteEnvironment> => ({
      platform: "linux",
      arch: "x64",
    }),
    upload: async () => {
      throw new Error("Server 直连模式暂不支持直接文件上传");
    },
    exec: async (): Promise<StdioStream> => {
      throw new Error("Server 直连模式不提供底层 shell exec");
    },
    exists: async () => false,
    readFile: async () => "",
    dispose: () => {
      try {
        ws.close();
      } catch {}
    },
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    client.dispose();
    protocol.dispose();
    socket.dispose();
    try {
      ws.close();
    } catch {}
  };

  return {
    services,
    client,
    backend: dummyBackend,
    serverInfo,
    dispose,
    disposeAndWait: async () => {
      dispose();
    },
  };
}
