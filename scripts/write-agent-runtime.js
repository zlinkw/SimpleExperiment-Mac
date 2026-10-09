const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const root = path.resolve(__dirname, "..");

// 单源：package.json#version 为唯一可信源，统一注入所有版本常量
const unifiedVersion = (() => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const v = String(raw || "").trim();
  if (!v) throw new Error("[agent-runtime] package.json version 缺失，无法确定 unifiedVersion");
  return v;
})();

// 同步校验并自动纠正 RuntimeManifest.ts 的 CURRENT_RUNTIME_VERSION 与单源一致（避免双源歧义）
(() => {
  const manifestPath = path.join(root, "src/runtime/RuntimeManifest.ts");
  let src = fs.readFileSync(manifestPath, "utf8");
  const m = src.match(/CURRENT_RUNTIME_VERSION\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("[agent-runtime] CURRENT_RUNTIME_VERSION 未匹配（src/runtime/RuntimeManifest.ts）");
  const cur = String(m[1] || "").trim();
  if (cur !== unifiedVersion) {
    src = src.replace(/CURRENT_RUNTIME_VERSION\s*=\s*"[^"]+"/, `CURRENT_RUNTIME_VERSION = "${unifiedVersion}"`);
    writeRuntimeFile(manifestPath, src);
    console.log(`[agent-runtime] auto-synced CURRENT_RUNTIME_VERSION ${cur} -> ${unifiedVersion}`);
  }
})();

function patchVersionHeader(text, unifiedVer) {
  // 统一注入：所有版本常量均指向 unifiedVersion，消除双版本歧义
  return text.replace(/(AGENT_VERSION|RUNTIME_VERSION|PLUGIN_VERSION|SCHEDULER_VERSION)\s*=\s*"[^"]+"/g, (match, key) => {
    return `${key} = "${unifiedVer}"`;
  });
}

function writeRuntimeFile(target, content) {
  // Windows can allow in-place writes while denying CREATE_ALWAYS on an open runtime file.
  const fd = fs.openSync(target, fs.existsSync(target) ? "r+" : "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.ftruncateSync(fd, Buffer.byteLength(content, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

const runtimes = [
  ["dist/clusterAgentRuntime.js", "CLUSTER_AGENT_RUNTIME", "dist/runtime/cluster_agent.py", "#!/usr/bin/env python3\nfrom __future__ import annotations\n"],
  ["dist/clusterSchedulerRuntime.js", "CLUSTER_SCHEDULER_RUNTIME", "dist/runtime/cluster_scheduler.py", "from __future__ import annotations\n"],
];

for (const [modulePath, exportName, targetPath, expectedPrefix] of runtimes) {
  const sourceModule = require(path.join(root, modulePath));
  const content = sourceModule[exportName];
  if (typeof content !== "string" || !content.startsWith(expectedPrefix)) {
    throw new Error(`[agent-runtime] invalid ${exportName} from ${modulePath}`);
  }
  const patched = patchVersionHeader(content, unifiedVersion);
  const target = path.join(root, targetPath);
  const previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (previous === patched) {
    console.log(`[agent-runtime] kept ${targetPath} unified=${unifiedVersion}`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeRuntimeFile(target, patched);
    console.log(`[agent-runtime] wrote ${targetPath} unified=${unifiedVersion}`);
  }
  const checksumTarget = `${target}.sha256`;
  if (fs.existsSync(checksumTarget)) {
    const checksum = `${crypto.createHash("sha256").update(patched).digest("hex")}  ${path.basename(target)}\n`;
    if (fs.readFileSync(checksumTarget, "utf8") !== checksum) {
      writeRuntimeFile(checksumTarget, checksum);
      console.log(`[agent-runtime] wrote ${path.relative(root, checksumTarget)}`);
    }
  }
}
const manifestOut = path.join(root, "dist/runtime/RuntimeManifest.json");
const agentContent = fs.readFileSync(path.join(root, "dist/runtime/cluster_agent.py"), "utf8");
const schedulerContent = fs.readFileSync(path.join(root, "dist/runtime/cluster_scheduler.py"), "utf8");
function sha256TextRuntime(text) { return crypto.createHash("sha256").update(text, "utf8").digest("hex"); }
// installedAt 语义：组件内容实际发生变化的时间。version/sha256/remotePath 均未变时沿用原值，
// 否则每次构建都会刷新时间戳，使已跟踪的 dist 产物产生无意义的 diff。
const previousManifest = (() => {
  if (!fs.existsSync(manifestOut)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestOut, "utf8"));
  } catch {
    return null;
  }
})();
function resolveInstalledAt(key, fingerprint) {
  const prev = previousManifest && previousManifest.components ? previousManifest.components[key] : null;
  if (
    prev &&
    prev.version === fingerprint.version &&
    prev.sha256 === fingerprint.sha256 &&
    prev.remotePath === fingerprint.remotePath &&
    typeof prev.installedAt === "string" &&
    prev.installedAt
  ) {
    return prev.installedAt;
  }
  return new Date().toISOString();
}
const hubAgentFingerprint = { version: unifiedVersion, sha256: sha256TextRuntime(agentContent), remotePath: "simple_cluster/runtime/cluster_agent.py" };
const schedulerFingerprint = { version: unifiedVersion, sha256: sha256TextRuntime(schedulerContent), remotePath: "simple_cluster/runtime/cluster_scheduler.py" };
const expectedManifest = {
  schemaVersion: 1,
  pluginVersion: unifiedVersion,
  runtimeVersion: unifiedVersion,
  unifiedVersion: unifiedVersion,
  components: {
    hub_agent: { ...hubAgentFingerprint, installedAt: resolveInstalledAt("hub_agent", hubAgentFingerprint) },
    cluster_scheduler: { ...schedulerFingerprint, installedAt: resolveInstalledAt("cluster_scheduler", schedulerFingerprint) },
  },
};
const manifestText = JSON.stringify(expectedManifest, null, 2) + "\n";
const previousManifestText = fs.existsSync(manifestOut) ? fs.readFileSync(manifestOut, "utf8") : "";
if (previousManifestText === manifestText) {
  console.log(`[agent-runtime] kept ${path.relative(root, manifestOut)} unified=${unifiedVersion}`);
} else {
  fs.mkdirSync(path.dirname(manifestOut), { recursive: true });
  writeRuntimeFile(manifestOut, manifestText);
  console.log(`[agent-runtime] wrote ${path.relative(root, manifestOut)} unified=${unifiedVersion}`);
}

const templates = path.join(root, "dist/templates/project-adapter");
if (!fs.existsSync(templates)) {
  throw new Error("[agent-runtime] missing dist/templates/project-adapter");
}
console.log("[agent-runtime] kept dist/templates/project-adapter");
