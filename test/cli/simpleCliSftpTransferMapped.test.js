const { assert, test, runCli } = require("./simpleCli.support.cjs");
const { SOURCE, fixtureDir, sftpEnv, writeJson, startTransferBackend } = require("./simpleCliSftpTransfer.support.cjs");

// Batch 2b (split): mapped-download and numeric-parameter-closure cases, moved verbatim from
// simpleCliSftpTransfer.test.js so each file stays inside the whole-file 20s outer deadline.
// Assertions are unchanged; each case lives in exactly one file (no duplicate registration).

test("download-mapped requires an explicit server and previews the real mappedDownload summary", async () => {
  const backend = await startTransferBackend();
  const dir = fixtureDir("download-mapped");
  const serverFile = writeJson(dir, "server.json", SOURCE);
  const entriesFile = writeJson(dir, "entries.json", [
    { remotePath: "experiments/results/metrics.csv", localRelativePath: "local/metrics.csv", bytes: 100, sha256: "a".repeat(64) },
    { remotePath: "experiments/results/summary.json", localRelativePath: "local/summary.json", bytes: 50 },
  ]);
  try {
    const noServer = await runCli(["sftp", "sync", "download-mapped", "--path", "/workspace/exp", "--entries", entriesFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(noServer.code, 1);
    assert.match(noServer.stdout + noServer.stderr, /--file <server.json>/);

    const preview = await runCli(["sftp", "sync", "download-mapped", "--path", "/workspace/exp", "--file", serverFile, "--entries", entriesFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(preview.code, 2, preview.stdout + preview.stderr);
    const detail = JSON.parse(preview.stdout).error.detail;
    assert.deepEqual(detail.requires, ["confirm", "pathConfirmed"]);
    assert.equal(detail.mappedDownload.fileCount, 2);
    assert.equal(detail.mappedDownload.byteCount, 150);
    assert.deepEqual(detail.mappedDownload.entries.map((item) => item.remotePath), ["experiments/results/metrics.csv", "experiments/results/summary.json"]);
    assert.equal(backend.state.mutations, 0);

    const memoryNoMetrics = await runCli(["sftp", "sync", "download-mapped", "--path", "/workspace/exp", "--file", serverFile, "--entries", entriesFile, "--memory-only", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(memoryNoMetrics.code, 3, memoryNoMetrics.stdout + memoryNoMetrics.stderr);
    assert.match(memoryNoMetrics.stdout, /内存下载只允许明确的指标文件/);
    assert.equal(backend.state.mutations, 0);

    const done = await runCli(["sftp", "sync", "download-mapped", "--path", "/workspace/exp", "--file", serverFile, "--entries", entriesFile, "--overwrite", "--max-file-bytes", "1000", "--max-batch-bytes", "5000", "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.deepEqual(backend.state.lastParams, {
      localPath: "/workspace/exp",
      server: SOURCE,
      entries: [
        { remotePath: "experiments/results/metrics.csv", localRelativePath: "local/metrics.csv", bytes: 100, sha256: "a".repeat(64) },
        { remotePath: "experiments/results/summary.json", localRelativePath: "local/summary.json", bytes: 50 },
      ],
      confirm: true,
      pathConfirmed: true,
      overwrite: true,
      maxFileBytes: 1000,
      maxBatchBytes: 5000,
    });
    assert.equal(JSON.parse(done.stdout).fileCount, 2);
    assert.equal(backend.state.mutations, 1);

    // Capability table restricts mapped downloads to auto|gzip|none and declares no singleStream.
    const zstdRefused = await runCli(["sftp", "sync", "download-mapped", "--path", "/workspace/exp", "--file", serverFile, "--entries", entriesFile, "--compression", "zstd", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(zstdRefused.code, 1);
    assert.match(zstdRefused.stdout + zstdRefused.stderr, /invalid --compression/);
    const streamRefused = await runCli(["sftp", "sync", "download-mapped", "--path", "/workspace/exp", "--file", serverFile, "--entries", entriesFile, "--single-stream", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(streamRefused.code, 1);
    assert.match(streamRefused.stdout + streamRefused.stderr, /--single-stream is declared only for/);
    const gzip = await runCli(["sftp", "sync", "download-mapped", "--path", "/workspace/exp", "--file", serverFile, "--entries", entriesFile, "--compression", "gzip", "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(gzip.code, 0, gzip.stdout + gzip.stderr);
    assert.equal(backend.state.lastParams.compression, "gzip");
  } finally { await backend.close(); }
});

test("numeric transfer flags outside the backend ranges are usage refusals with zero API calls", async () => {
  const backend = await startTransferBackend();
  const dir = fixtureDir("numeric-flags");
  const serverFile = writeJson(dir, "server.json", SOURCE);
  const entriesFile = writeJson(dir, "entries.json", [{ remotePath: "a.csv", localRelativePath: "local/a.csv", bytes: 10 }]);
  const pathsFile = writeJson(dir, "paths.json", ["experiments/results"]);
  const badMapped = [
    ["--max-file-bytes", "abc"], ["--max-file-bytes", "Infinity"], ["--max-file-bytes", "0"], ["--max-file-bytes", "1.5"], ["--max-file-bytes", "1073741825"],
    ["--max-batch-bytes", "0"], ["--max-batch-bytes", "134217729"], ["--max-batch-bytes", "-1"],
  ];
  try {
    for (const [flag, value] of badMapped) {
      const result = await runCli(["sftp", "sync", "download-mapped", "--path", "/workspace/exp", "--file", serverFile, "--entries", entriesFile, flag, value, "--json"], { env: sftpEnv(backend.file) });
      assert.equal(result.code, 1, `${flag}=${value}: ${result.stdout}${result.stderr}`);
      // leading-dash values are refused by the parser itself; everything else by the range check.
      assert.match(result.stdout + result.stderr, /invalid --max|missing value for --max/);
    }
    const negative = await runCli(["sftp", "sync", "download-mapped", "--path", "/workspace/exp", "--file", serverFile, "--entries", entriesFile, "--max-file-bytes", "-5", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(negative.code, 1); // parse refuses a value starting with "-" before it can reach the backend
    const badScope = [
      ["--max-file-size-mb", "abc"], ["--max-file-size-mb", "Infinity"], ["--max-file-size-mb", "0"], ["--max-file-size-mb", "0.05"], ["--max-file-size-mb", "1048577"],
    ];
    for (const [flag, value] of badScope) {
      const result = await runCli(["sftp", "scope", "configure", "--path", "/workspace/exp", "--paths", pathsFile, flag, value, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
      assert.equal(result.code, 1, `${flag}=${value}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, /invalid --max-file-size-mb/);
    }
    assert.equal(backend.state.capabilitiesCalls, 0, "bad numeric values must never open the API path");
    assert.equal(backend.state.rpcCalls, 0);

    // Valid boundary values survive verbatim (backend bounds read from extension.js normalizers).
    const mappedOk = await runCli(["sftp", "sync", "download-mapped", "--path", "/workspace/exp", "--file", serverFile, "--entries", entriesFile, "--max-file-bytes", "1073741824", "--max-batch-bytes", "134217728", "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(mappedOk.code, 0, mappedOk.stdout + mappedOk.stderr);
    assert.equal(backend.state.lastParams.maxFileBytes, 1073741824);
    assert.equal(backend.state.lastParams.maxBatchBytes, 134217728);
    const scopeOk = await runCli(["sftp", "scope", "configure", "--path", "/workspace/exp", "--paths", pathsFile, "--max-file-size-mb", "0.1", "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(scopeOk.code, 0, scopeOk.stdout + scopeOk.stderr);
    assert.equal(backend.state.lastParams.maxFileSizeMB, 0.1);
  } finally { await backend.close(); }
});
