const { assert, test, runCli } = require("./simpleCli.support.cjs");
const { SOURCE, DEST, fixtureDir, sftpEnv, writeJson, startTransferBackend } = require("./simpleCliSftpTransfer.support.cjs");

// Batch 2b (split): server-to-server family, uploads, and project/handoff/scope confirmation
// closures, moved verbatim from simpleCliSftpTransfer.test.js so each file stays inside the
// whole-file 20s outer deadline. Assertions unchanged; each case lives in exactly one file.

test("server-to-server family mirrors the real guards and fixed confirmation pairs", async () => {
  const backend = await startTransferBackend();
  const dir = fixtureDir("server-to-server");
  const sourceFile = writeJson(dir, "source.json", SOURCE);
  const destFile = writeJson(dir, "dest.json", DEST);
  const sameFile = writeJson(dir, "same.json", SOURCE);
  const batchFile = writeJson(dir, "batch.json", ["work_dirs/run1/a.csv", "work_dirs/run1/b.csv"]);
  try {
    const same = await runCli(["sftp", "sync", "server-to-server", "--file", sourceFile, "--destination", sameFile, "--path", "work_dirs/run1/out.csv", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(same.code, 3, same.stdout);
    assert.match(same.stdout, /来源与目标相同/);

    const shallow = await runCli(["sftp", "sync", "server-to-server", "--file", sourceFile, "--destination", destFile, "--path", "work_dirs", "--directory", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(shallow.code, 3, shallow.stdout);
    assert.match(shallow.stdout, /Plan 独立子目录/);

    const preview = await runCli(["sftp", "sync", "server-to-server", "--file", sourceFile, "--destination", destFile, "--path", "work_dirs/run1/out.csv", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(preview.code, 2);
    assert.deepEqual(JSON.parse(preview.stdout).error.detail.requires, ["confirm", "pathConfirmed"]);

    // --delete-only is refused at usage level without any RPC: the backend gates that permanent
    // delete with only confirm+pathConfirmed (extension.js:912), below this CLI's double-confirm bar.
    const rpcBefore = backend.state.rpcCalls;
    const deleteOnly = await runCli(["sftp", "sync", "server-to-server", "--file", sourceFile, "--destination", destFile, "--path", "work_dirs/run1/out.csv", "--delete-only", "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(deleteOnly.code, 1, deleteOnly.stdout + deleteOnly.stderr);
    assert.match(deleteOnly.stdout + deleteOnly.stderr, /simpleex sftp sync delete/);
    assert.equal(backend.state.rpcCalls, rpcBefore, "--delete-only must not send any RPC");
    assert.equal(backend.state.deleteOnlySeen, 0);

    const batch = await runCli(["sftp", "sync", "server-batch", "--file", sourceFile, "--destination", destFile, "--paths", batchFile, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(batch.code, 0, batch.stdout + batch.stderr);
    assert.deepEqual(backend.state.lastParams.relativePaths, ["work_dirs/run1/a.csv", "work_dirs/run1/b.csv"]);

    const fpsyncDir = await runCli(["sftp", "sync", "fpsync", "--file", sourceFile, "--destination", destFile, "--directory", "--path", "work_dirs/run1", "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(fpsyncDir.code, 0, fpsyncDir.stdout + fpsyncDir.stderr);
    assert.deepEqual(backend.state.lastParams, { source: SOURCE, destination: DEST, confirm: true, pathConfirmed: true, directory: true, relativePath: "work_dirs/run1" });

    // File mode needs no --path at all (extension.js:2019: directory=false only requires relativePaths 1–5000).
    const fpsyncFiles = await runCli(["sftp", "sync", "fpsync", "--file", sourceFile, "--destination", destFile, "--paths", batchFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(fpsyncFiles.code, 2, fpsyncFiles.stdout + fpsyncFiles.stderr);
    assert.deepEqual(JSON.parse(fpsyncFiles.stdout).error.detail.requires, ["confirm", "pathConfirmed"]);
    const fpsyncDone = await runCli(["sftp", "sync", "fpsync", "--file", sourceFile, "--destination", destFile, "--paths", batchFile, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(fpsyncDone.code, 0, fpsyncDone.stdout + fpsyncDone.stderr);
    assert.deepEqual(backend.state.lastParams, { source: SOURCE, destination: DEST, confirm: true, pathConfirmed: true, relativePaths: ["work_dirs/run1/a.csv", "work_dirs/run1/b.csv"] });
    assert.ok(!("relativePath" in backend.state.lastParams), "file mode must not send relativePath");

    // Declared capability params (extension.js:1700-1701): fpsync family takes compression auto|gzip|zstd|none + singleStream.
    const badCompression = await runCli(["sftp", "sync", "fpsync", "--file", sourceFile, "--destination", destFile, "--paths", batchFile, "--compression", "lz4", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(badCompression.code, 1);
    assert.match(badCompression.stdout + badCompression.stderr, /invalid --compression/);
    const fpsyncCompressed = await runCli(["sftp", "sync", "fpsync", "--file", sourceFile, "--destination", destFile, "--paths", batchFile, "--compression", "zstd", "--single-stream", "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(fpsyncCompressed.code, 0, fpsyncCompressed.stdout + fpsyncCompressed.stderr);
    assert.equal(backend.state.lastParams.compression, "zstd");
    assert.equal(backend.state.lastParams.singleStream, true);

    // Ambiguous and empty combinations are usage refusals with no RPC (extension.js:2020 list bounds).
    const emptyFile = writeJson(dir, "empty.json", []);
    const ambiguous1 = await runCli(["sftp", "sync", "fpsync", "--file", sourceFile, "--destination", destFile, "--directory", "--path", "work_dirs/run1", "--paths", batchFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(ambiguous1.code, 1);
    assert.match(ambiguous1.stdout + ambiguous1.stderr, /not both/);
    const ambiguous2 = await runCli(["sftp", "sync", "fpsync", "--file", sourceFile, "--destination", destFile, "--path", "work_dirs/run1", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(ambiguous2.code, 1);
    assert.match(ambiguous2.stdout + ambiguous2.stderr, /only valid with --directory/);
    const empty = await runCli(["sftp", "sync", "fpsync", "--file", sourceFile, "--destination", destFile, "--paths", emptyFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(empty.code, 1);
    assert.match(empty.stdout + empty.stderr, /1–5000/);
    const overFile = writeJson(dir, "over.json", Array.from({ length: 5001 }, (_, i) => `work_dirs/run1/f${i}.csv`));
    const over = await runCli(["sftp", "sync", "fpsync", "--file", sourceFile, "--destination", destFile, "--paths", overFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(over.code, 1);
    assert.match(over.stdout + over.stderr, /1–5000/);
    assert.equal(backend.state.deleteOnlySeen, 0);
  } finally { await backend.close(); }
});

test("upload workspace/files forward the real parameter shapes", async () => {
  const backend = await startTransferBackend();
  const dir = fixtureDir("upload");
  const serverFile = writeJson(dir, "server.json", SOURCE);
  const filesFile = writeJson(dir, "files.json", ["model.py", { localPath: "/abs/weights.pt", remoteName: "runs/weights.pt" }]);
  try {
    const noBase = await runCli(["sftp", "upload", "files", "--files", filesFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(noBase.code, 1);
    assert.match(noBase.stdout + noBase.stderr, /--base/);
    const neither = await runCli(["sftp", "upload", "files", "--base", "/workspace/exp", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(neither.code, 1);
    assert.match(neither.stdout + neither.stderr, /--files <files.json> and\/or --manifest/);

    const ws = await runCli(["sftp", "upload", "workspace", "--path", "/workspace/exp", "--file", serverFile, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(ws.code, 0, ws.stdout + ws.stderr);
    assert.deepEqual(backend.state.lastParams, { localPath: "/workspace/exp", confirm: true, pathConfirmed: true, server: SOURCE });

    const files = await runCli(["sftp", "upload", "files", "--base", "/workspace/exp", "--files", filesFile, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(files.code, 0, files.stdout + files.stderr);
    assert.deepEqual(backend.state.lastParams.files, ["model.py", { localPath: "/abs/weights.pt", remoteName: "runs/weights.pt" }]);
    // Real receipt (extension.js:2432): files is the array of uploaded relative paths, not a count.
    assert.deepEqual(JSON.parse(files.stdout).files, ["model.py", "runs/weights.pt"]);

    // files and manifest are combinable at the backend guard; the CLI forwards both without claiming exclusivity.
    const manifestFile = writeJson(dir, "manifest.json", { files: ["extra.log"] });
    const both = await runCli(["sftp", "upload", "files", "--base", "/workspace/exp", "--files", filesFile, "--manifest", manifestFile, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(both.code, 0, both.stdout + both.stderr);
    assert.ok(Array.isArray(backend.state.lastParams.files));
    assert.equal(backend.state.lastParams.manifest.files[0], "extra.log");
  } finally { await backend.close(); }
});

test("project create, handoff mark-ready and scope configure close their confirmations", async () => {
  const backend = await startTransferBackend();
  const pathsFile = writeJson(fixtureDir("scope"), "paths.json", ["experiments/results"]);
  try {
    const create = await runCli(["sftp", "project", "create", "--remote-path", "/data/projects/new-exp", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(create.code, 2, create.stdout + create.stderr);
    assert.deepEqual(JSON.parse(create.stdout).error.detail.requires, ["confirm", "pathConfirmed"]);
    const created = await runCli(["sftp", "project", "create", "--remote-path", "/data/projects/new-exp", "--path", "/workspace/new-exp", "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(created.code, 0, created.stdout + created.stderr);
    assert.deepEqual(backend.state.lastParams, { remotePath: "/data/projects/new-exp", confirm: true, pathConfirmed: true, localPath: "/workspace/new-exp" });

    const serverFile = writeJson(fixtureDir("handoff"), "server.json", SOURCE);
    const handoff = await runCli(["sftp", "handoff", "mark-ready", "--path", "/workspace/exp", "--file", serverFile, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(handoff.code, 0, handoff.stdout + handoff.stderr);
    assert.ok(JSON.parse(handoff.stdout).markedAt);
    assert.deepEqual(backend.state.lastParams, { localPath: "/workspace/exp", confirm: true, pathConfirmed: true, server: SOURCE });

    const createdWithServer = await runCli(["sftp", "project", "create", "--remote-path", "/data/projects/other", "--file", serverFile, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(createdWithServer.code, 0, createdWithServer.stdout + createdWithServer.stderr);
    assert.deepEqual(backend.state.lastParams, { remotePath: "/data/projects/other", confirm: true, pathConfirmed: true, server: SOURCE });

    const scope = await runCli(["sftp", "scope", "configure", "--path", "/workspace/exp", "--paths", pathsFile, "--extensions", ".csv,.json", "--max-file-size-mb", "64", "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(scope.code, 0, scope.stdout + scope.stderr);
    const scopeBody = JSON.parse(scope.stdout);
    assert.deepEqual(scopeBody.scope.paths, ["experiments/results"]);
    assert.deepEqual(scopeBody.scope.extensions, [".csv", ".json"]);
    assert.equal(scopeBody.scope.maxFileSizeMB, 64);
  } finally { await backend.close(); }
});
