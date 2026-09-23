import { createConnection } from "node:net";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "./host-display-contract.js";

export function createComputerUseRuntime(options = {}) {
  const brokerSocketPath = options?.brokerSocketPath;

  const sendRequest = (method, params = {}, signal) => {
    if (!brokerSocketPath) {
      throw new Error("Computer Use broker socket path is not configured.");
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let client;

      const finish = (err, val) => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          try {
            client?.destroy();
          } catch {}
          if (err) reject(err);
          else resolve(val);
        }
      };

      const onAbort = () => finish(signal?.reason ?? new Error("Computer Use request aborted"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        client = createConnection(brokerSocketPath);
      } catch (err) {
        return finish(err);
      }

      let buffer = "";
      let authenticated = false;

      client.on("close", () => {
        if (!settled) {
          finish(new Error("Computer Use broker connection closed before reply"));
        }
      });
      client.on("error", (err) => finish(err));
      client.setTimeout(60000);
      client.setEncoding("utf8");

      client.on("connect", () => {
        client.write(
          `${JSON.stringify({ id: 0, method: "authenticate", params: { role: "tool" } })}\n`,
        );
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
            if (!authenticated) {
              authenticated = true;
              if (parsed.ok !== true) {
                finish(
                  new Error(
                    parsed.error?.message ??
                      parsed.message ??
                      "Computer Use broker authentication failed",
                  ),
                );
                return;
              }
              client.write(`${JSON.stringify({ id: 1, method, params })}\n`);
            } else {
              finish(undefined, parsed);
              return;
            }
          }
          newlineIdx = buffer.indexOf("\n");
        }
      });

      client.on("timeout", () => finish(new Error("Computer Use broker request timed out")));
    });
  };

  return {
    async execute(input) {
      const { toolName, arguments: toolArgs, context, signal } = input;
      const params = {
        ...(toolArgs && typeof toolArgs === "object" ? toolArgs : {}),
        ...(context ? { context } : {}),
      };

      const response = await sendRequest(toolName, params, signal);
      if (response.ok !== true) {
        const errorObj =
          response.error && typeof response.error === "object" ? response.error : {};
        const errorMsg =
          typeof response.error === "string"
            ? response.error
            : errorObj.message || response.message || "Computer Use broker action failed";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: errorObj.code || response.code || "INTERNAL",
                message: errorMsg,
                ...(errorObj.details || response.details || {}),
              }),
            },
          ],
          isError: true,
        };
      }

      const brokerResult = response.result ?? {};
      const content = [];

      if (brokerResult.screenshot && typeof brokerResult.screenshot.data === "string") {
        content.push({
          type: "image",
          data: brokerResult.screenshot.data,
          mimeType: "image/png",
        });
      }

      if (brokerResult.frame_id) {
        content.push({
          type: "text",
          text: JSON.stringify({ image_ref: { frame_id: brokerResult.frame_id } }),
        });
      }

      const { screenshot, ...rest } = brokerResult;
      content.push({
        type: "text",
        text: JSON.stringify(rest),
      });

      const _meta = {};
      if (response.presentation) {
        _meta[CUA_APP_ASSOCIATIONS_META_KEY] = response.presentation;
      }
      if (rest.app) {
        _meta.app = rest.app;
      }

      return {
        content,
        structuredContent: rest,
        ...(Object.keys(_meta).length > 0 ? { _meta } : {}),
      };
    },
    async closeSession() {},
    async dispose() {},
  };
}
