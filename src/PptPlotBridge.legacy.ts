// @ts-nocheck
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as child_process_1 from "child_process";
import * as PlottingContract_1 from "./features/PlottingContract";
import { ProgressInactivity } from "./core/ProgressInactivity";
import { atomicWriteText } from "./state/StateStore";
const activePlotProjects = new Set();
const jsonWriteQueues = new Map();
let powerPointLaunchInFlight;
const PPT_SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const PPT_AUTOMATION_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const PPT_AUTOMATION_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
const PPT_DISCOVERY_MAX_BYTES = 64 * 1024;
const PPT_TOKEN_MAX_BYTES = 4 * 1024;
const PPT_LIGHTWEIGHT_SOURCE_EXTENSIONS = new Set([".json", ".csv", ".md", ".tex"]);
const PPT_FINAL_STATISTICS_PATH = "simple_cluster/results/statistics.json";
const PPT_FINAL_PAPER_TABLE_PATH = "paper/tables/simple_results_table.csv";
const PPT_BLOCKING_READINESS_STATES = new Set(["incompatible", "token_missing", "token_invalid"]);
const PPT_LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);
const PPT_NON_RAW_SOURCE_PATHS = new Set([
    PlottingContract_1.PLOTTING_CONTRACT_JSON_PATH,
    PPT_FINAL_STATISTICS_PATH,
    PPT_FINAL_PAPER_TABLE_PATH,
    "paper/tables/simple_results_table.md",
    "simple_cluster/results/case_level_index.json",
    "simple_cluster/datasets/profile.json",
].map((item) => item.toLowerCase()));
export class PptPlotBridge {
    fetchImpl;
    localAppData;
    requestIdFactory;
    launchPowerPoint;
    sleepImpl;
    healthTimeoutMs;
    healthPollMs;
    requestTimeoutMs;
    postTimeoutMs;
    constructor(deps = {}) {
        this.fetchImpl = deps.fetch || fetch;
        this.localAppData = deps.localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
        this.requestIdFactory = deps.requestIdFactory || defaultRequestId;
        this.launchPowerPoint = deps.launchPowerPoint || launchPowerPoint;
        this.sleepImpl = deps.sleep || sleep;
        this.healthTimeoutMs = deps.healthTimeoutMs ?? 30_000;
        this.healthPollMs = deps.healthPollMs ?? 500;
        this.requestTimeoutMs = deps.requestTimeoutMs ?? 30_000;
        this.postTimeoutMs = deps.postTimeoutMs ?? 30_000;
    }
    async plot(input, signal) {
        signal?.throwIfAborted();
        const request = await buildPptPlotRequest(input, this.requestIdFactory());
        const resolvedProject = path.resolve(request.projectRoot);
        const projectKey = process.platform === "win32" ? resolvedProject.toLowerCase() : resolvedProject;
        if (activePlotProjects.has(projectKey))
            throw pptAutomationError("busy", "当前项目已有 PPT 绘图请求正在执行，请等待完成后重试。");
        activePlotProjects.add(projectKey);
        let requestPath = "";
        let responsePath = "";
        try {
            const requestDir = await ensureAuditDir(request.projectRoot);
            requestPath = path.join(requestDir, "latest-request.json");
            responsePath = path.join(requestDir, "latest-response.json");
            await writeJson(requestPath, request);
            const automation = await this.ensureAutomationReady(request.target.presentationPath, signal);
            signal?.throwIfAborted();
            const response = await this.postPlotRequest(automation, request, signal);
            await writeJson(responsePath, response);
            return { requestId: request.requestId, requestPath, responsePath, request, response };
        }
        catch (error) {
            const failure = { ok: false, error: errorMessage(error), requestId: request.requestId };
            if (responsePath) await writeJson(responsePath, failure).catch(() => undefined);
            const auditHint = requestPath && responsePath
                ? `；最近一次审计：${toProjectRelative(request.projectRoot, requestPath)}；响应：${toProjectRelative(request.projectRoot, responsePath)}`
                : "";
            throw pptAutomationError(pptAutomationErrorState(error), `${errorMessage(error)}${auditHint}`);
        }
        finally {
            activePlotProjects.delete(projectKey);
        }
    }
    async inspectAutomation(signal) {
        return (await this.probeAutomation(undefined, signal)).readiness;
    }
    async prepareAutomation(presentationPath, signal) {
        const config = await this.ensureAutomationReady(presentationPath, signal);
        return pptAutomationReadiness("ready", "PPT automation schemaVersion=1 已就绪。", { schemaVersion: 1, endpoint: config.baseUrl });
    }
    async ensureAutomationReady(presentationPath, signal) {
        signal?.throwIfAborted();
        const first = await this.probeAutomation(undefined, signal);
        if (first.readiness.ready)
            return first.config;
        if (PPT_BLOCKING_READINESS_STATES.has(first.readiness.state))
            throw pptAutomationError(first.readiness.state, first.readiness.message);
        const targetPresentationPath = cleanOptional(presentationPath);
        await this.launchPowerPointOnce(targetPresentationPath || undefined);
        const started = Date.now();
        let lastReadiness = first.readiness;
        while (Date.now() - started <= this.healthTimeoutMs) {
            signal?.throwIfAborted();
            const current = await this.probeAutomation(undefined, signal);
            if (current.readiness.ready)
                return current.config;
            lastReadiness = current.readiness;
            if (PPT_BLOCKING_READINESS_STATES.has(current.readiness.state))
                throw pptAutomationError(current.readiness.state, current.readiness.message);
            await this.sleepImpl(this.healthPollMs, signal);
        }
        throw pptAutomationError("not_running", `PPT automation 未就绪：${lastReadiness.message} 请确认 PPT 插件已安装并重新打开 PowerPoint。`);
    }
    async launchPowerPointOnce(presentationPath) {
        if (powerPointLaunchInFlight) {
            await powerPointLaunchInFlight;
            return;
        }
        powerPointLaunchInFlight = Promise.resolve(this.launchPowerPoint(presentationPath)).finally(() => {
            powerPointLaunchInFlight = undefined;
        });
        await powerPointLaunchInFlight;
    }
    async readAutomationConfig() {
        const dir = path.join(this.localAppData, "RoughPptAddin");
        const configPath = path.join(dir, "automation.json");
        const tokenPath = path.join(dir, "automation.token");
        let raw;
        try {
            raw = JSON.parse(await readBoundedUtf8(configPath, PPT_DISCOVERY_MAX_BYTES, "PPT automation discovery"));
        }
        catch (error) {
            if (error?.code === "ENOENT")
                throw error;
            throw pptAutomationError("incompatible", `PPT automation.json 无法解析：${errorMessage(error)} 请更新或重新安装 PPT 插件。`);
        }
        const schemaVersion = Number(raw.schemaVersion);
        if (schemaVersion !== 1)
            throw pptAutomationError("incompatible", `PPT automation discovery schemaVersion=${schemaVersion}，SimpleExperiment 仅支持 schemaVersion=1。请更新 PPT 插件。`);
        let baseUrl;
        try {
            baseUrl = automationBaseUrl(raw);
        }
        catch (error) {
            throw pptAutomationError("incompatible", `PPT automation discovery 无效：${errorMessage(error)} 请更新或重新安装 PPT 插件。`);
        }
        let tokenText = "";
        try { tokenText = await readBoundedUtf8(tokenPath, PPT_TOKEN_MAX_BYTES, "PPT automation token"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const token = String(tokenText).trim();
        if (!token)
            throw pptAutomationError("token_missing", "PPT automation.token 缺失或为空。请完全退出并重新打开 PowerPoint；仍失败时更新 PPT 插件。");
        return { baseUrl, token, schemaVersion };
    }
    async probeAutomation(knownConfig, signal) {
        signal?.throwIfAborted();
        let config = knownConfig;
        if (!config) {
            try {
                config = await this.readAutomationConfig();
            }
            catch (error) {
                if (signal?.aborted) throw signal.reason || error;
                const state = pptAutomationErrorState(error);
                if (state !== "unknown")
                    return { readiness: pptAutomationReadinessFromError(error) };
                return { readiness: pptAutomationReadiness("not_running", "未找到可用的 PPT automation discovery。请确认 PPT 插件已安装并打开 PowerPoint。") };
            }
        }
        try {
            const response = await this.fetchTextWithTimeout(`${config.baseUrl}/health`, {
                method: "GET",
                headers: automationHeaders(config, false),
            }, this.requestTimeoutMs, "PPT automation health", signal);
            const payload = parseJsonObject(response.text);
            if (response.status === 401)
                return { config, readiness: pptAutomationReadiness("token_invalid", "PPT automation 令牌已失效。请完全退出并重新打开 PowerPoint。") };
            if (!response.ok)
                return { config, readiness: pptAutomationReadiness("not_running", `PPT automation health 返回 HTTP ${response.status}。请重新打开 PowerPoint。`) };
            const schemaVersion = Number(payload.schemaVersion);
            if (payload.ok !== true || schemaVersion !== 1)
                return { config, readiness: pptAutomationReadiness("incompatible", `PPT automation health 契约不兼容：ok=${String(payload.ok)}，schemaVersion=${String(payload.schemaVersion ?? "缺失")}。请更新 PPT 插件。`) };
            return { config, readiness: pptAutomationReadiness("ready", "PPT automation schemaVersion=1 已就绪。", { schemaVersion, endpoint: config.baseUrl }) };
        }
        catch (error) {
            if (signal?.aborted) throw signal.reason || error;
            return { config, readiness: pptAutomationReadiness("not_running", `PPT automation 未响应：${errorMessage(error)} 请打开或重新启动 PowerPoint。`) };
        }
    }
    async postPlotRequest(config, request, signal) {
        const body = JSON.stringify(request);
        if (Buffer.byteLength(body, "utf8") > PPT_AUTOMATION_REQUEST_MAX_BYTES)
            throw pptAutomationError("unavailable", `PPT 绘图请求超过 ${PPT_AUTOMATION_REQUEST_MAX_BYTES} 字节上限。`);
        const response = await this.fetchTextWithTimeout(`${config.baseUrl}/api/simple-experiment/plot`, {
            method: "POST",
            headers: automationHeaders(config, true),
            body,
        }, this.postTimeoutMs, "PPT automation 绘图请求", signal);
        const text = response.text;
        const payload = parseJsonObject(text);
        if (!response.ok) {
            const remoteMessage = cleanOptional(payload.error) || text.slice(0, 500);
            if (response.status === 409)
                throw pptAutomationError("busy", remoteMessage || "PPT 插件正在处理另一个绘图请求，请等待完成后重试。");
            if (response.status === 401)
                throw pptAutomationError("token_invalid", "PPT automation 令牌已失效。请完全退出并重新打开 PowerPoint。");
            if ([404, 405].includes(response.status))
                throw pptAutomationError("incompatible", `PPT automation 接口不兼容（HTTP ${response.status}）。请更新 PPT 插件。`);
            throw pptAutomationError("unavailable", `PPT automation HTTP ${response.status}: ${remoteMessage}`);
        }
        if (payload.ok !== true)
            throw pptAutomationError("incompatible", "PPT automation 响应缺少 ok=true。请更新 PPT 插件。");
        return payload;
    }
    async fetchTextWithTimeout(url, init, timeoutMs, label, parentSignal) {
        parentSignal?.throwIfAborted();
        const controller = new AbortController();
        const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
        let timeoutKind = "inactivity";
        const inactivity = new ProgressInactivity(timeoutMs, () => controller.abort());
        const totalTimer = setTimeout(() => {
            timeoutKind = "total";
            controller.abort();
        }, timeoutMs);
        totalTimer.unref?.();
        try {
            const response = await this.fetchImpl(url, { ...init, signal });
            let text;
            if (response.body) {
                const declaredLength = Number(response.headers?.get?.("content-length"));
                if (Number.isFinite(declaredLength) && declaredLength > PPT_AUTOMATION_RESPONSE_MAX_BYTES) {
                    void response.body.cancel().catch(() => undefined);
                    throw new Error(`${label} 响应超过 ${PPT_AUTOMATION_RESPONSE_MAX_BYTES} 字节上限。`);
                }
                const reader = response.body.getReader();
                const chunks = [];
                let bytes = 0;
                try {
                    for (;;) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        bytes += chunk.value.byteLength;
                        if (bytes > PPT_AUTOMATION_RESPONSE_MAX_BYTES || chunks.length >= 4096) {
                            void reader.cancel().catch(() => undefined);
                            throw new Error(`${label} 响应超过大小或分块数上限。`);
                        }
                        chunks.push(Buffer.from(chunk.value));
                        inactivity.update({ processedBytes: bytes });
                    }
                } finally {
                    try { reader.releaseLock(); } catch { /* stream may already be cancelled */ }
                }
                text = Buffer.concat(chunks, bytes).toString("utf8");
            } else {
                const declaredLength = Number(response.headers?.get?.("content-length"));
                if (response.status === 204 || response.status === 304 || declaredLength === 0) text = "";
                else throw new Error(`${label} 响应没有可限额读取的流，已停止接收。`);
            }
            return { ok: response.ok, status: response.status, text };
        }
        catch (error) {
            if (parentSignal?.aborted) throw parentSignal.reason || error;
            if (isAbortError(error))
                throw new Error(`${label}${timeoutKind === "total" ? "总时长" : "无进展"}超时（${timeoutMs}ms）。`);
            throw error;
        }
        finally {
            clearTimeout(totalTimer);
            inactivity.dispose();
        }
    }
}
export function defaultPptAutomationReadiness() {
    return pptAutomationReadiness("unknown", "尚未检测 PPT automation；不影响实验运行，仅影响结果绘图。", { actionCommand: "refreshPptAutomation", actionLabel: "检测 PPT 插件" });
}
export function pptAutomationReadinessFromError(error) {
    const state = pptAutomationErrorState(error);
    return pptAutomationReadiness(state === "unknown" ? "unavailable" : state, errorMessage(error));
}
function pptAutomationReadiness(state, message, details = {}) {
    const actions = {
        unknown: ["refreshPptAutomation", "检测 PPT 插件"],
        not_running: ["startPptAutomation", "启动 PowerPoint"],
        busy: ["refreshPptAutomation", "等待后重新检测"],
        token_missing: ["openPptAutomationGuide", "查看修复说明"],
        token_invalid: ["openPptAutomationGuide", "查看修复说明"],
        incompatible: ["openPptAutomationGuide", "查看升级说明"],
        unavailable: ["refreshPptAutomation", "重新检测"],
    };
    const action = actions[state] || [];
    return {
        state,
        ready: state === "ready",
        message: String(message || "PPT automation 状态未知。"),
        actionCommand: details.actionCommand || action[0] || "",
        actionLabel: details.actionLabel || action[1] || "",
        schemaVersion: details.schemaVersion,
        endpoint: details.endpoint || "",
    };
}
function pptAutomationError(state, message) {
    const error = new Error(message);
    error.pptAutomationState = state;
    return error;
}
function pptAutomationErrorState(error) {
    return String(error?.pptAutomationState || "unknown");
}
function parseJsonObject(text) {
    if (!String(text || "").trim())
        return {};
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
export async function ensureLocalPlottingContract(projectRoot, planFile = "") {
    const root = path.resolve(projectRoot);
    const plan = String(planFile || "").trim();
    const preferredRel = (0, PlottingContract_1.plottingContractJsonPath)(plan);
    const preferredPath = safeProjectPath(root, preferredRel);
    if (await pathExists(preferredPath))
        return toProjectRelative(root, preferredPath);
    const fallbackPath = safeProjectPath(root, PlottingContract_1.PLOTTING_CONTRACT_JSON_PATH);
    if (!plan && await pathExists(fallbackPath))
        return toProjectRelative(root, fallbackPath);
    await fs.mkdir(path.dirname(preferredPath), { recursive: true });
    const contract = (0, PlottingContract_1.buildPlottingOutputContract)(new Date().toISOString(), plan);
    await writeJson(preferredPath, contract);
    if (plan) {
        await fs.mkdir(path.dirname(fallbackPath), { recursive: true });
        await writeJson(fallbackPath, contract);
    }
    const mdRel = (0, PlottingContract_1.plottingContractMarkdownPath)(plan);
    const mdPath = safeProjectPath(root, mdRel);
    if (!await pathExists(mdPath)) {
        await fs.mkdir(path.dirname(mdPath), { recursive: true });
        await atomicWriteText(mdPath, (0, PlottingContract_1.plottingContractMarkdown)(contract));
    }
    return toProjectRelative(root, preferredPath);
}
export async function buildPptPlotRequest(input, requestId = defaultRequestId()) {
    const projectRoot = path.resolve(input.projectRoot);
    const planFile = cleanOptional(input.planFile) || "";
    const plottingContractPath = normalizeProjectRelativePath(input.plottingContractPath || (0, PlottingContract_1.plottingContractJsonPath)(planFile) || PlottingContract_1.PLOTTING_CONTRACT_JSON_PATH, projectRoot);
    const sourceCandidates = await finalAnalysisPlotSources(projectRoot, input.sourcePaths?.length ? input.sourcePaths : [plottingContractPath], planFile);
    const sourcePaths = await resolvePptSourcePaths(projectRoot, sourceCandidates);
    const request = {
        schemaVersion: 1,
        requestId,
        projectRoot,
        sourcePaths: sourcePaths.paths,
        plottingContractPath,
        selectedResultId: cleanOptional(input.selectedResultId),
        runKey: cleanOptional(input.runKey),
        archiveKey: cleanOptional(input.archiveKey),
        chartType: cleanOptional(input.chartType) || "auto",
        target: {
            presentationPath: cleanOptional(input.presentationPath),
            createIfMissing: true,
            slideMode: "append",
        },
        styleMode: cleanOptional(input.styleMode) || "activePpt",
        sourceLabel: cleanOptional(input.sourceLabel) || "SimpleExperiment 结果",
        markdownSummary: sourcePaths.markdownSummary || null,
    };
    return request;
}
async function finalAnalysisPlotSources(projectRoot, sourcePaths, planFile = "") {
    const out = [];
    for (const raw of sourcePaths) {
        const rel = normalizeProjectRelativePath(raw, projectRoot);
        if (!rel)
            continue;
        if (isStatisticsPlotSource(rel) && !await archivedStatisticsSource(projectRoot, rel)) {
            throw new Error(`统计文件不是有效的已归档结果统计：${rel}。请重新运行“统计”。`);
        }
        if (!isRawSingleRunPlotSource(rel) || await isAggregateCsvPlotSource(projectRoot, rel)) {
            out.push(rel);
            continue;
        }
        const finalSource = await firstExistingFinalPlotSource(projectRoot, planFile);
        if (!finalSource) {
            throw new Error(`SCI 绘图需要先生成聚合统计，不能直接使用单个 seed 原始结果：${rel}。请先运行“统计”或“导出论文表格”。`);
        }
        out.push(finalSource);
    }
    const unique = Array.from(new Set(out));
    await assertSingleDatasetPlotSources(projectRoot, unique);
    return unique;
}
async function isAggregateCsvPlotSource(projectRoot, rel) {
    if (!/\.csv$/i.test(rel)) return false;
    const full = safeProjectPath(projectRoot, rel);
    await assertPptLightweightSource(full, rel);
    const {header} = require("./results/ProjectResultTables").readCsv(await readBoundedUtf8(full, PPT_SOURCE_FILE_MAX_BYTES, `绘图源 ${rel}`));
    return header.includes("dataset") && header.some(name => name === "mean" || name.endsWith("_mean")) && header.some(name => name === "std" || name.endsWith("_std") || name.endsWith("_sd"));
}
async function assertSingleDatasetPlotSources(projectRoot, sources) {
    const datasets = new Set();
    for (const rel of sources) {
        const full = safeProjectPath(projectRoot, rel);
        await assertPptLightweightSource(full, rel);
        if (/\.csv$/i.test(rel)) {
            const parsed = require("./results/ProjectResultTables").readCsv(await readBoundedUtf8(full, PPT_SOURCE_FILE_MAX_BYTES, `绘图源 ${rel}`));
            const index = parsed.header.indexOf("dataset");
            if (index >= 0) parsed.rows.forEach(row => datasets.add(String(row[index] || "").trim()));
        } else if (isStatisticsPlotSource(rel)) {
            const report = JSON.parse(await readBoundedUtf8(full, PPT_SOURCE_FILE_MAX_BYTES, `绘图源 ${rel}`));
            (report.rows || []).forEach(row => datasets.add(String(row.dataset || row.dimensions?.dataset || "").trim()));
        } else if (/^paper\/tables\/[^/]+\//.test(rel)) {
            datasets.add(rel.split("/")[2]);
        } else if (/\.md$/i.test(rel) && rel.includes("/plans/")) {
            const parts = rel.split("/");
            datasets.add(parts[parts.indexOf("plans") - 1]);
        }
    }
    if (datasets.size > 1) throw new Error("绘图来源包含多个数据集，请选择一个数据集的论文表格。");
}
async function resolvePptSourcePaths(projectRoot, sourcePaths) {
    const out = [];
    let markdownSummary;
    for (const raw of sourcePaths) {
        const rel = normalizeProjectRelativePath(raw, projectRoot);
        if (!rel)
            continue;
        const full = safeProjectPath(projectRoot, rel);
        await assertPptLightweightSource(full, rel);
        if (/\.md$/i.test(rel)) {
            const jsonRel = rel.replace(/\.md$/i, ".json");
            const jsonFull = safeProjectPath(projectRoot, jsonRel);
            if (await pathExists(jsonFull)) {
                await assertPptLightweightSource(jsonFull, jsonRel);
                out.push(jsonRel);
            }
            else if (!markdownSummary) {
                markdownSummary = { path: rel, text: (await readBoundedUtf8(full, PPT_SOURCE_FILE_MAX_BYTES, `绘图源 ${rel}`)).slice(0, 24_000) };
                out.push(rel);
            }
            continue;
        }
        out.push(rel);
    }
    const unique = Array.from(new Set(out));
    if (!unique.length)
        throw new Error("没有可用于 PPT 绘图的轻量结果文件。");
    return { paths: unique, markdownSummary };
}
async function firstExistingFinalPlotSource(projectRoot, planFile = "") {
    const plan = String(planFile || "").trim();
    const candidates = plan
        ? [(0, PlottingContract_1.statisticsJsonPath)(plan)]
        : [PPT_FINAL_STATISTICS_PATH];
    for (const rel of Array.from(new Set(candidates.filter(Boolean)))) {
        if (await pathExists(safeProjectPath(projectRoot, rel)) && (!isStatisticsPlotSource(rel) || await archivedStatisticsSource(projectRoot, rel)))
            return rel;
    }
    return undefined;
}
function isStatisticsPlotSource(rel) {
    return /(^|\/)statistics\.json$/i.test(normalizeProjectRelativePath(rel));
}
async function archivedStatisticsSource(projectRoot, rel) {
    const full = safeProjectPath(projectRoot, rel);
    try {
        const report = JSON.parse(await readBoundedUtf8(full, PPT_SOURCE_FILE_MAX_BYTES, `绘图源 ${rel}`));
        const source = String(report?.aggregationPolicy?.source || report?.inclusionPolicy || "").toLowerCase();
        return Number(report?.resultCount || 0) > 0 && source === "archived_only";
    }
    catch {
        return false;
    }
}
function isRawSingleRunPlotSource(rel) {
    const text = normalizeProjectRelativePath(rel).toLowerCase();
    if (!text)
        return false;
    if (/(^|\/)results_preview_all\.csv$/i.test(text))
        return true;
    if (PPT_NON_RAW_SOURCE_PATHS.has(text))
        return false;
    if (text.startsWith("simple_cluster/results/by_plan/") && /(statistics\.json|plotting_contract\.json|case_level_index\.json|result_registry\.json|output_contract_for_plotting\.md)$/.test(text))
        return false;
    if (/^paper\/tables\/(?:[^/]+\/)?simple_results_table__.+\.(csv|md)$/.test(text))
        return false;
    if (text.startsWith("simple_cluster/results/anomaly/") || text.startsWith("simple_cluster/results/by_plan/") && text.includes("/anomaly/") || text.startsWith("simple_cluster/plans/recovered/"))
        return false;
    if (text === "simple_cluster/results/result_registry.json")
        return true;
    return /^(experiments\/results|work_dirs|results|outputs|runs|custom_results|reports|artifacts|evals|evaluation)\//.test(text) && /\.(csv|json)$/i.test(text);
}
async function assertPptLightweightSource(fullPath, rel) {
    const stat = await fs.lstat(fullPath).catch(() => undefined);
    if (!stat)
        throw new Error(`绘图源文件不存在：${rel}`);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)
        throw new Error(`绘图源必须是轻量结果文件，不能是目录：${rel}`);
    const ext = path.extname(rel).toLowerCase();
    if (!PPT_LIGHTWEIGHT_SOURCE_EXTENSIONS.has(ext)) {
        throw new Error(`不支持的 PPT 绘图源文件类型：${rel}。仅允许 JSON、CSV、Markdown 或 TeX 轻量结果文件。`);
    }
    if (stat.size > PPT_SOURCE_FILE_MAX_BYTES) {
        throw new Error(`PPT 绘图源文件过大：${rel}，请先生成 statistics、paper table、case-level 或 Markdown 摘要。`);
    }
}
async function readBoundedUtf8(file, maxBytes, label) {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw new Error(`${label} 不是可安全读取的独占普通文件。`);
    if (before.size > maxBytes) throw new Error(`${label} 超过 ${maxBytes} 字节上限。`);
    const noFollow = Number(require("node:fs").constants.O_NOFOLLOW || 0);
    const handle = await fs.open(file, require("node:fs").constants.O_RDONLY | noFollow);
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink > 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs)
            throw new Error(`${label} 在打开时发生变化。`);
        const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maxBytes) throw new Error(`${label} 超过 ${maxBytes} 字节上限。`);
        const after = await fs.lstat(file);
        const openedAfter = await handle.stat();
        if (after.isSymbolicLink() || !after.isFile() || after.nlink > 1 || after.dev !== before.dev || after.ino !== before.ino
            || after.size !== before.size || after.mtimeMs !== before.mtimeMs || openedAfter.dev !== before.dev || openedAfter.ino !== before.ino)
            throw new Error(`${label} 在读取期间发生变化。`);
        return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
}
async function ensureAuditDir(projectRoot) {
    const dir = safeProjectPath(projectRoot, "simple_cluster/results/ppt_plot_requests");
    await fs.mkdir(dir, { recursive: true });
    return dir;
}
function automationBaseUrl(raw) {
    const direct = cleanOptional(raw.baseUrl) || cleanOptional(raw.url) || cleanOptional(raw.endpoint);
    const host = cleanOptional(raw.host) || "127.0.0.1";
    const port = typeof raw.port === "number" ? raw.port : Number(raw.port);
    const protocol = cleanOptional(raw.protocol) || "http";
    const base = direct || (Number.isFinite(port) ? `${protocol}://${host}:${port}` : "");
    if (!base)
        throw new Error("automation.json 缺少 baseUrl/url/endpoint 或 port。");
    const url = new URL(base);
    if (!PPT_LOOPBACK_HOSTNAMES.has(url.hostname)) {
        throw new Error("PPT automation server 必须绑定本机 127.0.0.1 或 localhost。");
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}
function automationHeaders(config, hasBody) {
    const headers = { Accept: "application/json" };
    if (hasBody)
        headers["Content-Type"] = "application/json";
    if (config.token) {
        headers.Authorization = `Bearer ${config.token}`;
        headers["X-RoughPpt-Automation-Token"] = config.token;
        headers["X-Rough-Ppt-Token"] = config.token;
    }
    return headers;
}
function launchPowerPoint(presentationPath) {
    const child = process.platform === "win32"
        ? (0, child_process_1.spawn)("pwsh.exe", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            presentationPath ? "Start-Process -FilePath powerpnt.exe -ArgumentList $args[0]" : "Start-Process -FilePath powerpnt.exe",
            ...(presentationPath ? [presentationPath] : []),
        ], { detached: true, stdio: "ignore", windowsHide: true })
        : (0, child_process_1.spawn)("open", presentationPath ? [presentationPath] : ["-a", "Microsoft PowerPoint"], { detached: true, stdio: "ignore" });
    child.unref();
}
async function writeJson(file, payload) {
    const target = path.resolve(file);
    const previous = jsonWriteQueues.get(target) || Promise.resolve();
    const writing = previous.catch(() => undefined).then(async () => {
        await atomicWriteText(target, `${JSON.stringify(payload, null, 2)}\n`);
    });
    jsonWriteQueues.set(target, writing);
    try {
        await writing;
    }
    finally {
        if (jsonWriteQueues.get(target) === writing) jsonWriteQueues.delete(target);
    }
}
function safeProjectPath(projectRoot, value) {
    const root = path.resolve(projectRoot);
    const full = path.resolve(root, normalizeProjectRelativePath(value, root));
    if (full !== root && !full.startsWith(root + path.sep))
        throw new Error(`路径越界：${value}`);
    return full;
}
function normalizeProjectRelativePath(value, projectRoot) {
    const text = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!text)
        return "";
    if (path.isAbsolute(text))
        return path.relative(path.resolve(projectRoot || process.cwd()), text).replace(/\\/g, "/");
    return text.replace(/\/+/g, "/");
}
function toProjectRelative(projectRoot, file) {
    return path.relative(projectRoot, file).replace(/\\/g, "/");
}
async function pathExists(file) {
    return fs.access(file).then(() => true, () => false);
}
function cleanOptional(value) {
    return typeof value === "string" ? value.trim() : "";
}
function defaultRequestId() {
    return `ppt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || Object.assign(new Error("请求已取消。"), { name: "AbortError" }));
    return new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        };
        const finish = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason || Object.assign(new Error("请求已取消。"), { name: "AbortError" })); };
        timer = setTimeout(finish, ms);
        timer.unref?.();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error || "unknown error");
}
function isAbortError(error) {
    return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}
