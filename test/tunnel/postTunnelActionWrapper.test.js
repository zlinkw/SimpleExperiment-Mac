const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("postTunnelAction wrapper generates opId checks capabilities and posts fixed action", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /async postTunnelAction\(action, body, options = \{\}\)/);
  assert.match(source, /makeOpId\(action\)/);
  assert.match(source, /missingCapabilities\(options\.requiresCapability \|\| capabilityForAction\(action\)\)/);
  assert.match(source, /client\.postAction\(action, request\)/);
  assert.match(source, /this\.withRemoteActionResource\(undefined, action, request, \(\) => client\.postAction\(action, request\)\)/);
  assert.match(source, /schemaVersion: 1/);
  assert.match(source, /this\.localOperations\[request\.opId\] = \{/);
});

test("Hub and Worker action submissions bind completion to the initiating client", () => {
  const source = readSource("src/extension.ts");
  const methods = [
    ["async postTunnelAction", "async postWorkerTunnelAction", /client\.postAction\(action, request\)/],
    ["async postWorkerTunnelAction", "    activeWorkerActionOperation(", /client\.postWorkerAction\(workerId, action, request\)/],
  ];
  for (const [method, nextMethod, request] of methods) {
    const start = source.indexOf(method);
    const body = source.slice(start, source.indexOf(nextMethod, start + method.length));
    assert.match(body, /const client = options\.authorityClient \|\| this\.client/, method);
    assert.match(body, /const generation = options\.projectContext\?\.generation \?\? this\.projectContextGeneration/, method);
    assert.match(body, request, method);
    assert.ok([...body.matchAll(/client !== this\.client/g)].length >= 2, method);
  }
});
