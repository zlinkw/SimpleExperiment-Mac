import * as path from "node:path";
import { assertInstancePin, callPluginRpc, preflightPlugin, pluginDiscoveryPath, type PluginPreflight, type UnifiedPlugin } from "./LocalApiClient";
import { asCliError, businessError, envError, EXIT_BUSINESS, EXIT_OK, EXIT_ENV, usageError } from "./errors";
import { block, table, writeJson, writeText } from "./format";
import { type CliFlags, requirePositional } from "./parse";

interface PluginRpcErrorLike extends Error { apiCode?: number; apiData?: unknown; }

function asRpcError(error: unknown): PluginRpcErrorLike {
  return (error && typeof error === "object" ? error : new Error(String(error))) as PluginRpcErrorLike;
}

/**
 * One error contract for both plugin domains: CONFIRM_REQUIRED keeps the full server preview as
 * structured detail (exit 2, never a success), retired/undeclared/business refusals exit 3,
 * transport/discovery keep the shared ENV(2)/NETWORK(4) mapping. No credential is ever rendered.
 */
function toCliError(method: string, error: unknown): never {
  const rpc = asRpcError(error);
  const code = Number(rpc.apiCode);
  if (code === 2001) {
    const preview = rpc.apiData && typeof rpc.apiData === "object" ? rpc.apiData : {};
    throw envError(`CONFIRM_REQUIRED: ${method}`, JSON.stringify(preview));
  }
  if (Number.isFinite(code) && code !== 0) {
    throw businessError(rpc.message, rpc.apiData === null || rpc.apiData === undefined ? "" : JSON.stringify(rpc.apiData));
  }
  throw asCliError(error, 3);
}

async function sftpRpc(method: string, params: Record<string, unknown>, flags: CliFlags): Promise<number> {
  const result = await callPluginRpc("sftp", method, params, flags.instance).catch((error) => toCliError(method, error));
  if (flags.json) writeJson(result === undefined ? null : result, flags.compactJson);
  else writeText(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  // A business payload that reports failure is a failure: it exits 3 even though the RPC round trip succeeded.
  if (result && typeof result === "object" && !Array.isArray(result) && (result as Record<string, unknown>).ok === false) return EXIT_BUSINESS;
  return EXIT_OK;
}

/** Path list file for sync stats/inventory scopes: a JSON array of relative paths; malformed input is a usage error. */
function readJsonArrayFile(file: string, what: string): unknown[] {
  const fs = require("node:fs") as typeof import("node:fs");
  if (!fs.existsSync(file)) throw usageError(`${what} file not found: ${file}`);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw usageError(`${what} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(value)) throw usageError(`${what} must be a JSON array`);
  return value;
}

/** A patch/config value file must parse to a JSON object; malformed input is a usage error, never a silent empty write. */
function readJsonObjectFile(file: string, what: string): Record<string, unknown> {
  const fs = require("node:fs") as typeof import("node:fs");
  if (!fs.existsSync(file)) throw usageError(`${what} file not found: ${file}`);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw usageError(`${what} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

/**
 * Numeric CLI flags must not degrade into null/Infinity through JSON.stringify or be silently
 * clamped by the backend. Ranges come from the real backend normalizers (extension.js
 * mappedDownloadMaxFileBytes / mappedDownloadMaxBatchBytes / normalizeDownloadMaxFileSizeMB);
 * anything outside is a usage error with zero API calls, never a defaulted value.
 */
function readSizeFlag(name: string, raw: string, min: number, max: number, integer: boolean, contract: string): number {
  const size = Number(raw);
  if (!Number.isFinite(size) || size < min || size > max || (integer && !Number.isInteger(size))) {
    throw usageError(`invalid ${name}: ${raw} (backend accepts ${integer ? "integers" : "numbers"} in ${min}–${max}; ${contract})`);
  }
  return size;
}

/** A passthrough value file (root identity, hashes): any JSON value, forwarded verbatim; malformed input is a usage error. */
function readJsonValueFile(file: string, what: string): unknown {
  const fs = require("node:fs") as typeof import("node:fs");
  if (!fs.existsSync(file)) throw usageError(`${what} file not found: ${file}`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw usageError(`${what} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Compression choices come from the declared capability table (extension.js:1700-1701); anything else is a usage error. */
function readCompressionFlag(raw: string, allowed: string[]): string {
  if (!allowed.includes(raw)) throw usageError(`invalid --compression: ${raw} (this method accepts ${allowed.join(", ")})`);
  return raw;
}

export async function sftpCommand(action: string, rest: string[], flags: CliFlags): Promise<number> {
  if (!action) throw usageError("missing sftp action", "Usage: simpleex sftp <status|capabilities|server|config|target|confirmations> ...");
  if (action === "status") return sftpRpc("status", {}, flags);
  if (action === "capabilities") {
    const preflight = await preflightPlugin("sftp");
    assertInstancePin(flags.instance, preflight);
    const payload = {
      plugin: "SimpleSFTP", version: preflight.capabilities.version, instanceId: preflight.instanceId,
      transport: preflight.capabilities.transport, rpc: preflight.capabilities.rpc,
      features: preflight.capabilities.features, confirmation: preflight.capabilities.confirmation,
      methodCount: (preflight.capabilities.methods as string[]).length, methods: preflight.capabilities.methods,
    };
    if (flags.json) writeJson(payload, flags.compactJson);
    else writeText(block("SimpleSFTP capabilities", { version: String(payload.version), instanceId: preflight.instanceId, methods: String(payload.methodCount) }));
    return EXIT_OK;
  }
  if (action === "server") {
    const sub = rest[0] || "list";
    if (sub === "list") return sftpRpc("servers.list", {}, flags);
    if (sub === "activate") return sftpRpc("servers.setActive", { id: requirePositional(rest, 1, "server id"), confirm: flags.confirm === true }, flags);
    if (sub === "delete") return sftpRpc("servers.delete", { id: requirePositional(rest, 1, "server id"), confirm: flags.confirm === true }, flags);
    if (sub === "import-ssh") return sftpRpc("servers.importSshConfig", { confirm: flags.confirm === true }, flags);
    if (sub === "save") {
      if (!flags.file) throw usageError("sftp server save needs --file <server.json>");
      const server = readJsonObjectFile(flags.file, "server");
      return sftpRpc("servers.save", { server, setActive: flags["set-active"] === true, confirm: flags.confirm === true }, flags);
    }
    if (sub === "config-path") {
      // Path comes from the backend's own metadata; the CLI never guesses from the discovery directory.
      const status = await callPluginRpc("sftp", "status", {}, flags.instance) as Record<string, unknown>;
      const serverFile = typeof status.serverConfigFile === "string" && status.serverConfigFile ? status.serverConfigFile : "";
      if (!serverFile) throw businessError("SimpleSFTP backend does not expose serverConfigFile metadata; refusing to guess the path (update the extension or inspect the server directly)");
      if (flags.json) writeJson({ serverFile }, flags.compactJson);
      else writeText(`SimpleSFTP shared server file: ${serverFile}`);
      return EXIT_OK;
    }
    throw usageError(`unknown sftp server action: ${sub}`);
  }
  if (action === "config") {
    const sub = rest[0] || "list";
    if (sub === "list") return sftpRpc("config.list", {}, flags);
    if (sub === "get") return sftpRpc("config.get", { key: requirePositional(rest, 1, "config key") }, flags);
    if (sub === "set") {
      const key = requirePositional(rest, 1, "config key");
      if (flags.value === undefined) throw usageError("sftp config set needs --value <scalar or JSON scalar>");
      // Config values are scalars; JSON.parse keeps numbers/booleans/null faithful, anything else is taken as the string.
      let value: unknown = flags.value;
      try { value = JSON.parse(flags.value); } catch { value = flags.value; }
      if (value !== null && typeof value === "object") throw usageError("config --value must be a scalar (string/number/boolean/null)");
      return sftpRpc("config.set", { key, value, confirm: flags.confirm === true }, flags);
    }
    if (sub === "reset") return sftpRpc("config.reset", { key: requirePositional(rest, 1, "config key"), confirm: flags.confirm === true }, flags);
    throw usageError(`unknown sftp config action: ${sub}`);
  }
  if (action === "target") {
    const sub = rest[0] || "show";
    if (sub === "show") return sftpRpc("target.show", flags.path ? { localPath: flags.path } : {}, flags);
    if (sub === "update") {
      if (!flags.path) throw usageError("sftp target update needs --path <local workspace path>");
      if (!flags.file) throw usageError("sftp target update needs --file <patch.json> with at least one field; refusing an empty patch write");
      const patch = readJsonObjectFile(flags.file, "patch");
      if (!Object.keys(patch).length) throw usageError("patch.json must contain at least one field");
      return sftpRpc("target.update", { localPath: flags.path, patch, confirm: flags.confirm === true, pathConfirmed: flags["path-confirmed"] === true }, flags);
    }
    throw usageError(`unknown sftp target action: ${sub}`);
  }
  if (action === "sync") {
    const sub = rest[0] || "";
    const confirmPair = { confirm: flags.confirm === true, pathConfirmed: flags["path-confirmed"] === true };
    if (sub === "from-remote" || sub === "download-paths" || sub === "download-mapped" || sub === "server-to-server" || sub === "server-batch" || sub === "fpsync") {
      // Batch 2b transfer/long-file operations. Timeouts stay unbounded for these proven classes;
      // a lost connection means the receipt is unknown and the transport never auto-resends.
      if (sub === "from-remote") {
        if (!flags.path) throw usageError("sftp sync from-remote needs --path <local workspace path>");
        const params: Record<string, unknown> = { localPath: flags.path, ...confirmPair };
        if (flags.file) params.server = readJsonObjectFile(flags.file, "server");
        if (flags["remote-path"]) params.remotePath = flags["remote-path"];
        return sftpRpc("sync.fromRemote", params, flags);
      }
      if (sub === "download-paths") {
        if (!flags.path) throw usageError("sftp sync download-paths needs --path <local project directory>");
        if (!flags.file) throw usageError("sftp sync download-paths needs --file <server.json>: the source Worker must be explicit");
        if (!flags.paths) throw usageError("sftp sync download-paths needs --paths <paths.json>; the whole project root is refused by the backend");
        const paths = readJsonArrayFile(flags.paths, "download paths");
        if (!paths.length || paths.includes(".")) throw usageError("download paths must be one or more project-relative paths; \".\" (whole project) is refused");
        return sftpRpc("sync.downloadPaths", { localPath: flags.path, server: readJsonObjectFile(flags.file, "server"), paths, ...confirmPair }, flags);
      }
      if (sub === "download-mapped") {
        if (!flags.path) throw usageError("sftp sync download-mapped needs --path <local project directory>");
        if (!flags.file) throw usageError("sftp sync download-mapped needs --file <server.json>: the backend requires an explicit source Worker");
        if (!flags.entries) throw usageError("sftp sync download-mapped needs --entries <entries.json> ({remotePath, localRelativePath, bytes?, sha256?}[]; max 256)");
        const entries = readJsonArrayFile(flags.entries, "mapped entries");
        if (!entries.length) throw usageError("mapped entries must contain at least one entry");
        if (entries.length > 256) throw usageError("mapped entries accepts at most 256 files per call (backend limit); split the request");
        const params: Record<string, unknown> = { localPath: flags.path, server: readJsonObjectFile(flags.file, "server"), entries, ...confirmPair };
        if (flags["memory-only"] === true) params.memoryOnly = true;
        if (flags["metrics-only"] === true) params.metricsOnly = true;
        if (flags.overwrite === true) params.overwrite = true;
        if (flags["max-file-bytes"] !== undefined) params.maxFileBytes = readSizeFlag("--max-file-bytes", flags["max-file-bytes"], 1, 1024 * 1024 * 1024, true, "mappedDownloadMaxFileBytes: 1 byte to 1 GiB");
        if (flags["max-batch-bytes"] !== undefined) params.maxBatchBytes = readSizeFlag("--max-batch-bytes", flags["max-batch-bytes"], 1, 128 * 1024 * 1024, true, "mappedDownloadMaxBatchBytes: 1 byte to 128 MiB");
        if (flags.compression !== undefined) params.compression = readCompressionFlag(flags.compression, ["auto", "gzip", "none"]);
        if (flags["single-stream"] === true) throw usageError("--single-stream is declared only for the server-to-server/fpsync family, not for download-mapped");
        return sftpRpc("sync.downloadMappedPaths", params, flags);
      }
      if (!flags.file) throw usageError(`sftp sync ${sub} needs --file <source.json>`);
      if (!flags.destination) throw usageError(`sftp sync ${sub} needs --destination <destination.json>`);
      const source = readJsonObjectFile(flags.file, "source");
      const destination = readJsonObjectFile(flags.destination, "destination");
      if (sub === "server-batch") {
        if (!flags.paths) throw usageError("sftp sync server-batch needs --paths <paths.json> (1–5000 project-relative file paths)");
        const relativePaths = readJsonArrayFile(flags.paths, "batch paths");
        if (!relativePaths.length || relativePaths.length > 5000) throw usageError("batch paths must number 1–5000 (backend limit)");
        const bparams: Record<string, unknown> = { source, destination, relativePaths, ...confirmPair };
        if (flags.compression !== undefined) bparams.compression = readCompressionFlag(flags.compression, ["auto", "gzip", "zstd", "none"]);
        if (flags["single-stream"] === true) bparams.singleStream = true;
        return sftpRpc("sync.serverToServerBatch", bparams, flags);
      }
      if (sub === "fpsync") {
        // fpsync has two distinct modes (extension.js:2014-2020): directory mode carries relativePath,
        // file mode carries relativePaths 1–5000 and never needs relativePath. Ambiguous mixes are
        // refused so a stray --path can never be silently ignored.
        const fparams: Record<string, unknown> = { source, destination, ...confirmPair };
        if (flags.compression !== undefined) fparams.compression = readCompressionFlag(flags.compression, ["auto", "gzip", "zstd", "none"]);
        if (flags["single-stream"] === true) fparams.singleStream = true;
        if (flags.directory === true) {
          if (!flags.path) throw usageError("sftp sync fpsync --directory needs --path <project subdirectory>");
          if (flags.paths) throw usageError("sftp sync fpsync takes either --directory with --path or --paths <paths.json>, not both");
          fparams.directory = true;
          fparams.relativePath = flags.path;
          if (flags["manual-retain"] === true) fparams.manualRetain = true;
        } else {
          if (flags.path) throw usageError("sftp sync fpsync file mode takes --paths <paths.json>; --path is only valid with --directory (refusing to silently ignore it)");
          if (!flags.paths) throw usageError("sftp sync fpsync needs --directory with --path, or --paths <paths.json>");
          const relativePaths = readJsonArrayFile(flags.paths, "fpsync paths");
          if (!relativePaths.length || relativePaths.length > 5000) throw usageError("fpsync file paths must number 1–5000 (backend limit)");
          fparams.relativePaths = relativePaths;
        }
        return sftpRpc("sync.serverToServerFpsync", fparams, flags);
      }
      // sync.serverToServer deleteOnly is a permanent remote delete that the backend gates with only
      // confirm+pathConfirmed before guardedRemoteDeleteCommand (extension.js:912-915). That is below
      // this CLI's permanent-delete bar, so --delete-only is refused here without any RPC; the safe
      // named path is `sftp sync delete`, which requires all four factors echoed from the preview.
      if (flags["delete-only"] === true) {
        throw usageError("sftp sync server-to-server refuses --delete-only (the backend path deletes with only confirm+pathConfirmed, extension.js:912)", "use simpleex sftp sync delete --file target.json --path <rel>: it previews the absolute path and requires --confirmed-absolute <abs> --confirm --path-confirmed --second-confirmation");
      }
      if (!flags.path) throw usageError(`sftp sync ${sub} needs --path <project-relative path>`);
      const params: Record<string, unknown> = { source, destination, relativePath: flags.path, ...confirmPair };
      if (flags.directory === true) params.directory = true;
      if (flags["manual-retain"] === true) params.manualRetain = true;
      if (flags.compression !== undefined) params.compression = readCompressionFlag(flags.compression, ["auto", "gzip", "zstd", "none"]);
      if (flags["single-stream"] === true) params.singleStream = true;
      return sftpRpc("sync.serverToServer", params, flags);
    }
    if (sub === "inventory" || sub === "tree" || sub === "tree-state" || sub === "stats" || sub === "plan-logs" || sub === "delete") {
      if (!flags.file) throw usageError(`sftp sync ${sub} needs --file <source.json> with host/user/remotePath (validated by the backend)`);
      const source = readJsonObjectFile(flags.file, "source");
      if (sub === "inventory") {
        const params: Record<string, unknown> = { source };
        if (flags.path) params.relativePath = flags.path;
        if (flags["no-recursive"] === true) params.recursive = false;
        if (flags["metadata-only"] === true) params.metadataOnly = true;
        if (flags.paths) params.scopePaths = readJsonArrayFile(flags.paths, "inventory scope");
        return sftpRpc("sync.projectInventory", params, flags);
      }
      if (sub === "stats") {
        if (!flags.paths) throw usageError("sftp sync stats needs --paths <paths.json> (JSON array; the backend never scans the whole project)");
        const paths = readJsonArrayFile(flags.paths, "stats paths");
        if (!paths.length) throw usageError("stats paths must contain at least one relative path");
        if (paths.length > 128) throw usageError("stats paths accepts at most 128 entries per call (backend limit); split the request");
        return sftpRpc("sync.projectFileStats", { source, paths }, flags);
      }
      if (sub === "tree" || sub === "tree-state") {
        const params: Record<string, unknown> = { source };
        if (flags.path) params.relativePath = flags.path;
        return sftpRpc(sub === "tree" ? "sync.projectTree" : "sync.projectTreeState", params, flags);
      }
      if (sub === "plan-logs") {
        if (!flags["state-path"]) throw usageError("sftp sync plan-logs needs --state-path <simple_cluster/tmp/cluster_scheduler/..._state.json>");
        if (!flags["plan-file"]) throw usageError("sftp sync plan-logs needs --plan-file <plan.yaml> (the backend verifies the state file belongs to this plan)");
        return sftpRpc("sync.planLogPaths", { source, statePath: flags["state-path"], planFile: flags["plan-file"] }, flags);
      }
      // sync.deletePath: a first call without confirmations is a safe zero-execution preview — the
      // backend answers CONFIRM_REQUIRED with the derived absolutePath and its fixed four factors.
      // Execution demands all four exactly; the CLI never derives or auto-fills a confirmation,
      // --confirmed-absolute must echo the server's absolutePath.
      if (!flags.path) throw usageError("sftp sync delete needs --path <project-relative path>");
      const deleteParams: Record<string, unknown> = {
        target: source,
        relativePath: flags.path,
        confirm: flags.confirm === true,
        pathConfirmed: flags["path-confirmed"] === true,
        secondConfirmation: flags["second-confirmation"] === true,
      };
      if (flags["confirmed-absolute"]) deleteParams.confirmedAbsolutePath = flags["confirmed-absolute"];
      return sftpRpc("sync.deletePath", deleteParams, flags);
    }
    throw usageError(`unknown sftp sync action: ${sub} (inventory|stats|tree|tree-state|plan-logs|delete|from-remote|download-paths|download-mapped|server-to-server|server-batch|fpsync; transfers via simpleex sftp transfers)`);
  }
  if (action === "remote") {
    const sub = rest[0] || "";
    if (sub !== "list-dirs") throw usageError(`unknown sftp remote action: ${sub}`);
    if (!flags["remote-path"]) throw usageError("sftp remote list-dirs needs --remote-path <remote directory>");
    const params: Record<string, unknown> = { remotePath: flags["remote-path"], confirm: flags.confirm === true, pathConfirmed: flags["path-confirmed"] === true };
    if (flags.path) params.localPath = flags.path;
    if (flags.file) params.server = readJsonObjectFile(flags.file, "server");
    return sftpRpc("remote.listDirs", params, flags);
  }
  if (action === "transfers") {
    const sub = rest[0] || "list";
    if (sub === "list") return sftpRpc("transfers.list", {}, flags);
    if (sub === "reconcile") {
      if (!flags["operation-id"]) throw usageError("sftp transfers reconcile needs --operation-id <id>");
      const params: Record<string, unknown> = { operationId: flags["operation-id"] };
      if (flags["operation-instance-id"]) params.operationInstanceId = flags["operation-instance-id"];
      if (flags["retry-method"]) params.retryMethod = flags["retry-method"];
      if (flags["request-key"]) params.requestKey = flags["request-key"];
      if (flags["retry-params"]) params.retryParams = readJsonObjectFile(flags["retry-params"], "retry params");
      return sftpRpc("transfers.reconcile", params, flags);
    }
    if (sub === "cancel") {
      if (!flags["transfer-id"] && !flags["operation-id"]) throw usageError("sftp transfers cancel needs --transfer-id <id> or --operation-id <id> (backend requirement)");
      const params: Record<string, unknown> = {};
      if (flags["transfer-id"]) params.transferId = flags["transfer-id"];
      if (flags["operation-id"]) params.operationId = flags["operation-id"];
      if (flags.reason) params.reason = flags.reason;
      if (flags["operation-instance-id"]) params.operationInstanceId = flags["operation-instance-id"];
      return sftpRpc("transfers.cancel", params, flags);
    }
    throw usageError(`unknown sftp transfers action: ${sub}`);
  }
  const confirmPair = { confirm: flags.confirm === true, pathConfirmed: flags["path-confirmed"] === true };
  if (action === "upload") {
    const sub = rest[0] || "";
    if (sub === "workspace") {
      if (!flags.path) throw usageError("sftp upload workspace needs --path <local workspace path>");
      const params: Record<string, unknown> = { localPath: flags.path, ...confirmPair };
      if (flags.file) params.server = readJsonObjectFile(flags.file, "server");
      if (flags.manifest) params.manifest = readJsonObjectFile(flags.manifest, "manifest");
      return sftpRpc("upload.workspace", params, flags);
    }
    if (sub === "files") {
      if (!flags.base) throw usageError("sftp upload files needs --base <local base directory>");
      if (!flags.files && !flags.manifest) throw usageError("sftp upload files needs --files <files.json> and/or --manifest <manifest.json> (backend requires at least one; both may be combined)");
      const params: Record<string, unknown> = { localBase: flags.base, ...confirmPair };
      if (flags.files) params.files = readJsonArrayFile(flags.files, "upload files");
      if (flags.manifest) params.manifest = readJsonObjectFile(flags.manifest, "manifest");
      if (flags.file) params.server = readJsonObjectFile(flags.file, "server");
      return sftpRpc("upload.files", params, flags);
    }
    throw usageError(`unknown sftp upload action: ${sub}`);
  }
  if (action === "project") {
    const sub = rest[0] || "";
    if (sub !== "create") throw usageError(`unknown sftp project action: ${sub}`);
    if (!flags["remote-path"]) throw usageError("sftp project create needs --remote-path <remote project directory>");
    const params: Record<string, unknown> = { remotePath: flags["remote-path"], ...confirmPair };
    if (flags.path) params.localPath = flags.path;
    if (flags.file) params.server = readJsonObjectFile(flags.file, "server");
    return sftpRpc("project.create", params, flags);
  }
  if (action === "handoff") {
    const sub = rest[0] || "";
    if (sub !== "mark-ready") throw usageError(`unknown sftp handoff action: ${sub}`);
    if (!flags.path) throw usageError("sftp handoff mark-ready needs --path <local workspace path>");
    const params: Record<string, unknown> = { localPath: flags.path, ...confirmPair };
    if (flags.file) params.server = readJsonObjectFile(flags.file, "server");
    return sftpRpc("handoff.markReady", params, flags);
  }
  if (action === "scope") {
    const sub = rest[0] || "";
    if (sub !== "configure") throw usageError(`unknown sftp scope action: ${sub}`);
    if (!flags.path) throw usageError("sftp scope configure needs --path <local workspace path>");
    const params: Record<string, unknown> = { localPath: flags.path, ...confirmPair };
    if (flags.file) params.server = readJsonObjectFile(flags.file, "server");
    if (flags["remote-path"]) params.remotePath = flags["remote-path"];
    if (flags.paths) params.paths = readJsonArrayFile(flags.paths, "scope paths");
    if (flags.extensions) params.extensions = flags.extensions.split(",").map((item) => item.trim()).filter(Boolean);
    if (flags["max-file-size-mb"] !== undefined) params.maxFileSizeMB = readSizeFlag("--max-file-size-mb", flags["max-file-size-mb"], 0.1, 1048576, false, "normalizeDownloadMaxFileSizeMB: 0.1–1048576 MB");
    return sftpRpc("downloadScope.configure", params, flags);
  }
  if (action === "cleanup") {
    const sub = rest[0] || "";
    const needToken = () => {
      if (!flags.token) throw usageError(`sftp cleanup ${sub} needs --token <preview token>`);
      return flags.token;
    };
    const needIndex = () => {
      const parsed = Number(flags.index);
      if (flags.index === undefined || !Number.isInteger(parsed) || parsed < 0) throw usageError(`sftp cleanup ${sub} needs --index <non-negative integer target index from the preview>`);
      return parsed;
    };
    const needDigest = () => {
      if (!flags.digest) throw usageError(`sftp cleanup ${sub} needs --digest <preview digest>`);
      return flags.digest;
    };
    // r17-D: the cleanup ledger lives inside the CONSUMING local project; the CLI never falls
    // back to cwd or the remote node root — a missing/relative consumer root is a usage error.
    const needConsumerRoot = () => {
      if (!flags["consumer-root"]) throw usageError(`sftp cleanup ${sub} needs --consumer-root <absolute local project root that owns this token>`);
      if (!path.isAbsolute(flags["consumer-root"])) throw usageError("--consumer-root must be an absolute local project path (the backend refuses anything else; it never guesses cwd)");
      return flags["consumer-root"];
    };
    const readNode = () => {
      if (!flags.file) throw usageError(`sftp cleanup ${sub} needs --file <node.json> (root required; host/port for remote nodes)`);
      const node = readJsonObjectFile(flags.file, "node");
      if (typeof node.root !== "string" || !node.root) throw usageError("node.json must carry a non-empty root (backend INVALID_REQUEST)");
      return node;
    };
    if (sub === "inspect") {
      const node = readNode();
      if (!flags.target) throw usageError("sftp cleanup inspect needs --target <target.json> ({relativePath,type:'file'|'directory',...})");
      const target = readJsonObjectFile(flags.target, "target");
      if (!["file", "directory"].includes(String(target.type))) throw usageError("target.type must be file or directory (fixed types; the engine refuses anything uncertain)");
      const params: Record<string, unknown> = { node, target };
      if (flags["manifest-only"] === true) params.manifestOnly = true;
      if (flags["presence-only"] === true) params.presenceOnly = true;
      if (flags["allow-missing"] === true) params.allowMissing = true;
      if (flags["observe-executors"] === true) params.observeExecutors = true;
      // Optional ownership filter: when given, another project's in-flight preview never
      // answers as an executor for this call.
      if (flags["consumer-root"] !== undefined) params.consumerRoot = needConsumerRoot();
      return sftpRpc("files.cleanup.inspect", params, flags);
    }
    if (sub === "observe-batch") {
      const node = readNode();
      if (!flags["observation-id"]) throw usageError("sftp cleanup observe-batch needs --observation-id <id>");
      if (!flags.targets) throw usageError("sftp cleanup observe-batch needs --targets <targets.json> (1–5000 entries)");
      const targets = readJsonArrayFile(flags.targets, "observe targets");
      if (!targets.length || targets.length > 5000) throw usageError("observe-batch targets must number 1–5000 (backend limit)");
      const concurrency = flags["read-concurrency"] === undefined ? 1 : Number(flags["read-concurrency"]);
      if (concurrency !== 1 && concurrency !== 2) throw usageError("--read-concurrency must be 1 or 2 (declared capability range)");
      const params: Record<string, unknown> = { node, observationId: flags["observation-id"], targets, readConcurrency: concurrency };
      // r17-D: backend-token targets make this round read project-owned ledgers — the consumer
      // root is then required (pure token-free observation stays owner-less, like inspect).
      if (targets.some((target: any) => target?.backendToken !== undefined || target?.backendIndex !== undefined)) params.consumerRoot = needConsumerRoot();
      // cleanup-file-api.js:577: a top-level rootIdentity pins the round; backendToken/backendIndex/
      // isolationRelativePath ride inside each target and are forwarded verbatim from the targets file.
      if (flags["root-identity"]) params.rootIdentity = readJsonValueFile(flags["root-identity"], "root identity");
      return sftpRpc("files.cleanup.observeBatch", params, flags);
    }
    if (sub === "preview") {
      const node = readNode();
      const allowedActions = ["move", "delete", "restore", "isolate"];
      if (!allowedActions.includes(String(flags.action))) throw usageError(`sftp cleanup preview needs --action ${allowedActions.join("|")}`);
      if (!flags.targets) throw usageError("sftp cleanup preview needs --targets <targets.json>");
      const targets = readJsonArrayFile(flags.targets, "cleanup targets");
      if (flags["confirmed-paths"] === true && flags.action !== "delete") throw usageError("--confirmed-paths authorizes permanent deletion only (backend INVALID_ACTION: use --action delete)");
      const maxTargets = flags["confirmed-paths"] === true ? 5000 : 500;
      if (!targets.length || targets.length > maxTargets) throw usageError(`cleanup targets must number 1–${maxTargets} (${flags["confirmed-paths"] === true ? "confirmed-path batch limit" : "move/restore/isolate per-target limit"})`);
      if (flags["tmux-session-prefix"] !== undefined && !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(flags["tmux-session-prefix"])) throw usageError("invalid --tmux-session-prefix (backend: lowercase alphanumeric start, [a-z0-9._-], max 32)");
      // cleanup-file-api.js:331: the only public observationMode value is "managed_tmux"; the
      // engine then derives tmux/filesystem from the node kind. Anything else would be silently
      // dropped by the backend, so the CLI refuses it instead of pretending it took effect.
      if (flags["observation-mode"] !== undefined && flags["observation-mode"] !== "managed_tmux") throw usageError(`invalid --observation-mode: ${flags["observation-mode"]} (the backend schema knows only 'managed_tmux'; anything else falls back to the legacy activity gate)`);
      const params: Record<string, unknown> = { node, action: flags.action, targets, consumerRoot: needConsumerRoot() };
      if (flags["confirmed-paths"] === true) params.authorizationMode = "confirmed_paths";
      if (flags["observation-mode"] !== undefined) params.observationMode = flags["observation-mode"];
      if (flags["tmux-session-prefix"] !== undefined) params.tmuxSessionPrefix = flags["tmux-session-prefix"];
      return sftpRpc("files.cleanup.preview", params, flags);
    }
    if (sub === "confirm") {
      // The engine re-derives the batch digest and the exact absolute path list; anything that
      // drifted since the preview (renamed/moved/absent paths) mismatches and forces a fresh
      // preview. The CLI forwards the user's echo verbatim — it never derives or auto-fills.
      if (flags.confirm !== true) throw usageError("sftp cleanup confirm needs --confirm (the confirmation is the point of this call)", "read the preview output first, echo its digest and the exact absolute paths, then confirm with --phase 1 (and --phase 2 for deletes)");
      if (!flags.targets) throw usageError("sftp cleanup confirm needs --targets <absolutePaths.json>: the exact absolutePath list echoed from the preview (non-missing targets, in order)");
      const exactTargets = readJsonArrayFile(flags.targets, "exact absolute paths");
      const phase = Number(flags.phase);
      if (flags.phase === undefined || !Number.isInteger(phase) || phase < 1) throw usageError("sftp cleanup confirm needs --phase <1|2> (delete confirms twice: phase 1 then phase 2)") ;
      return sftpRpc("files.cleanup.confirm", { token: needToken(), confirm: true, digest: needDigest(), exactTargets, phase, consumerRoot: needConsumerRoot() }, flags);
    }
    if (sub === "execute") {
      // Protected journaled path only: the engine re-checks every entry identity before its first
      // mutation and refuses while a receipt is uncertain (DELETE_RECEIPT_UNCERTAIN is resolved by
      // verify, never by a blind resend). No unprotected delete route is exposed by this CLI.
      return sftpRpc("files.cleanup.execute", { token: needToken(), digest: needDigest(), index: needIndex(), consumerRoot: needConsumerRoot() }, flags);
    }
    if (sub === "status") return sftpRpc("files.cleanup.status", { token: needToken(), consumerRoot: needConsumerRoot() }, flags);
    if (sub === "check") return sftpRpc("files.cleanup.check", { token: needToken(), index: needIndex(), consumerRoot: needConsumerRoot() }, flags);
    if (sub === "verify") return sftpRpc("files.cleanup.verify", { token: needToken(), index: needIndex(), consumerRoot: needConsumerRoot() }, flags);
    if (sub === "settle") return sftpRpc("files.cleanup.settle", { token: needToken(), digest: needDigest(), index: needIndex(), consumerRoot: needConsumerRoot() }, flags);
    throw usageError(`unknown sftp cleanup action: ${sub} (inspect|observe-batch|preview|confirm|execute|status|check|verify|settle)`);
  }
  if (action === "agents") {
    if ((rest[0] || "") !== "lifecycle") throw usageError(`unknown agents action: ${rest[0] || "(none)"} (lifecycle)`);
    const sub = rest[1] || "";
    if (!["inspect", "ensure", "stop", "restart", "migrate"].includes(sub)) throw usageError(`unknown agents lifecycle action: ${sub || "(none)"} (inspect|ensure|stop|restart|migrate)`);
    // Contract mirrored from agent-lifecycle.js validateAgentRequest: fixed action allowlist,
    // absolute directories, worker_telemetry mode, bounded port, exact tmux window grammar,
    // 64-hex migration digest, and the runtime hash proof for ensure/restart. The backend stays
    // authoritative; these are zero-API usage guards.
    const dirFlag = (name: string, value: string | undefined, required: boolean): string | undefined => {
      if (value === undefined || value === "") {
        if (required) throw usageError(`sftp agents ${sub} needs ${name} (absolute remote directory)`);
        return undefined;
      }
      if (!value.startsWith("/") || value === "/" || /[\r\n\0*?]/.test(value) || value.split("/").includes("..")) throw usageError(`invalid ${name}: absolute remote path without '..', '*', '?' or control characters`);
      return value;
    };
    const params: Record<string, unknown> = { action: sub, mode: "worker_telemetry", confirm: flags.confirm === true, pathConfirmed: flags["path-confirmed"] === true };
    params.projectDir = dirFlag("--project-dir", flags["project-dir"], true);
    params.installDir = dirFlag("--install-dir", flags["install-dir"], true);
    const stateDir = dirFlag("--state-dir", flags["state-dir"], false);
    if (stateDir !== undefined) params.stateDir = stateDir;
    const workerStateDir = dirFlag("--worker-state-dir", flags["worker-state-dir"], false);
    if (workerStateDir !== undefined) params.workerStateDir = workerStateDir;
    if (!flags["worker-id"]) throw usageError("sftp agents needs --worker-id <id> (AGENT_IDENTITY_REQUIRED)");
    params.workerId = flags["worker-id"];
    const port = Number(flags.port);
    if (flags.port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) throw usageError("sftp agents needs --port <1-65535> (AGENT_BIND_INVALID)");
    params.port = port;
    if (flags.host) params.host = flags.host;
    if (flags["conda-env"]) params.condaEnv = flags["conda-env"];
    if (flags["session-prefix"]) params.sessionPrefix = flags["session-prefix"];
    if (flags["tmux-session"] !== undefined && !/^[a-z0-9][a-z0-9._-]{0,127}-agent$/.test(flags["tmux-session"])) throw usageError("invalid --tmux-session (backend grammar: lowercase [a-z0-9._-] ending in '-agent')");
    if (flags["tmux-session"] !== undefined) params.tmuxSession = flags["tmux-session"];
    if (flags["tmux-window"] !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(flags["tmux-window"])) throw usageError("invalid --tmux-window (backend grammar: alphanumeric start, [a-zA-Z0-9._-], max 64)");
    if (flags["tmux-window"] !== undefined) params.tmuxWindow = flags["tmux-window"];
    if (sub === "migrate" && !/^[a-f0-9]{64}$/.test(String(flags["migration-digest"] || ""))) throw usageError("agents migrate needs --migration-digest <64 hex>: the explicit frozen legacy-migration digest (AGENT_MIGRATION_CONFIRM_REQUIRED)");
    if (sub === "migrate") params.migrationDigest = flags["migration-digest"];
    if (sub === "ensure" || sub === "restart") {
      if (!flags["expected-version"]) throw usageError(`agents ${sub} needs --expected-version <v> (AGENT_RUNTIME_PROOF_REQUIRED)`);
      if (!flags.files) throw usageError(`agents ${sub} needs --files <hashes.json> (AGENT_RUNTIME_PROOF_REQUIRED)`);
      const hashes = readJsonObjectFile(flags.files, "runtime hashes");
      for (const name of ["cluster_agent.py", "cluster_scheduler.py"]) {
        if (!/^[a-f0-9]{64}$/.test(String(hashes[name] || ""))) throw usageError(`runtime hash proof missing: --files must carry the 64-hex sha256 for ${name}`);
      }
      params.expectedVersion = flags["expected-version"];
      params.files = hashes;
    }
    if (flags.file) params.server = readJsonObjectFile(flags.file, "server");
    if (flags["agent-token"]) params.agentToken = flags["agent-token"];
    return sftpRpc("agents.lifecycle", params, flags);
  }
  if (action === "confirmations") {
    if ((rest[0] || "reset") !== "reset") throw usageError(`unknown sftp confirmations action: ${rest[0]}`);
    return sftpRpc("confirmations.reset", { confirm: flags.confirm === true }, flags);
  }
  throw usageError(`unknown sftp action: ${action}`);
}

interface DoctorCheck { name: string; ok: boolean; detail: string; }

async function doctorPlugin(plugin: UnifiedPlugin, pin = ""): Promise<Record<string, unknown>> {
  const checks: DoctorCheck[] = [];
  const discoveryPath = pluginDiscoveryPath(plugin);
  let preflight: PluginPreflight | null = null;
  try {
    preflight = await preflightPlugin(plugin);
    checks.push({ name: "discovery", ok: true, detail: discoveryPath });
    checks.push({ name: "identity", ok: true, detail: `${String(preflight.capabilities.name)} ${String(preflight.capabilities.version)} instance ${preflight.instanceId}` });
    checks.push({ name: "capabilities", ok: true, detail: `${(preflight.capabilities.methods as string[]).length} methods` });
  } catch (error) {
    checks.push({ name: "discovery", ok: checks.length > 0, detail: error instanceof Error ? error.message : String(error) });
  }
  if (pin) {
    const pinned = preflight ? preflight.instanceId === pin : false;
    checks.push({ name: "instance-pin", ok: pinned, detail: preflight ? (pinned ? `pinned to ${pin}` : `pin ${pin} != live ${preflight.instanceId}`) : `pin ${pin} set but no live instance` });
  }
  return {
    plugin: preflight ? String(preflight.capabilities.name) : plugin,
    ok: checks.every((check) => check.ok),
    discoveryPath,
    version: preflight ? preflight.capabilities.version : null,
    instanceId: preflight ? preflight.instanceId : null,
    checks,
  };
}

export async function doctorCommand(flags: CliFlags): Promise<number> {
  // A pid:startedAt pin can only ever verify the single discovery a command already targets.
  // In the aggregate (both plugins) view one pin cannot match two different live instances, so
  // --instance requires --plugin <one>; for the joint view use --instance-experiment/--instance-sftp.
  // A pin never discovers or switches profiles/windows: pointing at another instance stays an
  // explicit discovery choice (SIMPLE_*_API_FILE).
  const selection = String(flags.plugin || "both").toLowerCase();
  if (!["both", "experiment", "sftp"].includes(selection)) throw usageError(`invalid --plugin: ${flags.plugin} (use experiment|sftp|both)`);
  const pinExperiment = String(flags["instance-experiment"] || "").trim();
  const pinSftp = String(flags["instance-sftp"] || "").trim();
  const singlePin = String(flags.instance || "").trim();
  if (singlePin && selection === "both") throw usageError("doctor --instance pins one plugin", "add --plugin experiment|sftp, or use --instance-experiment/--instance-sftp for the joint view; a pin verifies the current discovery target only, it cannot discover or switch to another window/profile");
  const envPin = selection !== "both" ? String(process.env.SIMPLE_CLI_INSTANCE_ID || "").trim() : "";
  const experimentPin = selection === "experiment" ? (singlePin || pinExperiment || envPin) : pinExperiment;
  const sftpPin = selection === "sftp" ? (singlePin || pinSftp || envPin) : pinSftp;
  const rows: Record<string, unknown>[] = [];
  if (selection !== "sftp") rows.push(await doctorPlugin("experiment", experimentPin));
  if (selection !== "experiment") rows.push(await doctorPlugin("sftp", sftpPin));
  const ok = rows.every((row) => row.ok === true);
  const payload = { ok, cli: process.execPath, plugin: selection, pinSemantics: "a pin only verifies the plugin's current discovery target; choosing another instance requires pointing its discovery at it", plugins: rows };
  if (flags.json) writeJson(payload, flags.compactJson);
  else {
    const human = rows.map((row) => ({
      plugin: String(row.plugin), ok: row.ok ? "ok" : "FAIL",
      version: String(row.version ?? "-"), instance: String(row.instanceId ?? "-"),
      failed: (row.checks as DoctorCheck[]).filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`).join(" | ") || "",
    }));
    writeText(table(["plugin", "ok", "version", "instance", "failed"], human));
  }
  return ok ? EXIT_OK : EXIT_ENV;
}
