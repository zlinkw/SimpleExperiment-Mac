const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function method(name, nextName) {
  const start = source.indexOf(`async ${name}`);
  const end = source.indexOf(`async ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end);
}

test("live output and audit reads ignore stale clients", () => {
  const live = method("fetchSelectedLiveOutput", "refreshLocalPlanMetadata");
  assert.match(live, /const client = this\.client/);
  assert.match(live, /client\.getLiveOutput/);
  assert.match(live, /generation !== this\.projectContextGeneration \|\| client !== this\.client/);
  assert.match(live, /const result = await client\.getLiveOutput/);
  assert.ok(live.indexOf("const result = await client.getLiveOutput") < live.indexOf("if (generation !== this.projectContextGeneration || client !== this.client)"));
  assert.match(live, /return result/);

  const audit = method("openAuditTail", "refreshResultsSummary");
  assert.match(audit, /const projectContext = this\.captureProjectContext\(\)/);
  assert.match(audit, /const client = this\.client/);
  assert.match(audit, /const isCurrent = \(\) => this\.projectContextIsCurrent\(projectContext\) && client === this\.client/);
  assert.match(audit, /client\.getAuditTail\(\)/);
  assert.ok([...audit.matchAll(/isCurrent\(\)/g)].length >= 5);
  assert.ok(audit.indexOf("if (!isCurrent())") < audit.indexOf("this.auditTail = auditSummary"));
});

test("remote downloads do not open stale-client results", () => {
  const cases = [
    ["downloadDebugBundle", "downloadRemoteResultFromUi", /sync\.downloadMappedPaths/],
    ["downloadRemoteResultFromUi", "openResultArtifactFromUi", /sync\.downloadMappedPaths/],
    ["openResultArtifactFromUi", "openAuditTail", /sync\.downloadMappedPaths/],
  ];
  for (const [name, nextName, call] of cases) {
    const body = method(name, nextName);
    assert.match(body, /const client = this\.client/, name);
    assert.match(body, call, name);
    assert.match(body, name === "openResultArtifactFromUi"
      ? /const isCurrent = \(\) => this\.projectContextIsCurrent\(projectContext\) && client === this\.client/
      : /generation !== this\.projectContextGeneration[\s\S]{0,80}client !== this\.client/, name);
  }
});
