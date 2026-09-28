import assert from "node:assert/strict";
import test from "node:test";

import { OFFICIAL_NODE_REPL_HOST_PLUGIN_ID } from "../src/app/official-plugin-definitions.js";

// isVisibleUserFacingPlugin 未导出（模块内判据），这里用类型不耦合的最小契约测试锁住事实：
// 宿主 id 归属官方市场且不在官方 CDN 目录里，设置页不应出现。判据改动会先改这里。
test("official node-repl host id maps to the not-user-facing official plugin", () => {
  assert.equal(OFFICIAL_NODE_REPL_HOST_PLUGIN_ID, "node-repl-host@zcode-plugins-official");
});
