import { serverRemoteInfoSchema, type ServerRemoteInfo } from "@zcode/shared";

export interface WebServerRemoteConnection {
  info: ServerRemoteInfo;
  wsUrl: string;
}

function normalizeServerUrl(input: string): URL {
  const url = new URL(input);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Server URL must contain only an origin");
  }
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("A remote Server requires HTTPS");
  }
  return url;
}

export async function requestWebServerConnection(
  serverUrl: string,
  token: string,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
  expectedServerId?: string,
): Promise<WebServerRemoteConnection> {
  const base = normalizeServerUrl(serverUrl);
  const infoResponse = await request(new URL("/api/server-info", base), {
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!infoResponse.ok) throw new Error(`Server metadata request failed (${infoResponse.status})`);
  const info = serverRemoteInfoSchema.parse(await infoResponse.json());
  // 历史 URL 可能已指向另一台 Server；发送 Token 前校验身份，不能等票据返回后再拒绝。
  if (expectedServerId && expectedServerId !== info.serverId) {
    throw new Error("Server identity does not match the saved target");
  }
  const ticketResponse = await request(new URL("/api/rpc-web-ticket", base), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!ticketResponse.ok)
    throw new Error(`Server ticket request failed (${ticketResponse.status})`);
  const ticketData: unknown = await ticketResponse.json();
  if (
    !ticketData ||
    typeof ticketData !== "object" ||
    !("ticket" in ticketData) ||
    typeof ticketData.ticket !== "string" ||
    !ticketData.ticket
  ) {
    throw new Error("Server returned an invalid Web connection ticket");
  }
  const wsUrl = new URL("/ws", base);
  wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("ticket", ticketData.ticket);
  return { info, wsUrl: wsUrl.toString() };
}
