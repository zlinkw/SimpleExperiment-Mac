import * as http from "http";
import { optionalApi } from "./api";

export interface RuntimeProgress {
  epoch: number | null;
  max_epoch: number | null;
  batch: number | null;
  total_batch: number | null;
  percent: number | null;
  loss: number | null;
  lr: string | null;
  memory: string | null;
}

export interface RuntimeObservation {
  run_id: string;
  plan: string;
  status: "running";
  worker: { id: string; host: string };
  tmux: { session: string; window: string; pane: string };
  stage: string;
  progress: RuntimeProgress | null;
  gpu: { id: string; memory: string; utilization: string };
  config: { path: string; experiment_case: string; seed: string; model: string; dataset: string; max_epoch: number | null };
  worker_task: {
    id: string;
    status: string;
    plan: string;
    gpu_id: string;
    experiment_case: string;
    seed: string;
    started_at: string;
    finished_at: string;
    log_updated_at: string;
    output_dir: string;
    config_path: string;
  } | null;
  log: string;
  updated_at: string;
}

interface WorkerEndpoint {
  id: string;
  host: string;
  port: number;
}

export async function observeRunningExperiments(): Promise<RuntimeObservation[]> {
  const endpoints = await enabledWorkerEndpoints();
  const observed: RuntimeObservation[] = [];
  for (const endpoint of endpoints) {
    const sessions = await tmuxList(endpoint);
    for (const session of sessions) {
      for (const window of session.windows || []) {
        const runId = runIdFromName(window.name);
        if (!runId) continue;
        const workerTask = workerTaskFromWindow(window);
        if (workerTask && terminalWorkerTaskStatus(workerTask.status)) continue;
        const capture = await tmuxCapture(endpoint, window.target || `${session.name}:${window.index}`);
        if (!capture) continue;
        const observation = observationFromCapture(endpoint, session.name, window, capture);
        observation.config = await configFromWorker(endpoint, observation.config);
        observation.progress = parseTrainingProgress(capture, observation.config.max_epoch);
        if (observation.progress?.memory) observation.gpu.memory = observation.progress.memory;
        observed.push(observation);
      }
    }
  }
  return observed;
}

export function observationFromCapture(
  endpoint: WorkerEndpoint,
  sessionName: string,
  window: { index?: string; name?: string; target?: string; panes?: Array<{ index?: string; target?: string }>; task?: Record<string, unknown> },
  text: string,
): RuntimeObservation {
  const pane = (window.panes || [])[0] || {};
  const workerTask = workerTaskFromWindow(window);
  const fields = launchFields(text);
  const progress = parseTrainingProgress(text);
  return {
    run_id: runIdFromName(window.name) || "",
    plan: fields.plan || workerTask?.plan || "",
    status: "running",
    worker: { id: fields.worker_id || endpoint.id, host: endpoint.host },
    tmux: {
      session: sessionName,
      window: window.target || `${sessionName}:${window.index || ""}`,
      pane: pane.target || `${window.target || sessionName}.0`,
    },
    stage: fields.stage || "",
    progress,
    gpu: {
      id: fields.gpu_ids || workerTask?.gpu_id || "",
      memory: progress?.memory || "",
      utilization: "",
    },
    config: {
      path: fields.config_path || workerTask?.config_path || "",
      experiment_case: fields.case || workerTask?.experiment_case || "",
      seed: integerText(fields.seed) || integerText(workerTask?.seed) || "",
      model: fields.model || "",
      dataset: fields.dataset || "",
      max_epoch: null,
    },
    worker_task: workerTask,
    log: text.trim(),
    updated_at: new Date().toISOString(),
  };
}

export function currentTrainingLoopPercent(
  epoch: number | null,
  maxEpoch: number | null,
  batch: number | null,
  totalBatch: number | null,
  epochPercent: number | null,
): number | null {
  if (!Number.isFinite(epoch) || !Number.isFinite(maxEpoch) || maxEpoch === null || maxEpoch <= 0) return null;
  const currentEpoch = Math.min(maxEpoch, Math.max(1, epoch as number));
  let withinEpoch = 0;
  if (Number.isFinite(batch) && Number.isFinite(totalBatch) && totalBatch !== null && totalBatch > 0) {
    withinEpoch = Math.min(1, Math.max(0, (batch as number) / totalBatch));
  } else if (Number.isFinite(epochPercent)) {
    withinEpoch = Math.min(1, Math.max(0, (epochPercent as number) / 100));
  }
  const completedEpochs = Math.max(0, currentEpoch - 1);
  const loopPercent = (completedEpochs + withinEpoch) / maxEpoch * 100;
  return Math.round(Math.min(100, Math.max(0, loopPercent)) * 10) / 10;
}

/** @deprecated Use currentTrainingLoopPercent. */
export function overallTrainingPercent(
  epoch: number | null,
  maxEpoch: number | null,
  batch: number | null,
  totalBatch: number | null,
  epochPercent: number | null,
): number | null {
  return currentTrainingLoopPercent(epoch, maxEpoch, batch, totalBatch, epochPercent);
}

function lastRegexMatch(text: string, regex: RegExp): RegExpExecArray | null {
  const pattern = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  let latest: RegExpExecArray | null = null;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) latest = match;
  return latest;
}

type RichProgressCandidate = {
  index: number;
  line: string;
  phase: "train" | "val" | "test" | "unknown";
  epoch: number | null;
  maxEpoch: number | null;
  epochPercent: number | null;
  batch: number | null;
  totalBatch: number | null;
};

function latestRichProgressCandidate(text: string): RichProgressCandidate | null {
  let latest: RichProgressCandidate | null = null;
  for (const match of text.matchAll(/[^\r\n]+/g)) {
    const line = match[0];
    const epoch = line.match(/\bepoch\s+(\d+)\s*\/\s*(\d+)/i);
    const compact = line.match(/^\s*(Val low|Val clean|Train|Val|Test)(?=\s|$)/i);
    const percent = line.match(/(\d+(?:\.\d+)?)\s*%/);
    const columns = line.match(/(\d+(?:\.\d+)?)\s*%[^\r\n]*?(\d+)\s*\/\s*(\d+)/);
    if ((!epoch || !percent) && (!compact || !columns)) continue;
    const label = compact?.[1] || line.match(/\[(Train|Val(?:\s+(?:low|clean))?|Test)\]/i)?.[1] || "";
    const phase = /^train$/i.test(label) ? "train" : /^val(?:\s|$)/i.test(label) ? "val" : /^test$/i.test(label) ? "test" : "unknown";
    latest = {
      index: match.index,
      line,
      phase,
      epoch: epoch ? Number(epoch[1]) : null,
      maxEpoch: epoch ? Number(epoch[2]) : null,
      epochPercent: percent ? Number(percent[1]) : null,
      batch: columns ? Number(columns[2]) : null,
      totalBatch: columns ? Number(columns[3]) : null,
    };
  }
  return latest;
}

export function parseTrainingProgress(text: string, maxEpochHint: number | null = null): RuntimeProgress | null {
  const source = String(text || "");
  const rich = latestRichProgressCandidate(source);
  const standardEpoch = lastRegexMatch(source, /\bEpoch\s+(\d+)\s*:[^\r\n]*/gi);
  const latestEpochIndex = Math.max(rich?.index ?? -1, standardEpoch?.index ?? -1);
  const laterPhase = lastRegexMatch(source, /(?:^|\r?\n)\s*(?:\[simple-experiment-runtime\]\s+done\b|Starting[^\r\n]*\binference\b)/gim);
  if (latestEpochIndex >= 0 && laterPhase && laterPhase.index > latestEpochIndex) return null;
  if (rich && rich.phase === "test" && (!standardEpoch || rich.index > standardEpoch.index)) return null;
  if (standardEpoch && (!rich || standardEpoch.index > rich.index)) {
    const epochValue = Number(standardEpoch[1]);
    const maxEpochValue = Number.isInteger(maxEpochHint) && Number(maxEpochHint) > 0 ? maxEpochHint : null;
    const loss = standardEpoch[0].match(/\bVal\s+Loss\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?![\w.])/i);
    return {
      epoch: epochValue,
      max_epoch: maxEpochValue,
      batch: null,
      total_batch: null,
      percent: currentTrainingLoopPercent(epochValue, maxEpochValue, null, null, 100),
      loss: loss ? Number(loss[1]) : null,
      lr: null,
      memory: null,
    };
  }
  const block = rich ? source.slice(rich.index).split(/\r\n|\n|\r/).slice(0, 3).join("\n") : source;
  const loss = block.match(/当前\s*loss\s+([0-9]+(?:\.[0-9]+)?)/i);
  const lr = block.match(/\blr\s+([0-9]+(?:\.[0-9]+)?e[+-]?\d+)/i);
  const memory = block.match(/显存\s+([0-9]+(?:\.[0-9]+)?\s*GiB)/i);
  if (!rich && !loss && !lr && !memory) return null;
  const epochValue = rich?.epoch ?? null;
  const maxEpochValue = rich ? (rich.maxEpoch ?? (Number.isInteger(maxEpochHint) && Number(maxEpochHint) > 0 ? maxEpochHint : null)) : null;
  return {
    epoch: epochValue,
    max_epoch: maxEpochValue,
    batch: rich?.batch ?? null,
    total_batch: rich?.totalBatch ?? null,
    percent: currentTrainingLoopPercent(epochValue, maxEpochValue, rich?.batch ?? null, rich?.totalBatch ?? null, rich?.epochPercent ?? null),
    loss: loss ? Number(loss[1]) : null,
    lr: lr ? lr[1] : null,
    memory: memory ? memory[1].replace(/\s+/g, " ") : null,
  };
}

export function matchesRuntime(query: string, observation: RuntimeObservation, operationId = ""): boolean {
  const wanted = String(query || "").trim();
  if (!wanted) return false;
  return [observation.worker_task?.id, observation.run_id, observation.plan, observation.tmux.window, observation.tmux.session, operationId]
    .some((value) => value && (value === wanted || value.endsWith(wanted) || wanted.endsWith(value)));
}

async function enabledWorkerEndpoints(): Promise<WorkerEndpoint[]> {
  const state = await optionalApi("state.get", { key: "setupConfig" });
  const setup = asRecord(asRecord(state).value);
  const workers = Array.isArray(setup.workerTunnels) ? setup.workerTunnels.map(asRecord) : [];
  const out: WorkerEndpoint[] = [];
  for (const worker of workers) {
    if (worker.enabled === false) continue;
    const port = Number(worker.localForwardPort);
    if (!Number.isInteger(port) || port <= 0) continue;
    out.push({
      id: String(worker.id || worker.displayName || ""),
      host: String(worker.localForwardHost || worker.localHost || "127.0.0.1"),
      port,
    });
  }
  return out;
}

export async function readWorkerResultRecords(): Promise<Array<Record<string, unknown>>> {
  const endpoints = await enabledWorkerEndpoints();
  const groups = await Promise.all(endpoints.map(async (endpoint) => {
    try {
      const payload = await agentGet(endpoint, "/api/results/summary");
      const results = Array.isArray(payload?.results) ? payload.results : [];
      return results.map(asRecord).filter((row) => Object.keys(row).length > 0 && !isDiagnosticWorkerResult(row));
    } catch {
      return [];
    }
  }));
  return groups.flat();
}

export function isDiagnosticWorkerResult(row: Record<string, unknown>): boolean {
  const sources = row.sourceFiles;
  if (!Array.isArray(sources) || sources.length === 0) return false;
  return sources.every((source) => {
    const filePath = String(asRecord(source).path || "").replace(/\\/g, "/");
    const base = filePath.split("/").pop()?.toLowerCase() || "";
    return base === "stdout.log" || base === "stderr.log";
  });
}

async function tmuxList(endpoint: WorkerEndpoint): Promise<Array<{ name: string; windows: Array<Record<string, any>> }>> {
  const payload = await agentGet(endpoint, "/api/tmux/list");
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  return sessions.map((session) => ({
    name: String(asRecord(session).name || ""),
    windows: Array.isArray(asRecord(session).windows) ? asRecord(session).windows as Array<Record<string, any>> : [],
  })).filter((session) => session.name);
}

function workerTaskFromWindow(window: Record<string, any>): RuntimeObservation["worker_task"] {
  const task = asRecord(window.task);
  const id = String(task.runKey || task.commandId || task.operationId || "").trim();
  if (!id) return null;
  return {
    id,
    status: String(task.status || "").trim(),
    plan: String(task.planFile || task.plan || "").trim(),
    gpu_id: String(task.gpuId ?? task.gpu_id ?? "").trim(),
    experiment_case: String(task.case || task.experimentCase || task.experiment_case || "").trim(),
    seed: String(task.seed ?? "").trim(),
    started_at: String(task.startedAt || task.started_at || "").trim(),
    finished_at: String(task.finishedAt || task.finished_at || "").trim(),
    log_updated_at: String(task.logUpdatedAt || task.log_updated_at || "").trim(),
    output_dir: String(task.outputDir || task.output_dir || "").trim(),
    config_path: String(task.configPath || task.config_path || "").trim(),
  };
}

function terminalWorkerTaskStatus(status: string): boolean {
  return new Set([
    "completed", "success", "succeeded", "normal_completed",
    "failed", "error", "completed_with_errors",
    "stopped", "cancelled", "canceled", "interrupted", "manual_interrupted_completed",
  ]).has(status.trim().toLowerCase());
}

async function tmuxCapture(endpoint: WorkerEndpoint, target: string, lines = 2000): Promise<string> {
  const boundedLines = Math.max(200, Math.min(4000, Math.trunc(lines) || 2000));
  const payload = await agentGet(endpoint, `/api/tmux/capture?window=${encodeURIComponent(target)}&lines=${boundedLines}`);
  return String(payload?.text || payload?.output || "");
}

export async function readWorkerTaskConfig(workerId: string, taskId: string, configPathHint = "", logPathHint = ""): Promise<{ config_path: string; yaml: string }> {
  const empty = { config_path: configPathHint, yaml: "" };
  try {
    const endpoint = (await enabledWorkerEndpoints()).find((item) => item.id.toLowerCase() === workerId.trim().toLowerCase());
    if (!endpoint || !taskId.trim()) return empty;
    const download = async (configPath: string): Promise<string> => {
      const yaml = await agentText(endpoint, `/api/files/download?path=${encodeURIComponent(configPath)}&maxBytes=200000`);
      return yaml && !yaml.startsWith("{") ? yaml : "";
    };
    if (configPathHint) {
      const yaml = await download(configPathHint);
      if (yaml) return { config_path: configPathHint, yaml };
    }
    if (logPathHint) {
      const prefix = await agentText(endpoint, `/api/files/download-range?path=${encodeURIComponent(logPathHint)}&start=0&end=${256 * 1024}`);
      const recovered = workerLaunchConfigText(prefix, configPathHint);
      if (recovered.yaml) return recovered;
    }
    for (const session of await tmuxList(endpoint)) {
      for (const window of session.windows) {
        if (workerTaskFromWindow(window)?.id !== taskId) continue;
        const configPath = workerTaskFromWindow(window)?.config_path || "";
        if (configPath) {
          const yaml = await download(configPath);
          if (yaml) return { config_path: configPath, yaml };
        }
        const target = String(window.target || `${session.name}:${window.index || ""}`);
        const capture = await tmuxCapture(endpoint, target, 4000);
        const recoveredPath = launchFields(capture).config_path;
        if (!recoveredPath) return empty;
        const yaml = await download(recoveredPath);
        return yaml ? { config_path: recoveredPath, yaml } : empty;
      }
    }
  } catch {
    return empty;
  }
  return empty;
}

function agentGet(endpoint: WorkerEndpoint, urlPath: string): Promise<Record<string, any> | null> {
  return agentText(endpoint, urlPath).then((text) => {
    if (!text) return null;
    try { return JSON.parse(text) as Record<string, any>; } catch { return null; }
  });
}

function agentText(endpoint: WorkerEndpoint, urlPath: string): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request({
      host: endpoint.host,
      port: endpoint.port,
      path: urlPath,
      method: "GET",
      timeout: 5000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(res.statusCode === 200 || res.statusCode === 206 ? Buffer.concat(chunks).toString("utf8") : ""));
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.end();
  });
}

function workerLaunchConfigText(text: string, configPathHint = ""): { config_path: string; yaml: string } {
  const contexts: Array<Record<string, unknown>> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const marker = text.indexOf("--context-json", cursor);
    if (marker < 0) break;
    const start = text.indexOf("{", marker + "--context-json".length);
    if (start < 0 || text.slice(marker, start).includes("\n")) break;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = start;
    for (; end < text.length; end++) {
      const char = text[end];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === "\\") { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { end++; break; }
    }
    cursor = Math.max(end, marker + "--context-json".length);
    if (depth !== 0 || quoted) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) contexts.push(parsed as Record<string, unknown>);
    } catch { /* Ignore an incomplete or malformed launch context. */ }
  }
  const paths = new Set(contexts.map((item) => String(item.config_path || item.config || "").replace(/\\/g, "/").trim()).filter(Boolean));
  const yamls = new Set(contexts.map((item) => String(item.config_text || "")).filter(Boolean));
  const configPath = paths.size === 1 ? paths.values().next().value || "" : "";
  const yaml = yamls.size === 1 ? yamls.values().next().value || "" : "";
  if (!configPath || !yaml || (configPathHint && configPath !== configPathHint.replace(/\\/g, "/").trim())) return { config_path: configPathHint, yaml: "" };
  return { config_path: configPath, yaml };
}

async function configFromWorker(endpoint: WorkerEndpoint, config: RuntimeObservation["config"]): Promise<RuntimeObservation["config"]> {
  const hasMaxEpoch = Number.isInteger(config.max_epoch) && Number(config.max_epoch) > 0;
  if (!config.path || (config.model && config.dataset && config.experiment_case && hasMaxEpoch)) return config;
  const yaml = await agentText(endpoint, `/api/files/download?path=${encodeURIComponent(config.path)}&maxBytes=200000`);
  if (!yaml || yaml.startsWith("{")) return config;
  return {
    ...config,
    experiment_case: experimentCase(yaml) || config.experiment_case,
    model: config.model || nestedYamlValue(yaml, "model", "name") || nestedYamlValue(yaml, "model", "joint_encoder"),
    dataset: config.dataset || nestedYamlValue(yaml, "data", "dataset"),
    seed: integerText(config.seed) || integerText(yamlValue(yaml, "seed")),
    max_epoch: hasMaxEpoch ? config.max_epoch : trainingMaxEpochFromYaml(yaml),
  };
}

function launchFields(text: string): Record<string, string> {
  const raw = String(text || "");
  const source = unwrapTerminalText(raw);
  const configPath = jsonStringField(source, "config_path") || jsonStringField(source, "config") || flagValue(source, "config");
  const yaml = yamlObject(source);
  return {
    plan: jsonStringField(source, "plan") || jsonStringField(source, "plan_file"),
    worker_id: jsonStringField(source, "worker_id"),
    gpu_ids: jsonStringField(source, "gpu_ids"),
    config_path: configPath,
    case: experimentCase(yaml) || flagValue(source, "case") || pathTail(configPath),
    seed: jsonIntegerField(source, "seed") || integerFlagValue(raw, "seed") || pathSeed(configPath) || integerText(yamlValue(yaml, "seed")),
    model: yamlValue(yaml, "model") || yamlValue(yaml, "encoder_profile"),
    dataset: yamlValue(yaml, "dataset") || yamlValue(yaml, "data"),
    stage: stageFromCommand(source),
  };
}

function unwrapTerminalText(text: string): string {
  return String(text || "").replace(/\r?\n/g, "");
}

function yamlObject(text: string): string {
  const marker = text.lastIndexOf('{"');
  return marker >= 0 ? text.slice(0, marker) : text;
}

function jsonStringField(text: string, key: string): string {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]+)`));
  return match ? match[1] : "";
}

function integerText(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^[+-]?\d+$/.test(text) ? text : "";
}

function jsonIntegerField(text: string, key: string): string {
  const match = String(text || "").match(new RegExp(`"${key}"\\s*:\\s*([+-]?\\d+)(?=\\s*[,}])`));
  return match ? integerText(match[1]) : "";
}

function integerFlagValue(text: string, name: string): string {
  return integerText(flagValue(text, name));
}

function stageFromCommand(text: string): string {
  const match = String(text || "").match(/--stage\s+([A-Za-z0-9_-]+)/);
  return match ? match[1] : "";
}

function flagValue(text: string, name: string): string {
  const pattern = "--" + name + "\\s+(\\S+)";
  const match = String(text || "").match(new RegExp(pattern));
  return match ? match[1] : "";
}

function pathTail(value: string): string {
  const name = value.split("/").pop() || "";
  return name.replace(/_seed\d+$/, "").replace(/^\d+_/, "");
}

function pathSeed(value: string): string {
  return value.match(/_seed(\d+)(?:\/|$)/)?.[1] || "";
}

function yamlValue(text: string, key: string): string {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*([^#\\n]+)`));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : "";
}

function experimentCase(text: string): string {
  const named = yamlValue(text, "experiment_name").split("/").filter(Boolean);
  return named.length >= 2 ? named[named.length - 2] : "";
}

export function nestedYamlValue(text: string, section: string, key: string): string {
  const block = String(text || "").match(new RegExp(`(?:^|\\n)${section}:\\n((?:[ \\t]+.*\\n?)*)`));
  return block ? yamlValue(`\n${block[1]}`, key) : "";
}

export function trainingMaxEpochFromYaml(yaml: string): number | null {
  for (const key of ["epochs", "max_epochs", "num_epochs"]) {
    const raw = nestedYamlValue(yaml, "train", key);
    const value = Number(integerText(raw));
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  for (const key of ["epochs", "max_epochs", "num_epochs"]) {
    const match = String(yaml || "").match(new RegExp(`(?:^|\\n)${key}\\s*:\\s*([^#\\n]+)`));
    const value = Number(integerText(match?.[1]));
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function runIdFromName(value: unknown): string {
  const name = String(value || "").trim();
  return /^run-\d+$/.test(name) ? name : "";
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
