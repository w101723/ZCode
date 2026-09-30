import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { ServiceCollection } from "@zcode/services";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import WebSocket from "ws";
import { createHttpServer } from "../src/http.js";

function getBaseUrl(server: ReturnType<typeof createHttpServer>): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

function getWsUrl(server: ReturnType<typeof createHttpServer>, path = "/ws"): string {
  const addr = server.address() as AddressInfo;
  return `ws://127.0.0.1:${addr.port}${path}`;
}

async function connectWs(
  url: string,
  options: WebSocket.ClientOptions = {},
): Promise<{ socket: WebSocket; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WebSocket connection timeout: ${url}`));
    }, 5000);

    socket.once("open", () => {
      clearTimeout(timer);
      resolve({
        socket,
        close: () => socket.close(),
      });
    });

    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    socket.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected HTTP response: ${res.statusCode} ${res.statusMessage}`));
    });
  });
}

test("GET /api/server-info is public metadata without credentials", async () => {
  const services = new ServiceCollection();
  const server = createHttpServer(services, 0, {
    authToken: "secret-token",
    authRequired: true,
    allowedWebOrigins: ["https://web.zcode.app"],
  });

  try {
    const res = await fetch(`${getBaseUrl(server)}/api/server-info`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data["authRequired"], true);
    assert.equal(data["protocolVersion"], 1);

    // With allowed origin: returns explicit CORS header
    const corsRes = await fetch(`${getBaseUrl(server)}/api/server-info`, {
      headers: { Origin: "https://web.zcode.app" },
    });
    assert.equal(corsRes.status, 200);
    assert.equal(corsRes.headers.get("access-control-allow-origin"), "https://web.zcode.app");

    // Preflight OPTIONS returns 204 or 200 with explicit allow origin
    const preflight = await fetch(`${getBaseUrl(server)}/api/server-info`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://web.zcode.app",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(preflight.status === 200 || preflight.status === 204, true);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://web.zcode.app");
  } finally {
    server.close();
  }
});

test("POST /api/rpc-host-capability protects against browser origins and requires auth when configured", async () => {
  const services = new ServiceCollection();
  const server = createHttpServer(services, 0, {
    authToken: "secret-token",
  });

  try {
    // 1. Browser origin escalation attempt is forbidden
    const browserRes = await fetch(`${getBaseUrl(server)}/api/rpc-host-capability`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example.com",
        Authorization: "Bearer secret-token",
      },
    });
    assert.equal(browserRes.status, 403);

    // 2. Cookie/URL token alone cannot be used to mint a trusted-host capability.
    const cookieRes = await fetch(
      `${getBaseUrl(server)}/api/rpc-host-capability?token=secret-token`,
      {
        method: "POST",
        headers: { Cookie: "zcode_lite_token=secret-token" },
      },
    );
    assert.equal(cookieRes.status, 401);

    // 3. Unauthenticated desktop request is rejected
    const unauthRes = await fetch(`${getBaseUrl(server)}/api/rpc-host-capability`, {
      method: "POST",
    });
    assert.equal(unauthRes.status, 401);

    // 3. Authenticated desktop request succeeds
    const okRes = await fetch(`${getBaseUrl(server)}/api/rpc-host-capability`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
      },
    });
    assert.equal(okRes.status, 200);
    const body = (await okRes.json()) as { capability: string; expiresAt: number };
    assert.equal(typeof body.capability, "string");
    assert.equal(typeof body.expiresAt, "number");

    // 4. Connecting to /ws/host with Origin header is forbidden
    await assert.rejects(
      () =>
        connectWs(getWsUrl(server, "/ws/host"), {
          headers: {
            Origin: "https://browser.example.com",
            [ZCODE_RPC_HOST_CAPABILITY_HEADER]: body.capability,
          },
        }),
      /403/,
    );

    // 5. Connecting without Origin and with capability succeeds
    const hostConn = await connectWs(getWsUrl(server, "/ws/host"), {
      headers: {
        [ZCODE_RPC_HOST_CAPABILITY_HEADER]: body.capability,
      },
    });
    hostConn.close();

    // 6. Capability is one-time use; replay is rejected
    await assert.rejects(
      () =>
        connectWs(getWsUrl(server, "/ws/host"), {
          headers: {
            [ZCODE_RPC_HOST_CAPABILITY_HEADER]: body.capability,
          },
        }),
      /401/,
    );
  } finally {
    server.close();
  }
});

test("POST /api/rpc-web-ticket and /ws?ticket= flow with CORS and origin validation", async () => {
  const services = new ServiceCollection();
  const server = createHttpServer(services, 0, {
    authToken: "my-auth-token",
    allowedWebOrigins: ["https://trusted-web.app", "http://localhost:5173"],
  });

  try {
    // 1. Missing Origin header is rejected
    const noOrigin = await fetch(`${getBaseUrl(server)}/api/rpc-web-ticket`, {
      method: "POST",
      headers: { Authorization: "Bearer my-auth-token" },
    });
    assert.equal(noOrigin.status >= 400, true);

    // 2. Disallowed Origin is rejected with 403
    const badOrigin = await fetch(`${getBaseUrl(server)}/api/rpc-web-ticket`, {
      method: "POST",
      headers: {
        Origin: "https://malicious.site",
        Authorization: "Bearer my-auth-token",
      },
    });
    assert.equal(badOrigin.status, 403);

    // 3. CORS preflight OPTIONS returns explicit allowed origin
    const preflight = await fetch(`${getBaseUrl(server)}/api/rpc-web-ticket`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://trusted-web.app",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(preflight.status === 200 || preflight.status === 204, true);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://trusted-web.app");

    // 4. Invalid Bearer token is rejected with 401
    const invalidAuth = await fetch(`${getBaseUrl(server)}/api/rpc-web-ticket`, {
      method: "POST",
      headers: {
        Origin: "https://trusted-web.app",
        Authorization: "Bearer wrong-token",
      },
    });
    assert.equal(invalidAuth.status, 401);
    const invalidText = await invalidAuth.text();
    assert.equal(invalidText.includes("my-auth-token"), false, "Must not echo secret");

    // 5. Valid Bearer token + allowed Origin issues ticket
    const ticketRes = await fetch(`${getBaseUrl(server)}/api/rpc-web-ticket`, {
      method: "POST",
      headers: {
        Origin: "https://trusted-web.app",
        Authorization: "Bearer my-auth-token",
      },
    });
    assert.equal(ticketRes.status, 200);
    assert.equal(ticketRes.headers.get("access-control-allow-origin"), "https://trusted-web.app");
    const { ticket, expiresAt } = (await ticketRes.json()) as { ticket: string; expiresAt: number };
    assert.equal(typeof ticket, "string");
    assert.equal(typeof expiresAt, "number");

    // 6. Connect /ws?ticket= with matching Origin succeeds
    const wsConn = await connectWs(getWsUrl(server, `/ws?ticket=${encodeURIComponent(ticket)}`), {
      headers: { Origin: "https://trusted-web.app" },
    });
    wsConn.close();

    // 7. Ticket is one-time use; reuse fails
    await assert.rejects(
      () =>
        connectWs(getWsUrl(server, `/ws?ticket=${encodeURIComponent(ticket)}`), {
          headers: { Origin: "https://trusted-web.app" },
        }),
      /401|403/,
    );

    // 8. Ticket issued for Origin A cannot be used by Origin B
    const ticketRes2 = await fetch(`${getBaseUrl(server)}/api/rpc-web-ticket`, {
      method: "POST",
      headers: {
        Origin: "https://trusted-web.app",
        Authorization: "Bearer my-auth-token",
      },
    });
    const { ticket: ticket2 } = (await ticketRes2.json()) as { ticket: string };
    await assert.rejects(
      () =>
        connectWs(getWsUrl(server, `/ws?ticket=${encodeURIComponent(ticket2)}`), {
          headers: { Origin: "http://localhost:5173" },
        }),
      /401|403/,
    );

    // 9. Origin-bound ticket cannot be consumed by a client omitting Origin.
    const ticketRes3 = await fetch(`${getBaseUrl(server)}/api/rpc-web-ticket`, {
      method: "POST",
      headers: { Origin: "https://trusted-web.app", Authorization: "Bearer my-auth-token" },
    });
    const { ticket: ticket3 } = (await ticketRes3.json()) as { ticket: string };
    await assert.rejects(
      () => connectWs(getWsUrl(server, `/ws?ticket=${encodeURIComponent(ticket3)}`)),
      /401|403/,
    );

    // 10. Cross-origin connection with long-term ?token= is rejected
    await assert.rejects(
      () =>
        connectWs(getWsUrl(server, `/ws?token=my-auth-token`), {
          headers: { Origin: "https://trusted-web.app" },
        }),
      /401|403/,
    );

    // 10. Cross-origin connection with cookie is rejected
    await assert.rejects(
      () =>
        connectWs(getWsUrl(server, "/ws"), {
          headers: {
            Origin: "https://trusted-web.app",
            Cookie: "zcode_lite_token=my-auth-token",
          },
        }),
      /401|403/,
    );
  } finally {
    server.close();
  }
});

test("Existing same-origin cookie works, but long-term WebSocket URL tokens are rejected", async () => {
  const services = new ServiceCollection();
  const server = createHttpServer(services, 0, {
    authToken: "my-auth-token",
  });

  try {
    // 1. Same-origin (or no Origin) with valid cookie connects to /ws
    const wsConn = await connectWs(getWsUrl(server, "/ws"), {
      headers: {
        Cookie: "zcode_lite_token=my-auth-token",
      },
    });
    wsConn.close();

    // 长期凭据不能经 URL 传输；桌面客户端使用一次性 /ws/host capability。
    await assert.rejects(() => connectWs(getWsUrl(server, "/ws?token=my-auth-token")), /401/);
  } finally {
    server.close();
  }
});

test("Production HTTPS enforced for non-loopback authentication", async () => {
  const services = new ServiceCollection();
  const server = createHttpServer(services, 0, {
    host: "0.0.0.0",
    authToken: "my-auth-token",
    allowedWebOrigins: ["https://trusted-web.app"],
  });

  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
  try {
    // Request with non-loopback Host header over HTTP carrying Bearer token must be rejected
    const res = await fetch(`${getBaseUrl(server)}/api/rpc-web-ticket`, {
      method: "POST",
      headers: {
        Host: "remote.example.com:3030",
        "X-Forwarded-Host": "remote.example.com:3030",
        Origin: "https://trusted-web.app",
        Authorization: "Bearer my-auth-token",
      },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /HTTPS/i);

    // 未声明可信代理时，伪造的转发头不能把明文请求升级成安全传输。
    const forwardedRes = await fetch(`${getBaseUrl(server)}/api/rpc-web-ticket`, {
      method: "POST",
      headers: {
        Host: "remote.example.com:3030",
        "X-Forwarded-Host": "remote.example.com:3030",
        "X-Forwarded-Proto": "https",
        Origin: "https://trusted-web.app",
        Authorization: "Bearer my-auth-token",
      },
    });
    assert.equal(forwardedRes.status, 403);
  } finally {
    server.close();
  }
});
