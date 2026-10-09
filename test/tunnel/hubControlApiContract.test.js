const test = require("node:test");
const assert = require("node:assert/strict");

const { hubControlRequiredEndpoints, isHubOnlyApiPath, isHubControlAction } = require("../../dist/tunnel/HubControlApi.js");

test("hub control api owns actions files scheduler results and diagnostics", () => {
  assert.ok(hubControlRequiredEndpoints.includes("/api/scheduler"));
  assert.ok(hubControlRequiredEndpoints.includes("/api/results/summary"));
  assert.ok(hubControlRequiredEndpoints.includes("GET /api/files/list?path=<path>"));
  assert.ok(hubControlRequiredEndpoints.includes("/api/actions/run-plan"));
  assert.equal(isHubControlAction("delete-artifacts"), true);
  assert.equal(isHubOnlyApiPath("/api/actions/run-plan"), true);
  assert.equal(isHubOnlyApiPath("/api/files/download"), true);
});