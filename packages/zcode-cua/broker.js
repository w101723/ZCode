import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";
export const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\zcode-cua-helper-";

export function isWindowsNamedPipePath(path) {
  return typeof path === "string" && path.startsWith("\\\\.\\pipe\\");
}

export function brokerRuntimeDir(env = process.env) {
  const xdg = env.XDG_RUNTIME_DIR;
  if (typeof xdg === "string" && xdg.trim().length > 0) return join(xdg, "zcode-cua");
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    return typeof localAppData === "string" && localAppData.trim().length > 0
      ? join(localAppData, "zcode", "cua-broker")
      : join(homedir(), "AppData", "Local", "zcode", "cua-broker");
  }
  if (process.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
    return join("/tmp", `zcode-cua-${uid}`);
  }
  return join(homedir(), ".zcode", "cua-broker");
}

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

function brokerExchange(opts) {
  const { socketPath, token, method, params = {}, timeoutMs = 2000 } = opts;
  const sanitize = (text) =>
    typeof text === "string" ? text.split(socketPath).join("<socket>") : String(text);
  return new Promise((resolve, reject) => {
    let finished = false;
    let client;
    const finish = (fn) => {
      if (!finished) {
        finished = true;
        try {
          client?.destroy();
        } catch {}
        fn();
      }
    };
    try {
      client = createConnection(socketPath);
    } catch (err) {
      return reject(new Error(sanitize(err instanceof Error ? err.message : String(err))));
    }
    let buffer = "";
    let authenticated = !token;

    client.on("close", () =>
      finish(() => reject(new Error(sanitize("broker connection closed before reply")))),
    );
    client.on("error", (err) =>
      finish(() => reject(new Error(sanitize(err?.message ?? "socket error")))),
    );
    client.setTimeout(timeoutMs);
    client.setEncoding("utf8");

    client.on("connect", () => {
      if (token) {
        client.write(`${JSON.stringify({ id: 0, method: "authenticate", params: { token } })}\n`);
      } else {
        client.write(`${JSON.stringify({ id: 1, method, params })}\n`);
      }
    });

    client.on("data", (chunk) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            newlineIdx = buffer.indexOf("\n");
            continue;
          }
          if (authenticated) {
            finish(() => resolve(parsed));
            return;
          } else {
            authenticated = true;
            if (parsed.ok !== true) {
              finish(() =>
                reject(new BrokerError("broker auth rejected", { code: "auth_failed" })),
              );
              return;
            }
            client.write(`${JSON.stringify({ id: 1, method, params })}\n`);
          }
        }
        newlineIdx = buffer.indexOf("\n");
      }
    });

    client.on("timeout", () =>
      finish(() => reject(new Error(sanitize("broker exchange timed out")))),
    );
  });
}

export async function callBrokerMethod(args) {
  const { socketPath, method, params = {}, timeoutMs = 2000 } = args;
  const sanitize = (text) =>
    typeof text === "string" ? text.split(socketPath).join("<socket>") : String(text);
  const res = await brokerExchange({
    socketPath,
    method,
    params,
    timeoutMs,
  });
  if (res.ok === true) return res.result;
  const err = res.error;
  const msg = typeof err === "string" ? err : err?.message ? String(err.message) : "broker error";
  throw new Error(sanitize(msg));
}

export async function probeHelperHealth(socketPath, options = {}) {
  const timeoutMs = typeof options === "number" ? options : (options?.timeoutMs ?? 5000);
  const pollIntervalMs = options?.pollIntervalMs ?? 100;
  const perTryTimeoutMs = options?.perTryTimeoutMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let lastError;

  for (;;) {
    const perTry = Math.max(1, Math.min(perTryTimeoutMs, deadline - Date.now()));
    try {
      const res = await brokerExchange({
        socketPath,
        method: "broker_info",
        params: {},
        timeoutMs: perTry,
      });
      if (res && res.ok === true) {
        const result = res.result ?? {};
        const bundleId = typeof result.bundle_id === "string" ? result.bundle_id : null;
        const pid = typeof result.pid === "number" ? result.pid : null;
        return { bundleId, pid };
      }
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))),
    );
  }
  throw new CuaHelperError(
    `ZCode Computer Use did not become ready within ${timeoutMs}ms (${lastError instanceof Error ? lastError.message : String(lastError ?? "no connection")}).`,
    { code: "health_timeout" },
  );
}

export function mintBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  if (process.platform === "win32") {
    return WINDOWS_PIPE_PREFIX + randomBytes(8).toString("hex");
  }
  const dir = options.dir ?? brokerRuntimeDir(env);
  return join(dir, `broker-${randomBytes(8).toString("hex")}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return mintBrokerSocketPath(options);
}

export function parseRequestLine(_line) {
  return undefined;
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: { message, ...(options.code ? { code: options.code } : {}) },
  };
}

export function errorResponseFromException(error) {
  return errorResponse(error instanceof Error ? error.message : String(error));
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

export async function dispatchRequest(_backend, _request) {
  throw new CuaHelperError("Computer Use is not available in this build.");
}

export async function handleRequestLine(_backend, _line) {
  throw new CuaHelperError("Computer Use is not available in this build.");
}

export function isBrokerMethod(_method) {
  return false;
}

export function isReadOnlyBrokerMethod(_method) {
  return false;
}
