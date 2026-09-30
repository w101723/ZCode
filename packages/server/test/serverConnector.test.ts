import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer } from "../src/http.js";
import { connectServerRemote } from "../src/remote/server-connector.js";
import { normalizeServerHttpUrl, toWebSocketUrl } from "../src/remote/server-connector.js";

test("direct Server connection obtains a host capability and attaches without deployment", async () => {
  const server = createHttpServer(new ServiceCollection(), 0, { authToken: "test-secret" });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const serverUrl = `http://127.0.0.1:${address.port}`;
  try {
    const connection = await connectServerRemote({
      target: { kind: "server", serverUrl, token: "test-secret" },
    });
    assert.ok(connection.serverInfo.serverId);
    await connection.disposeAndWait();
    await assert.rejects(
      connectServerRemote({ target: { kind: "server", serverUrl, token: "wrong" } }),
      /401/,
    );
  } finally {
    server.close();
  }
});

test("cancelling an in-flight Server handshake closes the socket without uncaught errors", async () => {
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/serverConnectorAbort.mts", import.meta.url)),
    ],
    { timeout: 10_000 },
  );
});

test("an already cancelled Server connection performs no handshake", async () => {
  await assert.rejects(
    connectServerRemote({
      target: { kind: "server", serverUrl: "http://127.0.0.1:1" },
      signal: AbortSignal.abort(),
    }),
    /远程连接已取消/,
  );
});

test("server connector URL utilities", () => {
  assert.equal(normalizeServerHttpUrl("http://localhost:3030"), "http://localhost:3030");
  assert.equal(normalizeServerHttpUrl("http://127.0.0.1:3030"), "http://127.0.0.1:3030");
  assert.equal(normalizeServerHttpUrl("https://example.com"), "https://example.com");

  assert.throws(() => {
    // 非本地 loopback 不允许明文 http
    normalizeServerHttpUrl("http://example.com");
  });

  assert.throws(() => {
    // 不允许携带凭据
    normalizeServerHttpUrl("http://user:pass@localhost:3030");
  });

  assert.equal(toWebSocketUrl("http://localhost:3030", "/ws/host"), "ws://localhost:3030/ws/host");
  assert.equal(
    toWebSocketUrl("https://remote.example.com", "/ws/host"),
    "wss://remote.example.com/ws/host",
  );
});
