// Shared support for the batch 2b transfer suites (split from the original
// simpleCliSftpTransfer.test.js so each file stays inside the whole-file 20s outer deadline;
// every case, parameter matrix, and assertion is preserved verbatim in exactly one file,
// never duplicated). The fake mirrors extension.js validation and confirmation semantics
// (requireApiConfirmation builds requires dynamically; serverToServer*/fpsync use fixed pairs;
// deleteOnly/scope receipts follow the real return shapes). No real transfers ever run here.
// FIXTURE POLICY: zero cleanup. Every fixture lives under a unique retained run directory.
const { fs, http, os, path } = require("./simpleCli.support.cjs");

const TOKEN = "transfer-batch-token";
const PID = 4321;
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `sftp-transfer-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);

function fixtureDir(name) {
  const dir = path.join(FIXTURE_ROOT, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function sftpEnv(file) {
  return { SIMPLE_SFTP_MAC_API_FILE: file };
}
function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

const SOURCE = { host: "gpu-node-1", user: "researcher", remotePath: "/data/projects/exp", port: 22 };
const DEST = { host: "gpu-node-2", user: "researcher", remotePath: "/data/projects/exp", port: 22 };

function validTarget(value) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return /^[A-Za-z0-9._-]+$/.test(String(item.host || ""))
    && /^[A-Za-z0-9._-]+$/.test(String(item.user || item.username || ""))
    && String(item.remotePath || "").startsWith("/") && String(item.remotePath || "") !== "/";
}
const sameTarget = (a = {}, b = {}) => a.host === b.host && (a.port || 22) === (b.port || 22) && String(a.remotePath || "").replace(/\/+$/, "") === String(b.remotePath || "").replace(/\/+$/, "");

function startTransferBackend() {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastMethod: "", lastParams: null, mutations: 0, deleteOnlySeen: 0 };
  const methods = ["status", "sync.fromRemote", "sync.downloadPaths", "sync.downloadMappedPaths", "sync.serverToServer", "sync.serverToServerBatch", "sync.serverToServerFpsync", "upload.workspace", "upload.files", "project.create", "handoff.markReady", "downloadScope.configure"];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end("{}"); return; }
    if (req.method === "GET" && req.url === "/api/v1/capabilities") {
      state.capabilitiesCalls += 1;
      res.end(JSON.stringify({ schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107", instanceId: `${PID}:${STARTED_AT}`, rpc: "json-rpc-2.0", methods }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      state.rpcCalls += 1;
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.lastMethod = rpc.method;
      state.lastParams = rpc.params;
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...handle(rpc.method, rpc.params) }));
    });
  });
  // requireApiConfirmation mirror: requires is built from what is missing (no remembered paths).
  function pairConfirmation(method, operation, params, extra = {}) {
    const requires = [];
    if (params.confirm !== true) requires.push("confirm");
    if (params.pathConfirmed !== true) requires.push("pathConfirmed");
    if (requires.length) return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { method, operation, requires, ...extra } } };
    return null;
  }
  function failure(message) {
    return { error: { code: -32000, message } };
  }
  function handle(method, params) {
    if (method === "sync.fromRemote") {
      if (!String(params.localPath || "").trim()) return failure("缺少本地工作区 localPath。");
      const refusal = pairConfirmation(method, "远端同步到本地", params, { localPath: params.localPath });
      if (refusal) return refusal;
      state.mutations += 1;
      return { result: { ok: true, localPath: params.localPath, remotePath: "/data/projects/exp", transferredFiles: 3 } };
    }
    if (method === "sync.downloadPaths") {
      if (!String(params.localPath || "").trim()) return failure("缺少本地项目目录 localPath。");
      if (!params.server || typeof params.server !== "object") return failure("必须明确指定来源 Worker。");
      if (!Array.isArray(params.paths) || !params.paths.length || params.paths.includes(".")) return failure("显式下载路径必须是一个或多个项目内文件或目录，禁止选择整个项目根目录。");
      const refusal = pairConfirmation(method, `仅下载 ${params.paths.length} 条指定路径到本机`, params);
      if (refusal) return refusal;
      state.mutations += 1;
      return { result: { ok: true, localPath: params.localPath, remotePath: "/data/projects/exp", paths: params.paths } };
    }
    if (method === "sync.downloadMappedPaths") {
      // Order mirrors extension.js:4376-4381 + normalizeMappedDownloadEntries (extension.js:2939).
      if (!String(params.localPath || "").trim()) return failure("缺少本地项目目录 localPath。");
      if (!params.server || typeof params.server !== "object") return failure("必须明确指定来源 Worker。");
      if (!Array.isArray(params.entries) || !params.entries.length) return failure("映射下载必须提供 entries，且不能扫描整个项目。");
      if (params.entries.length > 256) return failure(`映射下载一次最多 256 个文件，当前 ${params.entries.length} 个。`);
      if (params.memoryOnly === true && params.metricsOnly !== true) return failure("内存下载只允许明确的指标文件。");
      if (params.memoryOnly === true && params.entries.some((item) => !/^[a-f0-9]{64}$/.test(String(item.sha256 || "")) || !Number.isSafeInteger(Number(item.bytes)))) {
        return failure("内存指标下载必须提供大小和 SHA256。");
      }
      if (!params.server.host || !params.server.remotePath) return failure("必须明确指定来源 Worker 的主机和远端项目目录。");
      const mappedDownload = {
        fileCount: params.entries.length,
        byteCount: params.entries.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
        maxFileBytes: params.maxFileBytes == null ? 134217728 : Number(params.maxFileBytes),
        maxBatchBytes: params.maxBatchBytes == null ? 134217728 : Number(params.maxBatchBytes),
        overwrite: params.overwrite === true,
        entries: params.entries.map((item) => ({ remotePath: item.remotePath, localRelativePath: item.localRelativePath, bytes: item.bytes == null ? null : Number(item.bytes), sha256: String(item.sha256 || "") })),
      };
      const refusal = pairConfirmation(method, `一次打包下载 ${params.entries.length} 个映射文件到本机不同路径`, params, { mappedDownload });
      if (refusal) return refusal;
      state.mutations += 1;
      return { result: { ok: true, fileCount: params.entries.length, byteCount: mappedDownload.byteCount } };
    }
    if (method === "sync.serverToServer" || method === "sync.serverToServerBatch" || method === "sync.serverToServerFpsync") {
      if (!validTarget(params.source)) return failure("来源 SSH 主机或用户名无效。");
      if (!validTarget(params.destination)) return failure("目标 SSH 主机或用户名无效。");
      if (sameTarget(params.source, params.destination)) return failure("来源与目标相同。");
      if (method === "sync.serverToServerBatch") {
        if (!Array.isArray(params.relativePaths) || !params.relativePaths.length || params.relativePaths.length > 5000) return failure("批量同步需要 1–5000 个项目内文件路径。");
      }
      if (method === "sync.serverToServer" && params.directory === true && String(params.relativePath || "").split("/").length < 2 && params.manualRetain !== true) {
        return failure("目录同步必须限定到 Plan 独立子目录，禁止清理项目顶层目录。");
      }
      if (method === "sync.serverToServerFpsync") {
        if (params.directory === true && String(params.relativePath || "").split("/").length < 2 && params.manualRetain !== true) return failure("目录同步必须限定到 Plan 独立子目录。");
        if (params.directory !== true && (!Array.isArray(params.relativePaths) || !params.relativePaths.length || params.relativePaths.length > 5000)) return failure("批量同步需要 1–5000 个项目内文件路径。");
      }
      // serverToServer/Batch/Fpsync use the fixed two-factor requires (extension.js:905-909 etc.).
      if (params.confirm !== true || params.pathConfirmed !== true) {
        return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { method, operation: "Worker 间同步", requires: ["confirm", "pathConfirmed"], source: params.source, destination: params.destination } } };
      }
      // The real backend deletes here with only confirm+pathConfirmed (extension.js:912-915).
      // The CLI must never route here with deleteOnly; counting proves zero arrivals in tests.
      if (method === "sync.serverToServer" && params.deleteOnly === true) state.deleteOnlySeen += 1;
      state.mutations += 1;
      return { result: { ok: true, fileCount: 2, byteCount: 2048, verifyAlgorithm: "sha256-batch-v1" } };
    }
    if (method === "upload.workspace") {
      if (!String(params.localPath || "").trim()) return failure("请先打开工作区，或传入 localPath。");
      const refusal = pairConfirmation(method, "上传工作区", params);
      if (refusal) return refusal;
      state.mutations += 1;
      return { result: { ok: true, targetId: "gpu-node-1:/data/projects/exp", remotePath: "/data/projects/exp", uploadedAt: "2026-10-23T00:00:00.000Z" } };
    }
    if (method === "upload.files") {
      if (!Array.isArray(params.files) && !params.manifest) return failure("缺少上传文件列表 files 或 manifest。");
      if (!String(params.localBase || "").trim()) return failure("请先打开工作区，或传入 localBase。");
      const refusal = pairConfirmation(method, "上传指定文件", params);
      if (refusal) return refusal;
      state.mutations += 1;
      // Real shape (extension.js:2432): files is the array of uploaded relative paths, not a count.
      const relativePaths = Array.isArray(params.files)
        ? params.files.map((item) => (typeof item === "string" ? item : String(item.remoteName || item.localPath)))
        : (params.manifest && Array.isArray(params.manifest.files) ? params.manifest.files.map((item) => (typeof item === "string" ? item : String(item.remoteName || item.localPath))) : []);
      return { result: { ok: true, targetId: "gpu-node-1", remotePath: "/data/projects/exp", files: relativePaths, stats: { bytes: 4096 }, uploadedAt: "2026-10-23T00:00:00.000Z" } };
    }
    if (method === "project.create") {
      if (!String(params.remotePath || "").trim()) return failure("缺少远端项目目录 remotePath。");
      const refusal = pairConfirmation(method, "创建 SFTP 工作区", params, { remotePath: params.remotePath });
      if (refusal) return refusal;
      state.mutations += 1;
      return { result: { ok: true, localPath: params.localPath || "/workspace/exp", remotePath: params.remotePath } };
    }
    if (method === "handoff.markReady") {
      if (!String(params.localPath || "").trim()) return failure("缺少本地工作区 localPath。");
      const refusal = pairConfirmation(method, "上传并标记交接", params);
      if (refusal) return refusal;
      state.mutations += 1;
      return { result: { ok: true, remotePath: "/data/projects/exp", markedAt: "2026-10-23T00:00:00.000Z" } };
    }
    if (method === "downloadScope.configure") {
      const refusal = pairConfirmation(method, "设置下载文件范围", params);
      if (refusal) return refusal;
      state.mutations += 1;
      return { ok: true, result: { ok: true, targetId: "scope-key", remotePath: "/data/projects/exp", scope: { paths: Array.isArray(params.paths) ? params.paths : [], extensions: Array.isArray(params.extensions) ? params.extensions : ["*"], maxFileSizeMB: params.maxFileSizeMB ?? 128 } } };
    }
    return { error: { code: -32601, message: `Method unavailable: ${method}` } };
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const file = path.join(fixtureDir("discovery"), "sftp-api.json");
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107", baseUrl: `http://127.0.0.1:${server.address().port}`, host: "127.0.0.1", port: server.address().port, token: TOKEN, pid: PID, startedAt: STARTED_AT }), "utf8");
      resolve({ state, file, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}

module.exports = { TOKEN, SOURCE, DEST, FIXTURE_ROOT, fixtureDir, sftpEnv, writeJson, startTransferBackend };
