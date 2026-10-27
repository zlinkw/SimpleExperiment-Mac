const { assert, test, runCli } = require("./simpleCli.support.cjs");
const { TOKEN, SOURCE, fixtureDir, sftpEnv, writeJson, startTransferBackend } = require("./simpleCliSftpTransfer.support.cjs");

// Batch 2b: transfer/write domains (fromRemote/downloadPaths/downloadMappedPaths/serverToServer/
// serverToServerBatch/fpsync/upload.workspace/upload.files/project.create/handoff.markReady/
// downloadScope.configure). The fake mirrors extension.js validation and confirmation semantics
// (shared support module simpleCliSftpTransfer.support.cjs — see that file's header).
// FIXTURE POLICY: zero cleanup. Every fixture lives under a unique retained run directory.
// SPLIT NOTE (deadline audit): the original single file ran 20130.401299ms of raw subprocess
// time, over the whole-file 20s outer deadline. It was split by independent behavior into
// simpleCliSftpTransferMapped.test.js (mapped download + numeric parameter closure) and
// simpleCliSftpTransferServer.test.js (server-to-server family + uploads + project/handoff/scope).
// All 9 original cases and every assertion are preserved exactly once across the three files;
// this file keeps the download-entry, usage-refusal, and help surface. Serial; no parallelism.

test("from-remote previews without confirmations and executes only with both", async () => {
  const backend = await startTransferBackend();
  const dir = fixtureDir("from-remote");
  const serverFile = writeJson(dir, "server.json", SOURCE);
  try {
    const preview = await runCli(["sftp", "sync", "from-remote", "--path", "/workspace/exp", "--file", serverFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(preview.code, 2, preview.stdout + preview.stderr);
    const body = JSON.parse(preview.stdout);
    assert.deepEqual(body.error.detail.requires, ["confirm", "pathConfirmed"]);
    assert.equal(backend.state.mutations, 0);
    assert.ok(!preview.stdout.includes(TOKEN));

    const done = await runCli(["sftp", "sync", "from-remote", "--path", "/workspace/exp", "--file", serverFile, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.deepEqual(backend.state.lastParams, { localPath: "/workspace/exp", confirm: true, pathConfirmed: true, server: SOURCE });
    assert.equal(backend.state.mutations, 1);
  } finally { await backend.close(); }
});

test("download-paths demands an explicit server and a non-root path list", async () => {
  const backend = await startTransferBackend();
  const dir = fixtureDir("download-paths");
  const serverFile = writeJson(dir, "server.json", SOURCE);
  const rootFile = writeJson(dir, "root.json", ["."]);
  const pathsFile = writeJson(dir, "paths.json", ["work_dirs/run1", "experiments/results/final.csv"]);
  try {
    const noServer = await runCli(["sftp", "sync", "download-paths", "--path", "/workspace/exp", "--paths", pathsFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(noServer.code, 1);
    assert.match(noServer.stdout + noServer.stderr, /--file <server.json>/);
    const rootList = await runCli(["sftp", "sync", "download-paths", "--path", "/workspace/exp", "--file", serverFile, "--paths", rootFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(rootList.code, 1);
    assert.match(rootList.stdout + rootList.stderr, /whole project/);
    assert.equal(backend.state.rpcCalls, 0, "usage refusals must not reach the API");

    const done = await runCli(["sftp", "sync", "download-paths", "--path", "/workspace/exp", "--file", serverFile, "--paths", pathsFile, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.deepEqual(backend.state.lastParams, { localPath: "/workspace/exp", server: SOURCE, paths: ["work_dirs/run1", "experiments/results/final.csv"], confirm: true, pathConfirmed: true });
  } finally { await backend.close(); }
});

test("transfer usage refusals never touch the API", async () => {
  const backend = await startTransferBackend();
  const dir = fixtureDir("transfer-usage");
  const sourceFile = writeJson(dir, "source.json", SOURCE);
  const cases = [
    ["sftp", "sync", "from-remote", "--json"],
    ["sftp", "sync", "server-to-server", "--file", sourceFile, "--json"],
    ["sftp", "sync", "server-to-server", "--file", sourceFile, "--destination", sourceFile, "--json"],
    ["sftp", "upload", "workspace", "--json"],
    ["sftp", "project", "create", "--json"],
    ["sftp", "handoff", "mark-ready", "--json"],
    ["sftp", "scope", "configure", "--json"],
  ];
  for (const args of cases) {
    const result = await runCli([...args, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  }
  assert.equal(backend.state.capabilitiesCalls, 0);
  assert.equal(backend.state.rpcCalls, 0);
  await backend.close();
});

test("help lists the batch 2b transfer entries", async () => {
  const result = await runCli(["sftp", "--help"]);
  assert.equal(result.code, 0);
  for (const probe of ["from-remote", "download-paths", "download-mapped", "server-batch", "fpsync", "upload workspace", "upload files", "project create", "handoff mark-ready", "scope configure"]) {
    assert.match(result.stdout, new RegExp(probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
