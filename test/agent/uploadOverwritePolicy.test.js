const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const agentPath = path.join(root, "dist", "runtime", "cluster_agent.py");

test("agent upload respects overwrite policies and protects existing project files", async (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }

  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-agent-upload-policy-"));
  fs.mkdirSync(path.join(project, "experiments", "plans"), { recursive: true });
  const port = await freePort();
  const agent = await startAgent(python, project, port);
  t.after(() => agent.kill());

  const target = path.join(project, "experiments", "plans", "plan.yaml");
  fs.writeFileSync(target, "old", "utf8");

  let result = await upload(port, "experiments/plans/plan.yaml", "new");
  assert.notEqual(result.init.status, 200);
  assert.equal(fs.readFileSync(target, "utf8"), "old");

  result = await upload(port, "experiments/plans/plan.yaml", "new", "never");
  assert.notEqual(result.init.status, 200);
  assert.equal(fs.readFileSync(target, "utf8"), "old");

  result = await upload(port, "experiments/plans/plan.yaml", "new-content", "always");
  assert.equal(result.complete.status, 200, JSON.stringify(result.complete.body));
  assert.equal(fs.readFileSync(target, "utf8"), "new-content");

  fs.writeFileSync(target, "same", "utf8");
  const race = await upload(port, "experiments/plans/plan.yaml", "same", "if_same_size", () => {
    fs.writeFileSync(target, "changed", "utf8");
  });
  assert.equal(race.init.status, 200, JSON.stringify(race.init.body));
  assert.equal(race.complete.status, 409, JSON.stringify(race.complete.body));
  assert.equal(fs.readFileSync(target, "utf8"), "changed");
});

async function startAgent(python, project, port) {
  const child = spawn(python, [agentPath, "serve", "--project-dir", project, "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`agent start timeout: ${stderr}`)), 10000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`agent exited ${code}: ${stderr}`));
    });
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return child;
}

async function upload(port, remotePath, text, overwrite, afterInit) {
  const body = Buffer.from(text, "utf8");
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const initPayload = { schemaVersion: 1, remotePath, size: body.length, sha256 };
  if (overwrite) initPayload.overwrite = overwrite;
  const init = await requestJson(port, "/api/files/upload-init", initPayload);
  if (init.status !== 200) return { init };
  afterInit?.();
  const transferId = init.body.transferId;
  await requestRaw(port, `/api/files/upload-chunk?transferId=${encodeURIComponent(transferId)}&offset=0`, body);
  const complete = await requestJson(port, "/api/files/upload-complete", { schemaVersion: 1, transferId, sha256 });
  return { init, complete };
}

function requestJson(port, pathname, body) {
  return request(port, pathname, Buffer.from(JSON.stringify(body), "utf8"), "application/json");
}

function requestRaw(port, pathname, body) {
  return request(port, pathname, body, "application/octet-stream");
}

function request(port, pathname, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      headers: { "Content-Type": contentType, "Content-Length": body.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}