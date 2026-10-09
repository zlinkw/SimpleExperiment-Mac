const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { TensorBoardLocalProxy } = require("../../dist/tunnel/TensorBoardLocalProxy.js");

test("TensorBoard browser requests travel through the configured Agent endpoint", async () => {
  const received = [];
  const agent = http.createServer((request, response) => {
    received.push({ path: request.url, token: request.headers["x-simple-agent-token"] });
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("tensorboard page");
  });
  await new Promise((resolve) => agent.listen(0, "127.0.0.1", resolve));
  const proxy = new TensorBoardLocalProxy();
  try {
    const url = await proxy.open("nwpu3", {
      localHost: "127.0.0.1", localPort: agent.address().port, token: "agent-secret",
    }, 6006, "owner");
    const response = await fetch(new URL("data/plugin?tag=Loss%2Ftrain", url));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "tensorboard page");
    assert.equal(received.length, 1);
    const forwarded = new URL(received[0].path, "http://127.0.0.1");
    assert.equal(forwarded.pathname, "/api/tensorboard/proxy");
    assert.equal(forwarded.searchParams.get("port"), "6006");
    assert.equal(forwarded.searchParams.get("sessionPrefix"), "owner");
    assert.equal(forwarded.searchParams.get("path"), "/data/plugin?tag=Loss%2Ftrain");
    assert.equal(received[0].token, "agent-secret");
  } finally {
    await proxy.dispose();
    await new Promise((resolve) => agent.close(resolve));
  }
});
