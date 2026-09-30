import assert from "node:assert/strict";
import test from "node:test";
import { requestWebServerConnection } from "./src/serverRemoteConnection.js";

const info = {
  serverId: "server-a",
  version: "3.14.4",
  protocolVersion: 1,
  authRequired: true,
  workspaces: [{ path: "/work" }],
  capabilities: { desktopContinuous: true, websocketRpc: true },
};

test("Web connection exchanges a transient bearer for a short-lived ticket", async () => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const request = (async (input: URL, init?: RequestInit) => {
    requests.push({
      url: input.toString(),
      ...(init?.headers && "Authorization" in init.headers
        ? { authorization: init.headers.Authorization }
        : {}),
    });
    return Response.json(
      input.pathname.endsWith("server-info") ? info : { ticket: "short-ticket" },
    );
  }) as typeof fetch;
  const result = await requestWebServerConnection("https://server.example/", "secret", request);
  assert.equal(result.wsUrl, "wss://server.example/ws?ticket=short-ticket");
  assert.equal(requests[1]?.authorization, "Bearer secret");
  assert.equal(
    requests.some(({ url }) => url.includes("secret")),
    false,
  );
});

test("Web reconnect rejects a replaced Server before sending credentials", async () => {
  const requests: Array<{ path: string; headers?: HeadersInit }> = [];
  const request = (async (input: URL, init?: RequestInit) => {
    requests.push({ path: input.pathname, headers: init?.headers });
    return Response.json({ ...info, serverId: "replacement-server" });
  }) as typeof fetch;
  await assert.rejects(
    requestWebServerConnection("https://server.example/", "secret", request, undefined, "server-a"),
    /Server identity does not match the saved target/,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.path, "/api/server-info");
  assert.equal(new Headers(requests[0]?.headers).has("Authorization"), false);
});

test("Web reconnect with matching identity exchanges a ticket normally", async () => {
  const paths: string[] = [];
  const request = (async (input: URL) => {
    paths.push(input.pathname);
    return Response.json(input.pathname === "/api/server-info" ? info : { ticket: "short-ticket" });
  }) as typeof fetch;
  const connection = await requestWebServerConnection(
    "https://server.example/",
    "secret",
    request,
    undefined,
    "server-a",
  );
  assert.equal(connection.info.serverId, "server-a");
  assert.deepEqual(paths, ["/api/server-info", "/api/rpc-web-ticket"]);
});

test("Web connection rejects an incompatible protocol before sending credentials", async () => {
  let requestCount = 0;
  const request = (async (_input: URL, init?: RequestInit) => {
    requestCount++;
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json({ ...info, protocolVersion: 2 });
  }) as typeof fetch;
  await assert.rejects(requestWebServerConnection("https://server.example/", "secret", request));
  assert.equal(requestCount, 1);
});

test("Web connection rejects URL credentials and insecure non-loopback transport", async () => {
  await assert.rejects(
    requestWebServerConnection("https://server.example/?token=secret", "secret"),
  );
  await assert.rejects(requestWebServerConnection("http://server.example/", "secret"));
});
