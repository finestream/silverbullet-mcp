import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, DEFAULT_SCAN_USER } from "./config.ts";

test("the scan's technical user is `scan` unless MCP_SCAN_USER names another", () => {
  assert.equal(loadConfig({}).scanUser, "scan");
  assert.equal(DEFAULT_SCAN_USER, "scan");
  assert.equal(loadConfig({ MCP_SCAN_USER: "silverbullet-mcp" }).scanUser, "silverbullet-mcp");
  assert.equal(loadConfig({ MCP_SCAN_USER: "  guardian " }).scanUser, "guardian");
  assert.equal(loadConfig({ MCP_SCAN_USER: "" }).scanUser, "scan", "an empty value means the default");
});
