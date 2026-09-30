import assert from "node:assert/strict";
import test from "node:test";
import {
  ZCODE_MODE_OPTION_LABEL_IDS,
  ZCODE_MODE_OPTION_DESCRIPTION_IDS,
} from "../src/chat-input-toolbar/display-help.js";

test("compatibility mode labels cover major agent families without enabling external runtimes", () => {
  for (const [family, mode] of [
    ["glm", "build"],
    ["claude", "bypassPermissions"],
    ["codex", "read-only"],
    ["gemini", "autoEdit"],
    ["opencode", "plan"],
  ] as const) {
    assert.equal(typeof ZCODE_MODE_OPTION_LABEL_IDS[family][mode], "string");
    assert.equal(typeof ZCODE_MODE_OPTION_DESCRIPTION_IDS[family][mode], "string");
  }
});
