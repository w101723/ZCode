import assert from "node:assert/strict";
import http from "node:http";
import { connectServerRemote } from "../../src/remote/server-connector.js";

const uncaughtErrors: string[] = [];
const onUncaught = (error: Error) => uncaughtErrors.push(error.message);
process.on("uncaughtException", onUncaught);

try {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const sockets = new Set<import("node:net").Socket>();
    let resolveClosed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/api/server-info"
            ? {
                serverId: "abort-fixture",
                version: "3.14.4",
                protocolVersion: 1,
                authRequired: false,
                workspaces: [],
                capabilities: { desktopContinuous: true, websocketRpc: true },
              }
            : { capability: "fixture-capability", expiresAt: Date.now() + 30_000 },
        ),
      );
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (_req, socket) => {
      socket.once("close", resolveClosed);
      socket.once("end", () => socket.end());
      socket.resume();
      controller.abort();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(
        connectServerRemote({
          target: { kind: "server", serverUrl: `http://127.0.0.1:${address.port}` },
          signal: controller.signal,
          onDidRemoteClose: () => assert.fail("Cancelled handshake must not publish a live close"),
        }),
        /远程连接已取消/,
      );
      await Promise.race([
        socketClosed,
        new Promise<never>((_resolve, reject) => {
          closeTimer = setTimeout(() => reject(new Error("Cancelled socket leaked")), 2000);
        }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(uncaughtErrors, []);
    } finally {
      clearTimeout(closeTimer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
} finally {
  process.off("uncaughtException", onUncaught);
}
