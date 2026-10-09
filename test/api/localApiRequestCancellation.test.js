const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");

const { LocalApiServer } = require("../../dist/api/LocalApiServer.js");

test("RPC disconnect cancels opted-in reads while mutation handlers continue", async () => {
  const readStarted = deferred();
  const readAborted = deferred();
  const writeStarted = deferred();
  const writeFinished = deferred();
  let mutationCompleted = false;
  const port = await freePort();
  const server = new LocalApiServer({
    name: "test", version: "1", token: "token", preferredPort: port,
    methods: {
      read: (_params, _server, context) => {
        readStarted.resolve();
        return new Promise((resolve) => {
          const abort = () => { readAborted.resolve(); resolve(null); };
          if (context.signal.aborted) abort();
          else context.signal.addEventListener("abort", abort, { once: true });
        });
      },
      mutate: async () => {
        writeStarted.resolve();
        await new Promise((resolve) => setTimeout(resolve, 40));
        mutationCompleted = true;
        writeFinished.resolve();
        return { operationId: "durable-op" };
      },
    },
  });
  await server.start();
  try {
    const readRequest = requestRpc(port, "token", "read");
    await readStarted.promise;
    readRequest.destroy();
    await withTimeout(readAborted.promise, 500, "read handler did not receive cancellation");

    const writeRequest = requestRpc(port, "token", "mutate");
    await writeStarted.promise;
    writeRequest.destroy();
    await withTimeout(writeFinished.promise, 500, "mutation did not finish after client disconnect");
    assert.equal(mutationCompleted, true);
  } finally {
    await server.dispose();
  }
});

function requestRpc(port, token, method) {
  const request = http.request({
    hostname: "127.0.0.1", port, path: "/api/v1/rpc", method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  request.on("error", () => undefined);
  request.end(JSON.stringify({ jsonrpc: "2.0", id: method, method, params: {} }));
  return request;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}
