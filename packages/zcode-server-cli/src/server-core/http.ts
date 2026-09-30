import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  createZCodeAgentConnectionScope,
  IZCodeAgentService,
  ServiceCollection,
} from "@zcode/services";
import { createServiceLogger } from "@zcode/services/node";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
} from "@zcode/shared";
import {
  createHostCapabilityStore,
  createWebTicketStore,
  type HostCapabilityStore,
  type WebTicketStore,
} from "./hostCapability.js";
import type { Context } from "hono";

interface CoreHttpServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

const WEBSOCKET_DRAIN_TIMEOUT_MS = 250;
const log = createServiceLogger("server-core");

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    // HTTP server.close() 不会收敛已经 upgrade 的 WebSocket，活跃 desktop
    // continuous 连接会让 Core 的 shutdown ack 永远发不出去。先发 close frame 给正常
    // 客户端一个短暂排空窗口，再 terminate 兜底，保证 Supervisor 能在预算内释放资源。
    client.close(1001, "Server shutting down");
  }
  const deadline = Date.now() + WEBSOCKET_DRAIN_TIMEOUT_MS;
  while (wss.clients.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    wss.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function parseAllowedOrigins(value: string | undefined | string[]): string[] {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : value.split(",");
  return entries
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0 && origin !== "*");
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  return allowedOrigins.includes(normalized);
}

function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]?.trim() : undefined;
}

function isCrossOriginRequest(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) {
    return false;
  }
  try {
    const originUrl = new URL(origin);
    const hostHeader = c.req.header("host") || new URL(c.req.url).host;
    if (!hostHeader) {
      return true;
    }
    return originUrl.host.toLowerCase() !== hostHeader.toLowerCase();
  } catch {
    return true;
  }
}

function wrapWebSocket(ws: WebSocket): ISocket {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  return {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
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

function exposeWebSocket(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
): void {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  const server = new LoggingChannelServer(rawServer, (...args) => log.debug(undefined, ...args));
  const agentService = services.getOptional(IZCodeAgentService);
  const scope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-core-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  services.exposeOnChannelServer(
    server,
    scope ? new Map([[IZCodeAgentService.channelName, scope.service]]) : new Map(),
  );
  socket.onClose(() => {
    void scope?.dispose();
    rawServer.dispose();
  });
}

export async function createCoreHttpServer(
  services: ServiceCollection,
  options: {
    host?: string;
    port?: number;
    serverId?: string;
    authToken?: string;
    allowedWebOrigins?: string[];
    hostCapabilityStore?: HostCapabilityStore;
    webTicketStore?: WebTicketStore;
  } = {},
): Promise<CoreHttpServer> {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    // 当前只有本机/SSH 隧道入口，对外监听必须 fail-closed
    throw new Error(
      `Non-loopback host ${host} requires authentication before the server can listen`,
    );
  }

  const authToken =
    options.authToken?.trim() ||
    process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() ||
    process.env["ZCODE_SERVER_TOKEN"]?.trim();
  const allowedOrigins = Array.from(
    new Set([
      ...parseAllowedOrigins(options.allowedWebOrigins),
      ...parseAllowedOrigins(process.env["ZCODE_SERVER_ALLOWED_WEB_ORIGINS"]),
    ]),
  );

  const info: ServerRemoteInfo = {
    serverId: options.serverId ?? hostname() ?? "zcode-server",
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: Boolean(authToken),
    workspaces: [],
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };

  const capabilities = options.hostCapabilityStore ?? createHostCapabilityStore();
  const webTickets = options.webTicketStore ?? createWebTicketStore();

  // 1. CORS 与预检中间件
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && isOriginAllowed(origin, allowedOrigins)) {
      c.header("Access-Control-Allow-Origin", normalizeOrigin(origin));
      c.header("Vary", "Origin");
    }
    if (c.req.method === "OPTIONS") {
      if (!origin || !isOriginAllowed(origin, allowedOrigins)) {
        return c.json({ error: "Origin not allowed" }, 403);
      }
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Origin, x-zcode-rpc-host-capability",
      );
      c.header("Access-Control-Max-Age", "86400");
      return c.body(null, 204);
    }
    await next();
  });

  // 2. GET /api/server-info 公开元数据
  app.get("/api/server-info", (context) => context.json(info));

  // 3. POST /api/rpc-web-ticket
  app.post("/api/rpc-web-ticket", (context) => {
    const origin = context.req.header("origin");
    if (!origin) {
      return context.json({ error: "Origin header is required" }, 400);
    }
    if (!isOriginAllowed(origin, allowedOrigins)) {
      return context.json({ error: "Origin not allowed" }, 403);
    }
    if (authToken) {
      const bearerToken = extractBearerToken(context.req.header("authorization"));
      if (!bearerToken || bearerToken !== authToken) {
        return context.json({ error: "Unauthorized" }, 401);
      }
    } else {
      return context.json({ error: "Server authentication is not configured" }, 403);
    }
    const ticketData = webTickets.issue(normalizeOrigin(origin));
    return context.json(ticketData);
  });

  // 4. POST /api/rpc-host-capability 专供桌面 Node Host 申请
  app.post("/api/rpc-host-capability", (context) => {
    const origin = context.req.header("origin");
    if (origin) {
      return context.json(
        { error: "Browser origins are not permitted to request host capability" },
        403,
      );
    }
    if (authToken) {
      const bearerToken = extractBearerToken(context.req.header("authorization"));
      if (!bearerToken || bearerToken !== authToken) {
        return context.json({ error: "Unauthorized" }, 401);
      }
    }
    return context.json(capabilities.issue());
  });

  // 5. /ws
  app.use("/ws", async (context, next) => {
    const origin = context.req.header("origin");
    const url = new URL(context.req.url);
    const ticketParam = url.searchParams.get("ticket");
    const tokenParam = url.searchParams.get("token");

    const isCross = isCrossOriginRequest(context);
    if (tokenParam) {
      // 长期 Token 不能落入 WebSocket URL；缺失 Origin 的请求也不得消费绑定的票据。
      return context.json({ error: "Long-term tokens are not permitted in WebSocket URLs" }, 401);
    }
    if (ticketParam && !origin) {
      return context.json({ error: "Origin is required for a WebSocket ticket" }, 401);
    }
    if (isCross) {
      if (!isOriginAllowed(origin, allowedOrigins)) {
        return context.json({ error: "Origin not allowed" }, 403);
      }
      if (!ticketParam) {
        return context.json(
          { error: "Ticket is required for cross-origin WebSocket connection" },
          401,
        );
      }
      if (!webTickets.consume(ticketParam, normalizeOrigin(origin!))) {
        return context.json({ error: "Invalid or expired ticket" }, 401);
      }
    } else {
      if (ticketParam) {
        if (!webTickets.consume(ticketParam, origin ? normalizeOrigin(origin) : undefined)) {
          return context.json({ error: "Invalid or expired ticket" }, 401);
        }
      } else if (authToken) {
        const bearerToken = extractBearerToken(context.req.header("authorization"));
        const valid =
          (bearerToken !== undefined && bearerToken === authToken) ||
          url.searchParams.get("token") === authToken;
        if (!valid) {
          return context.json({ error: "Unauthorized" }, 401);
        }
      }
    }
    await next();
  });

  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );

  // 6. /ws/host
  app.use("/ws/host", async (context, next) => {
    const origin = context.req.header("origin");
    if (origin) {
      return context.json({ error: "Browser origins are not permitted to access /ws/host" }, 403);
    }
    const capability = context.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!capabilities.consume(capability)) {
      return context.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get(
    "/ws/host",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "desktop-continuous");
      },
    })),
  );
  let resolveListening: (value: { port: number }) => void = () => undefined;
  const listening = new Promise<{ port: number }>((resolve) => {
    resolveListening = resolve;
  });
  const server = serve({ fetch: app.fetch, hostname: host, port: options.port ?? 0 }, () => {
    const address = server.address();
    resolveListening({
      port: typeof address === "object" && address ? address.port : (options.port ?? 0),
    });
  });
  injectWebSocket(server);
  const { port } = await listening;
  return {
    host,
    port,
    close: async () => {
      await closeWebSocketServer(wss);
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
