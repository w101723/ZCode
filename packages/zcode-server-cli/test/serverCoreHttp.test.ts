import assert from "node:assert/strict";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import WebSocket from "ws";
import { createCoreHttpServer } from "../src/server-core/http.js";

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

test("Server Core maintains loopback-only check", async () => {
  const services = new ServiceCollection();
  await assert.rejects(
    () => createCoreHttpServer(services, { host: "0.0.0.0" }),
    /Non-loopback host/i,
  );
  await assert.rejects(
    () => createCoreHttpServer(services, { host: "192.168.1.10" }),
    /Non-loopback host/i,
  );
});

test("Server Core protects against browser origin escalation and unauthed cross-origin", async () => {
  const services = new ServiceCollection();
  const server = await createCoreHttpServer(services, {
    host: "127.0.0.1",
    port: 0,
    authToken: "core-token",
    allowedWebOrigins: ["https://console.zcode.app"],
  });

  const baseUrl = `http://${server.host}:${server.port}`;
  const wsUrl = `ws://${server.host}:${server.port}/ws`;

  try {
    // 1. GET /api/server-info is public metadata
    const infoRes = await fetch(`${baseUrl}/api/server-info`);
    assert.equal(infoRes.status, 200);

    // 2. POST /api/rpc-host-capability rejects browser origins
    const hostCapBrowser = await fetch(`${baseUrl}/api/rpc-host-capability`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.site",
        Authorization: "Bearer core-token",
      },
    });
    assert.equal(hostCapBrowser.status, 403);

    // 3. POST /api/rpc-host-capability allows desktop with auth
    const hostCapDesktop = await fetch(`${baseUrl}/api/rpc-host-capability`, {
      method: "POST",
      headers: {
        Authorization: "Bearer core-token",
      },
    });
    assert.equal(hostCapDesktop.status, 200);
    const { capability } = (await hostCapDesktop.json()) as { capability: string };

    // 4. /ws/host rejects browser Origin
    await assert.rejects(
      () =>
        connectWs(`ws://${server.host}:${server.port}/ws/host`, {
          headers: {
            Origin: "https://attacker.site",
            [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability,
          },
        }),
      /403/,
    );

    // 5. POST /api/rpc-web-ticket with disallowed origin is 403
    const badOrigin = await fetch(`${baseUrl}/api/rpc-web-ticket`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.site",
        Authorization: "Bearer core-token",
      },
    });
    assert.equal(badOrigin.status, 403);

    // 6. POST /api/rpc-web-ticket with allowed origin and valid token issues ticket
    const ticketRes = await fetch(`${baseUrl}/api/rpc-web-ticket`, {
      method: "POST",
      headers: {
        Origin: "https://console.zcode.app",
        Authorization: "Bearer core-token",
      },
    });
    assert.equal(ticketRes.status, 200);
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    // 7. Connect /ws?ticket= with matching origin succeeds
    const wsConn = await connectWs(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`, {
      headers: { Origin: "https://console.zcode.app" },
    });
    wsConn.close();

    // 8. Replayed ticket is rejected
    await assert.rejects(
      () =>
        connectWs(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`, {
          headers: { Origin: "https://console.zcode.app" },
        }),
      /401|403/,
    );
  } finally {
    await server.close();
  }
});
