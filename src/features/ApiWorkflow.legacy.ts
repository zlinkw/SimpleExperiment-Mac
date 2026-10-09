export const FLOW_STEPS = [
  "select_servers",
  "select_mode",
  "prepare_agents",
  "validate_plan",
  "dry_run",
  "upload",
  "run",
  "parse_results",
  "quality_gate",
  "statistics",
  "claims_export",
] as const;

export type FlowStepName = typeof FLOW_STEPS[number];

export interface FlowStepRecord {
  completed?: boolean;
  blocked?: boolean;
  appliedAt?: string;
}

export interface WorkflowFlowState {
  schemaVersion: 1;
  updatedAt?: string;
  currentStep: FlowStepName;
  steps: Record<FlowStepName, FlowStepRecord>;
}

export interface MissingInventoryOptions {
  workspace?: string;
  setup?: Record<string, unknown>;
  topology?: Record<string, unknown>;
  simpleSftp?: Record<string, unknown>;
  project?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  requirePlan?: boolean;
}

export interface MissingStep {
  step: string;
  reason: string;
  options: string[];
  requiredConfirm: string[];
}

export function defaultFlowState(): WorkflowFlowState {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    currentStep: FLOW_STEPS[0],
    steps: Object.fromEntries(FLOW_STEPS.map((step) => [step, {}])) as Record<FlowStepName, FlowStepRecord>,
  };
}

export function normalizeFlowState(input: unknown): WorkflowFlowState {
  const fallback = defaultFlowState();
  if (!input || typeof input !== "object" || Array.isArray(input)) return fallback;
  const raw = input as Partial<WorkflowFlowState>;
  const rawSteps = raw.steps && typeof raw.steps === "object" && !Array.isArray(raw.steps)
    ? raw.steps as Partial<Record<FlowStepName, FlowStepRecord>>
    : {};
  const steps = Object.fromEntries(FLOW_STEPS.map((step) => {
    const value = rawSteps[step];
    return [step, value && typeof value === "object" && !Array.isArray(value) ? value : {}];
  })) as Record<FlowStepName, FlowStepRecord>;
  const firstIncomplete = FLOW_STEPS.find((step) => !steps[step].completed && !steps[step].blocked) || FLOW_STEPS[FLOW_STEPS.length - 1];
  const currentStep = FLOW_STEPS.find((step) => step === raw.currentStep) || firstIncomplete;
  return {
    schemaVersion: 1,
    updatedAt: String(raw.updatedAt || fallback.updatedAt || ""),
    currentStep,
    steps,
  };
}

export function advanceFlowStep(state: WorkflowFlowState, step: string, patch: FlowStepRecord = {}): WorkflowFlowState {
  const current = normalizeFlowState(state);
  const name = FLOW_STEPS.find((item) => item === String(step || "").trim()) as FlowStepName | undefined;
  if (!name) throw new Error(`未知流程步骤：${String(step || "")}。可用步骤：${FLOW_STEPS.join(", ")}`);
  const nextRecord: FlowStepRecord = {
    ...current.steps[name],
    ...patch,
    appliedAt: patch.appliedAt || new Date().toISOString(),
  };
  const nextSteps = { ...current.steps, [name]: nextRecord };
  const firstIncomplete = FLOW_STEPS.find((item) => !nextSteps[item].completed && !nextSteps[item].blocked) || FLOW_STEPS[FLOW_STEPS.length - 1];
  return {
    schemaVersion: current.schemaVersion,
    updatedAt: new Date().toISOString(),
    currentStep: firstIncomplete,
    steps: nextSteps,
  };
}

export function nextFlowStep(state: WorkflowFlowState): string {
  const current = normalizeFlowState(state);
  const blocked = FLOW_STEPS.find((item) => current.steps[item].blocked);
  if (blocked) return blocked;
  const incomplete = FLOW_STEPS.find((item) => !current.steps[item].completed);
  if (incomplete) return incomplete;
  return FLOW_STEPS[FLOW_STEPS.length - 1];
}

export function filterPlans(plans: readonly Record<string, unknown>[], filter: Record<string, unknown> = {}): {
  plans: Record<string, unknown>[];
  count: number;
  total: number;
  needsChoice: boolean;
} {
  const list = Array.isArray(plans) ? plans.filter((item) => item && typeof item === "object") : [];
  const status = new Set(
    Array.isArray(filter.status)
      ? filter.status.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
      : String(filter.status || "").trim().toLowerCase() ? [String(filter.status || "").trim().toLowerCase()] : [],
  );
  const query = String(filter.query || "").trim().toLowerCase();
  const planFile = String(filter.planFile || "").trim();
  const planId = String(filter.planId || "").trim();
  const includeArchived = filter.archived === true;
  const candidates = list.filter((item) => {
    if (!includeArchived && item.archived === true) return false;
    const file = String(item.planFile || item.file || item.planId || "");
    const id = String(item.planId || item.planFile || file || "");
    if (planFile && file !== planFile) return false;
    if (planId && id !== planId && file !== planId) return false;
    if (status.size) {
      const itemStatus = String(item.status || item.state || "").trim().toLowerCase();
      if (!status.has(itemStatus)) return false;
    }
    if (query) {
      const haystack = [String(item.name || ""), file, id, String(item.suite || ""), String(item.description || "")].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
  const uniqueFiles = new Set(candidates.map((item) => String(item.planFile || item.file || item.planId || "").trim()).filter(Boolean));
  const needsChoice = filter.needsChoice === true
    ? uniqueFiles.size > 1
    : candidates.some((item) => item.needsChoice === true || item.needsSelection === true || item.selectRequired === true);
  const limit = Math.max(0, Number(filter.limit) || 0);
  const output = limit > 0 ? candidates.slice(0, Math.floor(limit)) : candidates;
  return { plans: output, count: candidates.length, total: list.length, needsChoice };
}

export interface WorkflowPlanSelection {
  plan?: Record<string, unknown>;
  plans: Record<string, unknown>[];
  count: number;
  total: number;
  needsChoice: boolean;
  missing: MissingStep[];
}

function planIdentityValues(plan: Record<string, unknown>): string[] {
  return [plan.planFile, plan.file, plan.planId]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

export function selectWorkflowPlan(
  plans: readonly Record<string, unknown>[],
  selection: Record<string, unknown> = {},
): WorkflowPlanSelection {
  const list = Array.isArray(plans) ? plans.filter((item) => item && typeof item === "object") : [];
  const requestedFile = String(selection.planFile || selection.file || "").trim();
  const requestedId = String(selection.planId || "").trim();
  let plan: Record<string, unknown> | undefined;
  if (requestedFile) {
    plan = list.find((item) => planIdentityValues(item).includes(requestedFile));
  } else if (requestedId) {
    plan = list.find((item) => planIdentityValues(item).includes(requestedId));
  } else if (list.length === 1) {
    plan = list[0];
  }

  const missing: MissingStep[] = [];
  if (!plan) {
    if (list.length > 1) {
      missing.push({
        step: "validate_plan",
        reason: "需要选择 PLAN",
        options: ["plans.filter"],
        requiredConfirm: [],
      });
    } else if (requestedFile || requestedId) {
      missing.push({
        step: "validate_plan",
        reason: `未找到指定 PLAN：${requestedFile || requestedId}`,
        options: ["plans.filter"],
        requiredConfirm: [],
      });
    } else {
      missing.push({
        step: "validate_plan",
        reason: "未找到可自动选择的 PLAN",
        options: ["plans.list", "plans.filter"],
        requiredConfirm: [],
      });
    }
  }

  return {
    plan,
    plans: list,
    count: list.length,
    total: list.length,
    needsChoice: !plan && list.length > 1,
    missing,
  };
}

export function remoteProjectWorkDir(remoteRoot: unknown, projectName: unknown): string | undefined {
  const root = normalizeApiRemotePath(remoteRoot);
  const name = String(projectName || "").trim();
  return root && name && name !== "." && name !== ".." ? `${root}/${name}` : undefined;
}

export interface WorkflowRouteOptions {
  infrastructureMissing: MissingStep[];
  planSelection: WorkflowPlanSelection;
  validationMissing: MissingStep[];
  prepareParams?: Record<string, unknown>;
  runParams?: Record<string, unknown>;
}

export interface WorkflowCall {
  method: string;
  params: Record<string, unknown>;
}

export interface WorkflowRoute {
  ready: boolean;
  phase: "prepare_agents" | "select_plan" | "validate_plan" | "run";
  nextAction: string;
  calls: WorkflowCall[];
  missing: MissingStep[];
}

function uniqueMissingSteps(rows: readonly MissingStep[]): MissingStep[] {
  return [...new Map(rows.map((row) => [`${row.step}:${row.reason}`, row])).values()];
}

export function buildWorkflowRoute(options: WorkflowRouteOptions): WorkflowRoute {
  const infrastructureMissing = Array.isArray(options.infrastructureMissing) ? options.infrastructureMissing : [];
  const selection = options.planSelection;
  const validationMissing = Array.isArray(options.validationMissing) ? options.validationMissing : [];
  const prepareParams = options.prepareParams && typeof options.prepareParams === "object" ? options.prepareParams : {};
  const runParams = options.runParams && typeof options.runParams === "object" ? options.runParams : {};

  if (infrastructureMissing.length) {
    return {
      ready: false,
      phase: "prepare_agents",
      nextAction: "project.prepare",
      calls: [{ method: "project.prepare", params: prepareParams }],
      missing: uniqueMissingSteps([...infrastructureMissing, ...(selection?.missing || [])]),
    };
  }
  if (!selection?.plan) {
    return {
      ready: false,
      phase: "select_plan",
      nextAction: "plans.filter",
      calls: [{ method: "plans.filter", params: { limit: 50 } }],
      missing: uniqueMissingSteps(selection?.missing || []),
    };
  }
  if (validationMissing.length) {
    const agentRows = validationMissing.filter((row) => row.step === "prepare_agents");
    if (agentRows.length === validationMissing.length) {
      return {
        ready: false,
        phase: "prepare_agents",
        nextAction: "project.prepare",
        calls: [
          { method: "project.prepare", params: prepareParams },
          { method: "server.testAll", params: { refresh: true } },
        ],
        missing: uniqueMissingSteps(validationMissing),
      };
    }
    return {
      ready: false,
      phase: "validate_plan",
      nextAction: "plan.validate",
      calls: [{
        method: "plan.validate",
        params: {
          planFile: String(selection.plan.planFile || selection.plan.file || ""),
          planId: String(selection.plan.planId || selection.plan.planFile || selection.plan.file || ""),
        },
      }],
      missing: uniqueMissingSteps(validationMissing),
    };
  }
  return {
    ready: true,
    phase: "run",
    nextAction: "workflow.run",
    calls: [{ method: "workflow.run", params: runParams }],
    missing: [],
  };
}

export function isWorkerServer(server: unknown): boolean {
  const item = server && typeof server === "object" ? server as Record<string, unknown> : {};
  const id = String(item.id || item.serverId || "");
  const label = String(item.label || item.name || item.displayName || "");
  const host = String(item.host || item.sshHost || item.resolvedHost || "");
  return [id, label, host].some((value) => /(^|[^a-z0-9])worker([^a-z0-9]|$)/i.test(value));
}
// 兼容历史调用：保留 isNwpu3Server 别名，统一走通用 isWorkerServer
export const isNwpu3Server = isWorkerServer;

export function normalizeApiRemotePath(value: unknown): string | undefined {
  const text = String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!text || text === "/" || text === "." || text === "..") return undefined;
  return text.replace(/\/+$/, "");
}

export interface RemoteRootPolicy {
  allowedRoots?: unknown;
  deniedRoots?: unknown;
}

export function resolveApiRemoteRoot(value: unknown, server: unknown = {}): string | undefined {
  return resolveApiRemoteRootWithPolicy(value, server, {});
}

function normalizedRemoteRootList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeApiRemotePath(item)).filter((item): item is string => Boolean(item));
}

function containsRootOrDescendant(root: string, roots: string[]): boolean {
  const lower = root.toLowerCase();
  return roots.some((item) => {
    const candidate = item.toLowerCase();
    return lower === candidate || lower.startsWith(`${candidate}/`);
  });
}

export function resolveApiRemoteRootWithPolicy(
  value: unknown,
  server: unknown = {},
  policy: RemoteRootPolicy = {},
): string | undefined {
  const root = normalizeApiRemotePath(value);
  if (!root) return undefined;

  // User configuration always supplies the root. These are generic safety
  // policies; server-specific storage paths must not be substituted here.
  if (root.split("/").includes("..")) throw new Error("项目父目录不能包含 ..。");
  const allowedRoots = normalizedRemoteRootList(policy.allowedRoots);
  const migrationHint = remoteRootMigrationHint(root, allowedRoots.concat(normalizedRemoteRootList(policy.deniedRoots)));
  if (migrationHint) throw new Error(migrationHint);
  const deniedRoots = normalizedRemoteRootList(policy.deniedRoots);
  if (containsRootOrDescendant(root, deniedRoots)) {
    throw new Error(`项目父目录被 remote.deniedRoots 禁止：${root}`);
  }
  if (allowedRoots.length && !containsRootOrDescendant(root, allowedRoots)) {
    throw new Error(`项目父目录必须匹配 remote.allowedRoots 中的配置：${root}`);
  }
  if (["simple_agent", "zlk_agent"].some((segment) => root.toLowerCase().split("/").includes(segment))) {
    throw new Error("项目父目录不能包含 simple_agent 或 zlk_agent；插件会自动管理同级 Agent runtime。");
  }
  return root;
}

export function remoteRootMigrationHint(root: string, knownRoots: string[]): string | undefined {
  const lowerSegments = String(root || "").toLowerCase().split("/").filter(Boolean);
  if (!lowerSegments.includes("simple")) return undefined;
  const canonicalSegments = lowerSegments.map((segment) => segment === "simple" ? "zlk" : segment);
  const canonicalCandidate = `${root.startsWith("/") ? "/" : ""}${canonicalSegments.join("/")}`;
  const hasKnownRealCounterpart = knownRoots.some((knownRoot) => (
    knownRoot.toLowerCase() === canonicalCandidate
      || canonicalCandidate.startsWith(`${knownRoot.toLowerCase()}/`)
  ));
  if (!hasKnownRealCounterpart) return undefined;
  return [
    "检测到历史命名迁移缺陷生成的项目父目录；不要继续使用该路径。",
    "请在“设置 > 服务器”改回当前服务器保存的真实根目录。",
    "此校验不会改写已有归档、结果或上传路径。",
  ].join("");
}

export function structuredMissingInventory(options: MissingInventoryOptions): MissingStep[] {
  const missing: MissingStep[] = [];
  const workspace = String(options.workspace || "").trim();
  const setup = options.setup && typeof options.setup === "object" ? options.setup : {};
  const topology = options.topology && typeof options.topology === "object" ? options.topology : {};
  const simpleSftp = options.simpleSftp && typeof options.simpleSftp === "object" ? options.simpleSftp : {};
  const project = options.project && typeof options.project === "object" ? options.project : {};
  const plan = options.plan && typeof options.plan === "object" ? options.plan : {};
  const workers = Array.isArray(setup.workerTunnels) ? setup.workerTunnels.filter((worker) => worker && typeof worker === "object" && worker.enabled !== false) : [];
  const hubConfigured = Boolean(String(setup.savedSessionPath || "").trim() && String(setup.agentProjectDir || "").trim());
  const requirePlan = options.requirePlan !== false;

  if (!workspace) {
    missing.push({
      step: "select_servers",
      reason: "未打开工作区，无法确定本机上传路径和远端项目名。",
      options: ["workspace"],
      requiredConfirm: [],
    });
  }

  const workerCount = new Set(workers.map((worker) => String(worker.id || "").trim()).filter(Boolean)).size;
  const mode = String(topology.mode || topology.configuredMode || "").trim();
  if (workerCount < 1 || (String(topology.hubAllowed || topology.mode || "") === "hub_worker" && !hubConfigured)) {
    missing.push({
      step: "select_servers",
      reason: hubConfigured
        ? "需要至少一台启用的 Worker，当前 0 台。"
        : "需要先配置 Hub 会话和项目父目录，或至少一台启用的 Worker。",
      options: hubConfigured ? ["server.addWorker"] : ["config.server", "server.addWorker"],
      requiredConfirm: ["confirm"],
    });
  }

  const valid = topology.valid !== false && Boolean(mode);
  if (!valid) {
    const issueText = Array.isArray(topology.issues) && topology.issues.length
      ? topology.issues.join("；")
      : "需要在单 Worker、仅多 Worker 或 Hub 可用模式中明确选择。";
    missing.push({
      step: "select_mode",
      reason: issueText,
      options: hubConfigured ? ["single_worker", "worker_pool", "hub_worker"] : ["single_worker", "worker_pool"],
      requiredConfirm: ["confirm"],
    });
  }

  if (simpleSftp.ready !== true) {
    missing.push({
      step: "prepare_agents",
      reason: String(simpleSftp.message || "配套 SimpleSFTP 未就绪，无法完成正式上传或运行。"),
      options: ["install_simple_sftp", "reload_vscode"],
      requiredConfirm: ["confirm"],
    });
  } else {
    const setupMissing = [];
    if (mode === "hub_worker" && !hubConfigured) setupMissing.push("Hub Xshell 会话和项目父目录");
    for (const worker of workers) {
      if (!String(worker.savedSessionPath || "").trim()) setupMissing.push(`${String(worker.displayName || worker.id || "Worker")} Xshell 会话`);
      if (!String(worker.agentProjectDir || "").trim()) setupMissing.push(`${String(worker.displayName || worker.id || "Worker")} 项目父目录`);
    }
    if (setupMissing.length) {
      missing.push({
        step: "prepare_agents",
        reason: `服务器配置不完整：${setupMissing.join("、")}。`,
        options: ["config.set", "server.addWorker"],
        requiredConfirm: ["confirm"],
      });
    }
  }

  if (requirePlan) {
    const planFile = String(plan.planFile || plan.file || plan.planId || "").trim();
    if (!planFile) {
      missing.push({
        step: "validate_plan",
        reason: "未选择需要验证的 Plan，且项目内没有可自动确定的唯一 Plan。",
        options: ["plans.list", "plans.filter"],
        requiredConfirm: ["confirm"],
      });
    } else {
      const diagnosticsRows = Array.isArray(project.outputGateDiagnosticsRows) ? project.outputGateDiagnosticsRows : [];
      const missingRows = Array.isArray(project.outputGateMissing) ? project.outputGateMissing : diagnosticsRows.filter((row) => row && row.ok === false);
      if (missingRows.length) {
        missing.push({
          step: "validate_plan",
          reason: `Plan 或项目输出契约未通过：${missingRows.map((row) => String(row.label || row.step || "") || "输出契约").join("、")}。`,
          options: ["generateOutputAdapter", "config.set"],
          requiredConfirm: ["confirm"],
        });
      }
    }
  }
  return missing;
}

export function serverTestRow(target: Record<string, unknown>, probe: Record<string, unknown> | undefined, options: Record<string, unknown> = {}): Record<string, unknown> {
  const id = String(target.id || options.id || "");
  const statusMap = new Map<string, string>([
    ["ok", "ok"],
    ["agent_ok", "ok"],
    ["ready", "ok"],
    ["timeout", "timeout"],
    ["failed", "failed"],
    ["error", "failed"],
  ]);
  const probeStatus = String(probe?.status || probe?.state || options.status || "unknown").toLowerCase().trim();
  const status = statusMap.get(probeStatus) || (probeStatus ? probeStatus : "unknown");
  return {
    serverId: id,
    host: String(target.host || options.host || ""),
    port: Number(target.port || options.port || 22),
    user: String(target.user || target.username || target.userName || options.user || ""),
    remoteRoot: String(target.remotePath || target.remoteRoot || options.remoteRoot || ""),
    status,
    message: String(probe?.message || probe?.suggestion || options.message || (status === "ok" ? "检测通过" : "未执行检测或端点不可达")),
    nextAction: status === "ok"
      ? "continue"
      : status === "timeout"
        ? "check_xshell_tunnel"
        : status === "unknown"
          ? "startAllConnections"
          : "inspect_server",
  };
}

export function formatServerTarget(target: Record<string, unknown>): string {
  const user = String(target.user || target.username || target.userName || "");
  const host = String(target.host || "");
  const port = Number(target.port || 22);
  const root = String(target.remotePath || target.remoteRoot || "");
  return `${user ? `${user}@` : ""}${host}:${port}${root ? `:${root}` : ""}`;
}
