#!/usr/bin/env node
/**
 * check-static — 目标项目 Plan 结构 + 输出接口 + 路径安全静态检查
 *
 * 复用链（禁止重复造轮子）：
 * - Plan 结构：dist/features/PlanBuilder/PlanValidator.js#validatePlan
 *   （门面 -> PlanBuilder.validateDeepLearningPlanContract，缺失时正则基线；
 *   语义基准见 src/features/PlanBuilder.legacy.ts:834-874）
 * - 远端读路径白名单：dist/tunnel/FileTransferTypes.js#isSafeRemotePath
 *   （src/tunnel/FileTransferTypes.ts:79-90）
 * - 工程内写路径边界：dist/security/RemotePathPolicy.js#safeRemoteProjectChild
 *   （src/security/RemotePathPolicy.ts:5-12）
 * - 输出接口三通道封闭判定（仅 run_wrapper / collect_outputs|write_metrics_summary
 *   显式调用 / TensorBoard SummaryWriter 算通过；result_csv/output_dir/expectedResults
 *   单声明永不算通过；语义基准 src/clusterSchedulerRuntime.legacy.ts:742-789）：
 *   本脚本为静态文本启发式（不做 AST），发现缺失即 failed 并给出修复文案。
 *
 * 用法：
  *   node scripts/check-static.js [--project <dir>] [--fail-on-warning] [--json] [--write-md|--report-md] [--quiet-wrapper] [--quiet-info]
  *   示例（抑制 wrapper 汇总）：node scripts/check-static.js --project <dir> --write-md --quiet-wrapper
  *   示例（抑制 tensorboard/version 噪音）：node scripts/check-static.js --project <dir> --write-md --quiet-info
  *   npm run check:static -- --project <dir>
 *
 * 约束：
 * - 不碰 src/ui/PanelHtml* 内层脚本（P0 外层模板剥离坑）。
 * - 不硬编码隧道端口/IP（P0），本脚本不做任何网络探测。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
// 报告头来源单源：JSON/MD 头 checkerSource 均取此处（与 legacy.ts#CHECK_STATIC_CHECKER_SOURCE 双常量一致）。
const CHECKER_SOURCE = "scripts/check-static.js";
// 绝对坐标（排障用）：checkerSource 相对单源不变（双常量比对仍用相对值），绝对坐标仅供日志/排障新增字段 checkerSourceAbs，不参与双常量一致判定。
const CHECKER_SOURCE_ABS = path.resolve(__filename).replace(/\\/g, "/");
// 双常量同步抛错：启动即同步校验 legacy 侧 CHECK_STATIC_CHECKER_SOURCE，漂移直接抛错（禁止静默双轨；无源码仅 dist 运行时跳过）。
(function syncCheckerSourceOrThrow() {
  try {
    const legacySrc = fs.readFileSync(path.join(ROOT, "src", "extension", "legacy.ts"), "utf8");
    const m = /CHECK_STATIC_CHECKER_SOURCE\s*=\s*"([^"]+)"/.exec(legacySrc);
    if (m && m[1] !== CHECKER_SOURCE) {
      throw new Error(`[check-static] checkerSource 双常量漂移：scripts=${CHECKER_SOURCE} vs legacy=${m[1]}（请同步两处后重跑）`);
    }
  } catch (err) {
    if (/双常量漂移/.test(String(err && err.message))) throw err;
    // 无源码（仅 dist 运行）时跳过，不阻断
  }
})();
// file 归一 + plan 行锚（helpers）：findings.file 与 planFiles 双轨一致归一为 / 分隔（Windows 回 \\ 在此归一）；
// planLineOf 取首个匹配行的 1-based 行号，未命中回 1，保证 MD 明细位置不断链。
function normRel(projectDir, abs) {
  const r = path.relative(projectDir, abs) || abs;
  return String(r).replace(/\\/g, "/").replace(/^\.\//, "");
}
function planLineOf(text, re) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    re.lastIndex = 0;
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
}
const { validatePlan } = require("../dist/features/PlanBuilder/PlanValidator");
const { isSafeRemotePath } = require("../dist/tunnel/FileTransferTypes");
const { safeRemoteProjectChild } = require("../dist/security/RemotePathPolicy");

function parseArgs(argv) {
  const out = { project: ROOT, failOnWarning: false, json: false, writeMd: false, quietWrapper: false, quietInfo: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--project" && argv[i + 1]) { out.project = path.resolve(argv[i + 1]); i += 1; }
    else if (a === "--fail-on-warning") out.failOnWarning = true;
    else if (a === "--json") out.json = true;
    else if (a === "--write-md" || a === "--report-md") out.writeMd = true;
    else if (a === "--quiet-wrapper") out.quietWrapper = true;
    else if (a === "--quiet-info") out.quietInfo = true;
  }
  return out;
}

const EXCLUDE_DIR_NAMES = new Set(["tmp", "clean_dir", "work_dirs", "simple_cluster", "runs", "debug_runs"]);
const EXCLUDE_REL_PREFIXES = ["tmp/", "clean_dir/", "work_dirs/", "simple_cluster/", "runs/", "debug_runs/", "experiments/runs/"];

function collectFiles(dir, exts, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
    if (ent.isDirectory() && EXCLUDE_DIR_NAMES.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) collectFiles(p, exts, out);
    else if (ent.isFile() && exts.some((e) => p.endsWith(e))) out.push(p);
  }
}

function findPlanFiles(projectDir) {
  const all = [];
  collectFiles(projectDir, [".yaml", ".yml"], all);
  return all.filter((f) => {
    const rel = path.relative(projectDir, f).replace(/\\/g, "/");
    if (EXCLUDE_REL_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p))) return false;
    if (/(^|\/)simple_project\.ya?ml$/.test(rel)) return false;
    return /(^|\/)(plan|plans|experiments)(\/|$)/.test(rel) || /(^|\/)plan[^/]*\.ya?ml$/.test(rel);
  });
}

function checkOutputInterface(planText) {
  const hasRunWrapper = /run_wrapper(\.py)?/i.test(planText);
  const hasAdapterCall = /collect_outputs\s*\(|write_metrics_summary\s*\(|write_standard_outputs\s*\(/i.test(planText);
  const hasTensorBoard = /SummaryWriter|EventFileWriter|add_scalar/i.test(planText)
    || /summarywriter|tensorboard/i.test(planText);
  if (hasRunWrapper || hasAdapterCall) return { ok: true, channel: hasRunWrapper ? "run_wrapper" : "adapter_call" };
  if (hasTensorBoard) {
    return {
      ok: true,
      channel: "tensorboard_scalars",
      note: "仅见 TensorBoard 信号，静态无法确认远端已安装 tensorboard，请确认远端环境可用",
    };
  }
  return {
    ok: false,
    fix: "未验证的输出接口：请使用 simple_adapter/run_wrapper 包裹命令，或在入口代码调用 collect_outputs/write_metrics_summary/write_standard_outputs，或使用 TensorBoard SummaryWriter 并安装 tensorboard",
  };
}

const BASELINE_TEST_COMMAND = 'test_command: "python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}"';

function checkTestCommand(planText) {
  const hasTestKey = /test_command\s*:|testCommandTemplate\s*:/i.test(planText);
  const modeMatch = /^\s*mode\s*:\s*["']?([^\s"'#]+)/im.exec(planText);
  const mode = modeMatch ? String(modeMatch[1]).toLowerCase() : "";
  const wantsTest = hasTestKey || mode === "test" || mode === "train_test" || mode === "test_only";
  if (!wantsTest) return null;
  // 取所有 test_command / testCommandTemplate 行拼接判定（comparison 类计划不加参：只读 planText，不新增比较参数）
  const lines = planText.split(/\r?\n/).filter((l) => /test_command\s*:|testCommandTemplate\s*:/i.test(l));
  const blob = lines.length ? lines.join("\n") : planText;
  const hasFlag = blob.includes("--result-csv");
  const hasPlaceholder = blob.includes("{result_csv}");
  if (hasFlag && hasPlaceholder) return null;
  const missing = [!hasFlag ? "--result-csv" : null, !hasPlaceholder ? "{result_csv}" : null].filter(Boolean).join(" 与 ");
  // 经注入降级：同 plan 含 test.results_csv:/paper.result_csv:（含 paper: { result_csv: } 同行写法）+
  // expectedResults 大表（experiments/results/）时，调度经 result_csv 回退链注入 --result-csv，不阻断 → warning
  const clean = stripYamlComments(planText);
  const hasInjectionField = hasInjectionFieldOf(clean);
  const hasExpectedBigTable = /expectedResults\s*:/i.test(clean) && /experiments\/results\//i.test(clean);
  if (hasInjectionField && hasExpectedBigTable) {
    // G3-info 复用：paper + 任一 test.results_csv/candidateCsv 齐备时，result_csv 回退链已闭环 → info；
    // 否则注入缺口未闭环 → warning（判定条件不变，仅桶位移；与 B1 同轨）。
    const hasCandidateCsvHitC = /candidateCsv\s*:/i.test(clean);
    const hasPaperResultCsvC = /paper\.result_csv\s*:/i.test(clean)
      || /paper\s*:\s*\{[^}\n]*results?_csv\s*:/i.test(clean)
      || (/paper\s*:/i.test(clean) && /^\s*results?_csv\s*:/im.test(clean));
    const hasTestResultsCsvHitC = /test\.results_csv\s*:/i.test(clean)
      || /test\s*:\s*\{[^}\n]*results?_csv\s*:/i.test(clean)
      || (/test\s*:/i.test(clean) && /^\s*results?_csv\s*:/im.test(clean));
    if (hasPaperResultCsvC && (hasTestResultsCsvHitC || hasCandidateCsvHitC)) {
      return {
        severity: "info",
        id: "test_command_via_injection",
        message: `test_command 缺少 ${missing}（经注入/candidateCsv 齐备，不阻断）`,
        suggestion: "result_csv 回退链注入已齐备（paper + test.results_csv/candidateCsv），确认后参照 baseline.yaml:13 补齐",
      };
    }
    return {
      severity: "warning",
      id: "test_command_via_injection",
      // via 缩文案：判定语义不变（经注入降 warning），文案收敛为一行，完整基线见 baseline.yaml:13（折叠不断链）。
      message: `test_command 缺少 ${missing}（经注入，不阻断）`,
      suggestion: "参照 baseline.yaml:13 补齐；或确认 result_csv 回退链注入",
    };
  }
  return {
    severity: "critical",
    id: "test_command_missing_result_csv",
    message: `test_command 缺少 ${missing}`,
    suggestion: `参照 baseline.yaml:13 补齐：${BASELINE_TEST_COMMAND}`,
  };
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const x = Number(a[i] || 0);
    const y = Number(b[i] || 0);
    if (x !== y) return x - y;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 通用：剥注释（G3/G4 约束：注释中的声明不算数）
// ---------------------------------------------------------------------------
function stripYamlComments(text) {
  return String(text || "").split(/\r?\n/).map((line) => {
    // 切掉行内注释：首个不在单/双引号内的 # 之后全丢弃
    let inS = false;
    let inD = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) {
        // 粗略跳过转义引号
        let bs = 0;
        let j = i - 1;
        while (j >= 0 && line[j] === "\\") { bs += 1; j -= 1; }
        if (bs % 2 === 0) inD = !inD;
      } else if (c === "#" && !inS && !inD) {
        // YAML 注释需前导空白（或行首）；保守起见行首/#前空白才切
        if (i === 0 || /[\s]/.test(line[i - 1])) return line.slice(0, i);
      }
    }
    return line;
  }).join("\n");
}

// 注入三写法单源（checkTestCommand:141-156 与 checkOutputContract:443-445 同轨复用，禁双轨漂移）：
// 点分键 test.results_csv:/paper.result_csv: ｜ paper:/test: 同行 {result_csv:} ｜ paper:/test: 块 + 顶格 results_csv:
function hasInjectionFieldOf(clean) {
  const s = String(clean || "");
  return /(test\.results_csv|paper\.result_csv)\s*:/i.test(s)
    || /(paper|test)\s*:\s*\{[^}\n]*results?_csv\s*:/i.test(s)
    || (/(paper|test)\s*:/i.test(s) && /^\s*results?_csv\s*:/im.test(s));
}

function planModeOf(text) {
  const clean = stripYamlComments(text);
  const m = /^\s*mode\s*:\s*["']?([^\s"'#}]+)/im.exec(clean);
  const raw = m ? String(m[1]).trim() : "";
  const norm = raw.toLowerCase().replace(/[\s-]+/g, "_");
  let mode = "train_test";
  if (!raw) mode = "train_test";
  else if (["train", "training", "train_only"].includes(norm)) mode = "train";
  else if (["test", "eval", "evaluate", "evaluation", "test_only", "eval_only"].includes(norm)) mode = "test";
  else if (["train_test", "train_and_test", "both", "all"].includes(norm)) mode = "train_test";
  else mode = "train_test";
  const valid = !raw || (["train", "test", "train_test"].includes(mode) && ["train", "training", "train_only", "test", "eval", "evaluate", "evaluation", "test_only", "eval_only", "train_test", "train_and_test", "both", "all"].includes(norm));
  return { raw, mode, valid };
}

// ---------------------------------------------------------------------------
// G1 强升级：legacy 同 file+id 去重升级 + 缺失项补 critical
// ---------------------------------------------------------------------------
const G1_UPGRADE_IDS = new Set([
  "mode", "seeds", "cases", "experiments", "case",
  "base_config", "config", "train_command", "traincommand", "test_command", "testcommand",
  "base_config_missing", "seeds_missing", "cases_missing", "command_missing",
  "result_output", "result_output_missing",
]);
const G1_UPGRADE_FIELDS = new Set([
  "mode", "seeds", "cases", "experiments", "base_config", "config",
  "train_command", "test_command", "trainCommand", "testCommand", "result_output",
]);

function g1KeyOf(issue) {
  const id = String(issue.id || issue.field || "").toLowerCase();
  const label = String(issue.path || issue.label || "").toLowerCase();
  return `${id} ${label}`;
}

function shouldUpgradeToCritical(issue) {
  if (String(issue.severity || "").toLowerCase() === "critical") return true;
  const id = String(issue.id || issue.field || "").toLowerCase();
  const label = String(issue.path || issue.label || "").toLowerCase();
  if (G1_UPGRADE_IDS.has(id)) return true;
  if (G1_UPGRADE_FIELDS.has(id)) return true;
  if (/训练命令|测试命令|结果输出|基础配置|随机种子|实验.?case|运行模式/.test(String(issue.message || ""))) return true;
  void label;
  return false;
}

/** 把 validatePlan 的 warnings 中属于 G1 的项升级为 critical，并按 file+id 去重。 */
function upgradeLegacyFindings(result, rel) {
  const errors = [];
  const warnings = [];
  const seenErrorIds = new Set();
  for (const e of result.errors || []) {
    const key = `${rel}::${String(e.id || "").toLowerCase()}`;
    if (seenErrorIds.has(key)) continue;
    seenErrorIds.add(key);
    errors.push({ file: rel, severity: "critical", id: e.id, message: e.message, suggestion: e.suggestion || "" });
  }
  for (const w of result.warnings || []) {
    if (shouldUpgradeToCritical(w)) {
      const key = `${rel}::${String(w.id || "").toLowerCase()}`;
      if (seenErrorIds.has(key)) continue; // 同 file+id 去重：critical 已存在则丢弃 warning
      seenErrorIds.add(key);
      errors.push({ file: rel, severity: "critical", id: w.id, message: w.message, suggestion: w.suggestion || "" });
    } else {
      warnings.push({ file: rel, severity: "warning", id: w.id, message: w.message, suggestion: w.suggestion || "" });
    }
  }
  void g1KeyOf;
  return { errors, warnings };
}

function extractTopScalar(clean, ...keys) {
  for (const k of keys) {
    const re = new RegExp(`^\\s*${k}\\s*:\\s*(.+?)\\s*$`, "im");
    const m = re.exec(clean);
    if (m) return String(m[1]).trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

/** G1 补项：mode 非法 / seeds 缺空 / cases 双空 / base_config 不存在 / 按 mode 缺命令 → critical。 */
function checkPlanContractHardening(planText, projectDir) {
  const out = [];
  const clean = stripYamlComments(planText);
  const { raw, mode, valid } = planModeOf(planText);
  if (raw && !valid) {
    out.push({
      severity: "critical", id: "mode_invalid",
      message: `mode 非法: ${raw}（仅允许 train / test / train_test）`,
      suggestion: "mode 改为 train、test 或 train_test 之一",
    });
  }
  // seeds 缺/空
  const seedsBlock = /^\s*seeds\s*:\s*(\[[^\]]*\]|["']?[^\s"'#][^\n#]*)/im.exec(clean);
  if (!/^\s*seeds\s*:/m.test(clean)) {
    out.push({ severity: "critical", id: "seeds_missing", message: "缺少随机种子列表 seeds", suggestion: "补充 seeds: [0]（即使只跑一次也要写）" });
  } else if (seedsBlock && /^\[\s*\]/.test(seedsBlock[1].trim())) {
    out.push({ severity: "critical", id: "seeds_empty", message: "seeds 为空列表", suggestion: "补充 seeds: [0, 1, 2]；单次写 seeds: [0]" });
  }
  // cases 双空：cases 与 experiments 同时缺（或显式空）
  const hasCasesKey = /^\s*(cases|experiments)\s*:/m.test(clean);
  if (!hasCasesKey) {
    out.push({ severity: "critical", id: "cases_missing", message: "缺少实验 cases/experiments", suggestion: "补充 cases 或 experiments；单实验也保留可命名 case" });
  } else {
    const listItems = clean.split(/\r?\n/).filter((l) => /^\s*-\s*\S/.test(l));
    const inlineEmpty = /^\s*(cases|experiments)\s*:\s*(\[\s*\]|["']?\s*(null|~|none)\s*["']?)\s*$/im.test(clean);
    if (inlineEmpty || (hasCasesKey && listItems.length === 0 && !/^\s*(cases|experiments)\s*:\s*\S/im.test(clean))) {
      out.push({ severity: "critical", id: "cases_empty", message: "cases/experiments 为空", suggestion: "至少声明一个 case，例如 - name: smoke" });
    }
  }
  // base_config 不存在：有声明但磁盘无文件 → critical；无声明 → critical（与 legacy 对齐）
  const baseVal = extractTopScalar(clean, "base_config", "config");
  if (!baseVal) {
    if (!/^\s*(base_config|config)\s*:/m.test(clean)) {
      out.push({ severity: "critical", id: "base_config_missing", message: "缺少 base_config/config", suggestion: "在 plan 顶层补充 base_config: configs/base.yaml" });
    }
  } else if (!/^\{/.test(baseVal)) {
    const cands = [path.join(projectDir, baseVal), path.join(projectDir, "configs", path.basename(baseVal))];
    const exists = cands.some((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    // 模板占位（{...}）不判存在；纯字面路径不存在才报
    if (!exists && !/[{}$]/.test(baseVal)) {
      out.push({ severity: "critical", id: "base_config_not_found", message: `base_config 文件不存在: ${baseVal}`, suggestion: "确认 configs/ 下存在该文件，或修正 base_config 指向" });
    }
  }
  // 按 mode 缺命令
  const hasTrain = /(train_command|trainCommand)\s*:/i.test(clean) || /(^|\n)\s*command\s*:/i.test(clean);
  const hasTest = /(test_command|testCommand)\s*:/i.test(clean);
  if (mode !== "test" && !hasTrain) {
    out.push({ severity: "critical", id: "train_command_missing", message: "train 模式缺少 train_command", suggestion: "在 runner.train_command 中写明训练命令（含 --output-dir {output_dir}）" });
  }
  if (mode !== "train" && !hasTest) {
    out.push({ severity: "critical", id: "test_command_missing", message: "test 模式缺少 test_command", suggestion: "在 runner.test_command 中写明测试命令（含 --result-csv {result_csv}）" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// G2 checkTemplateVariables：16 白名单外 {xxx} → warning 去重；双分隔符放行；
//     train 直写大表 → critical
// ---------------------------------------------------------------------------
const TEMPLATE_WHITELIST_16 = new Set([
  "config", "config_path", "suite", "case", "seed", "index",
  "output_dir", "outputDir", "result_csv", "resultCsv",
  "worker_id", "gpu_ids", "plan_file", "job_name", "experiment_name", "python",
]);
// checkpoint 仅 test/entrypoints 上下文合法，train 上下文出现视为可疑但不按未知变量计
const TEMPLATE_TEST_ONLY = new Set(["checkpoint"]);

function extractCommandBlobs(clean) {
  const grab = (re) => {
    const lines = clean.split(/\r?\n/).filter((l) => re.test(l));
    return lines.join("\n");
  };
  return {
    train: grab(/train_command\s*:|trainCommand\s*:|^\s*command\s*:/i),
    test: grab(/test_command\s*:|testCommand\s*:/i),
  };
}

function checkTemplateVariables(planText) {
  const warnings = [];
  const errors = [];
  const clean = stripYamlComments(planText);
  // 双分隔符放行：先剔除 {{...}} 与 ${...} / $VAR / %VAR%，剩余单 {xxx} 才判白名单
  const masked = clean
    .replace(/\{\{[\s\S]*?\}\}/g, (s) => " ".repeat(s.length))
    .replace(/\$\{[^}]*\}/g, (s) => " ".repeat(s.length))
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, (s) => " ".repeat(s.length));
  const seen = new Set();
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1];
    if (TEMPLATE_WHITELIST_16.has(name) || TEMPLATE_TEST_ONLY.has(name)) continue;
    if (seen.has(name)) continue; // 去重：同文件同变量只报一次
    seen.add(name);
    warnings.push({
      severity: "warning", id: "template_unknown_variable",
      message: `未知模板变量 {${name}}（16 白名单外）`,
      suggestion: "改用 16 白名单变量：{config}/{config_path}/{suite}/{case}/{seed}/{index}/{output_dir}/{outputDir}/{result_csv}/{resultCsv}/{worker_id}/{gpu_ids}/{plan_file}/{job_name}/{experiment_name}/{python}（test 可加 {checkpoint}）；双分隔符 {{var}} / ${var} 不在此限",
    });
  }
  // train 直写大表 → critical：train 命令出现 --result-csv / {result_csv} / experiments/results 即违规
  const { train } = extractCommandBlobs(clean);
  if (train && /( --result-csv[=\s]|\{result_csv\}|\{resultCsv\}|experiments\/results)/i.test(train)) {
    errors.push({
      severity: "critical", id: "template_train_writes_big_table",
      message: "train 命令直写大表（--result-csv / {result_csv} / experiments/results）",
      suggestion: "train 只写 --output-dir {output_dir}；大表追加只允许 test 经 --result-csv {result_csv} 写入 experiments/results/<method>.csv",
    });
  }
  return { warnings, errors };
}

// ---------------------------------------------------------------------------
// G3+G4 checkOutputContract：双 csv 双 log 缺 → critical（C1：case_csv 经 run_wrapper 自动采集时降 warning）；大表缺 → critical；
//     快照缺 → warning；剥注释；单声明永不算过
// ---------------------------------------------------------------------------
function checkOutputContract(planText, mode, opts) {
  const out = [];
  const clean = stripYamlComments(planText);
  // run_wrapper 豁免：项目级 run_wrapper 存在或 plan 内显式使用 run_wrapper 时，
  // stdout.log / stderr.log 由 wrapper 自动捕获，不再要求 plan 逐项声明（明确豁免，不报 critical；
  // O2 豁免明确：info 明细如实标注豁免来源“项目级 run_wrapper 或 plan 内 run_wrapper/runWrapper”，
  // 与 critical 的 output_contract_missing_stdout/stderr_log 严格区分，禁止混报）。
  // 豁免加参 projectWrapperOk 注明：调用方透传项目级 wrapper 是否存在（projectWrapper.ok），此处注明具体来源
  // （项目级 vs plan 内），判定仍以 hasRunWrapper 为准（任一覆盖即豁免），缺参时回退 hasRunWrapper 保持兼容。
  const hasRunWrapper = Boolean(opts && opts.hasRunWrapper);
  const projectWrapperOk = Boolean(opts && (opts.projectWrapperOk ?? opts.hasRunWrapper));
  const wrapperSourceNote = projectWrapperOk ? "项目级 run_wrapper" : "plan 内 run_wrapper/runWrapper";
  const lower = clean.toLowerCase();
  const hasSummaryCsv = /metrics_summary\.csv/i.test(clean);
  const hasCaseCsv = /metrics_case\.csv/i.test(clean);
  const hasStdout = /stdout\.log/i.test(clean);
  const hasStderr = /stderr\.log/i.test(clean);
  if (!hasSummaryCsv) {
    out.push({ severity: "critical", id: "output_contract_missing_summary_csv", message: "输出契约缺 metrics_summary.csv（per-job 双 csv 之一）", suggestion: "在 expectedResults/candidateCsv/命令中声明 {output_dir}/metrics_summary.csv" });
  }
  // C1 豁免（与 stdout/stderr 自动捕获、snapshot 自动产出同模式；wrapper 覆盖时记 info，与 stdout/stderr via_wrapper 对齐）：
  // 项目级 run_wrapper 经 collect_outputs 自动采集 per-job 双 csv（result_writer 双 csv），未声明时记 info（展示层降级，判定条件不变）；
  // 无 wrapper 时仍 critical（确无声明不断言通过）。
  if (!hasCaseCsv) {
    if (hasRunWrapper) {
      out.push({ severity: "info", id: "output_contract_case_csv_via_wrapper", message: `metrics_case.csv 未声明但经 run_wrapper 自动采集（已豁免，来源：${wrapperSourceNote}，projectWrapperOk=${projectWrapperOk ? "true" : "false"}）`, suggestion: "run_wrapper 已覆盖 metrics_case.csv 采集（collect_outputs per-job 双 csv），无需在 plan 内重复声明；如需消除此提醒可在 expectedResults/candidateCsv 中显式声明 {output_dir}/metrics_case.csv（已豁免，详见 output_contract_wrapper_summary）" });
    } else {
      out.push({ severity: "critical", id: "output_contract_missing_case_csv", message: "输出契约缺 metrics_case.csv（per-job 双 csv 之一）", suggestion: "在 expectedResults/candidateCsv/命令中声明 {output_dir}/metrics_case.csv" });
    }
  }
  if (!hasStdout) {
    if (hasRunWrapper) {
      out.push({ severity: "info", id: "output_contract_stdout_via_wrapper", message: `stdout.log 未声明但经 run_wrapper 自动捕获（已豁免，来源：${wrapperSourceNote}，projectWrapperOk=${projectWrapperOk ? "true" : "false"}）`, suggestion: "run_wrapper 已覆盖 stdout.log 捕获，无需在 plan 内重复声明；如需消除此提醒可在 consoleLogs 中显式声明 stdout.log（已豁免，详见 output_contract_wrapper_summary）" });
    } else {
      out.push({ severity: "critical", id: "output_contract_missing_stdout_log", message: "输出契约缺 stdout.log（per-job 双 log 之一）", suggestion: "经 run_wrapper 捕获 stdout.log，或在 consoleLogs 中声明" });
    }
  }
  if (!hasStderr) {
    if (hasRunWrapper) {
      out.push({ severity: "info", id: "output_contract_stderr_via_wrapper", message: `stderr.log 未声明但经 run_wrapper 自动捕获（已豁免，来源：${wrapperSourceNote}，projectWrapperOk=${projectWrapperOk ? "true" : "false"}）`, suggestion: "run_wrapper 已覆盖 stderr.log 捕获，无需在 plan 内重复声明；如需消除此提醒可在 consoleLogs 中显式声明 stderr.log（已豁免，详见 output_contract_wrapper_summary）" });
    } else {
      out.push({ severity: "critical", id: "output_contract_missing_stderr_log", message: "输出契约缺 stderr.log（per-job 双 log 之一）", suggestion: "经 run_wrapper 捕获 stderr.log，或在 consoleLogs 中声明" });
    }
  }
  // 大表缺 → critical：test 上下文需 experiments/results 追加 + --result-csv 接线
  // B1 豁免：expectedResults 含 paper 大表（experiments/results/）且经 test.results_csv/
  // paper.result_csv 注入时，调度经 result_csv 回退链注入 --result-csv，不阻断 → 不报 critical，
  // 仅保留 checkTestCommand:149 的 test_command_via_injection warning；同 plan 已报该项时本 finding 经 D1 折叠降 info（二合一，判定条件不变）。
  if (mode !== "train") {
    const { test } = extractCommandBlobs(clean);
    const bigTableDeclared = /experiments\/results\//i.test(clean);
    const wired = /--result-csv[=\s]+[^\s"']*/i.test(test || "") && /\{result_csv\}|\{resultCsv\}/.test(test || "");
    // B1 二合一复用：注入三写法经 hasInjectionFieldOf 单源同轨（禁双轨）；新增 paper+expected大表且(test.results_csv|candidateCsv)命中亦降 warning
    const hasInjectionFieldB1 = hasInjectionFieldOf(clean);
    const hasCandidateCsvHit = /candidateCsv\s*:/i.test(clean);
    const hasPaperResultCsv = /paper\.result_csv\s*:/i.test(clean)
      || /paper\s*:\s*\{[^}\n]*results?_csv\s*:/i.test(clean)
      || (/paper\s*:/i.test(clean) && /^\s*results?_csv\s*:/im.test(clean));
    const hasTestResultsCsvHit = /test\.results_csv\s*:/i.test(clean)
      || /test\s*:\s*\{[^}\n]*results?_csv\s*:/i.test(clean)
      || (/test\s*:/i.test(clean) && /^\s*results?_csv\s*:/im.test(clean));
    const hasExpectedBigTable = /expectedResults\s*:/i.test(clean) && /experiments\/results\//i.test(clean);
    const viaInjectionExempt = Boolean(hasInjectionFieldB1 && bigTableDeclared);
    const bigTableViaDowngrade = Boolean(hasPaperResultCsv && hasExpectedBigTable && (hasTestResultsCsvHit || hasCandidateCsvHit));
    const viaBigTable = Boolean(viaInjectionExempt || bigTableViaDowngrade);
    if ((!bigTableDeclared || !wired)) {
      const missing = [!bigTableDeclared ? "experiments/results/<method>.csv 声明" : null, !wired ? "test --result-csv {result_csv} 接线" : null].filter(Boolean).join(" 与 ");
      if (viaBigTable) {
        out.push({ severity: "warning", id: "output_contract_big_table_via_injection", message: `输出契约缺大表追加（${missing}，经注入/candidateCsv，不阻断）`, suggestion: "确认 result_csv 回退链注入或 candidateCsv 大表声明；或补齐 test --result-csv {result_csv} 与 experiments/results/<method>.csv" });
      } else {
        out.push({ severity: "critical", id: "output_contract_missing_big_table", message: `输出契约缺大表追加（${missing}）`, suggestion: "test 双写 --output-dir {output_dir} --result-csv {result_csv}，且大表声明为 experiments/results/<method>.csv" });
      }
    }
  }
  // 快照缺 → warning；B2 复用 projectWrapperOk：run_wrapper 覆盖时转 info 并注明来源
  // （与 stdout/stderr 豁免同模式；projectWrapperOk 区分项目级 vs plan 内，判定仍以 hasRunWrapper 为准）。
  if (!/env_snapshot\.json/i.test(clean)) {
    if (hasRunWrapper) {
      out.push({ severity: "info", id: "output_contract_env_snapshot_via_wrapper", message: `env_snapshot.json 未声明但经 run_wrapper 自动产出（已豁免，来源：${wrapperSourceNote}，projectWrapperOk=${projectWrapperOk ? "true" : "false"}）`, suggestion: "run_wrapper 已覆盖 env_snapshot.json 产出，无需在 plan 内重复声明；如需消除此提醒可在 outputs 中显式声明 env_snapshot.json（已豁免，详见 output_contract_wrapper_summary）" });
    } else {
      out.push({ severity: "warning", id: "output_contract_missing_env_snapshot", message: "缺少 env_snapshot.json 快照声明", suggestion: "经 run_wrapper 自动产出 env_snapshot.json，或在 outputs 中声明" });
    }
  }
  if (!/config_snapshot\.yaml/i.test(clean)) {
    if (hasRunWrapper) {
      out.push({ severity: "info", id: "output_contract_config_snapshot_via_wrapper", message: `config_snapshot.yaml 未声明但经 run_wrapper 自动产出（已豁免，来源：${wrapperSourceNote}，projectWrapperOk=${projectWrapperOk ? "true" : "false"}）`, suggestion: "run_wrapper 已覆盖 config_snapshot.yaml 产出，无需在 plan 内重复声明；如需消除此提醒可在 outputs 中显式声明 config_snapshot.yaml（已豁免，详见 output_contract_wrapper_summary）" });
    } else {
      out.push({ severity: "warning", id: "output_contract_missing_config_snapshot", message: "缺少 config_snapshot.yaml 快照声明", suggestion: "经 run_wrapper 自动产出 config_snapshot.yaml，或在 outputs 中声明" });
    }
  }
  // 单声明永不算过：仅 paper.result_csv / expectedResults / output_dir 声明、命令无接线 → critical
  const hasDeclaration = /(result_csv|output_dir|expectedResults)\s*:/i.test(clean);
  const cmdBlob = Object.values(extractCommandBlobs(clean)).join("\n");
  const hasWire = /--result-csv|--output-dir|--output_dir|\{result_csv\}|\{resultCsv\}|\{output_dir\}|\{outputDir\}/i.test(cmdBlob);
  if (hasDeclaration && !hasWire) {
    out.push({ severity: "critical", id: "output_contract_declaration_only", message: "仅声明 result_csv/output_dir/expectedResults，无命令接线，不算通过", suggestion: "train 接 --output-dir {output_dir}；test 接 --output-dir {output_dir} --result-csv {result_csv}" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// G10 分片大表错位：多 case 分片 + expectedResults 仅指向 paper 级大表
// （experiments/results/ 且无分片名对齐的表），且 test 未带 --case/--seed 分片接线时，
// 分片名无法路由到 paper 大表 → warning。单分片 / test 已带分片接线 / 无大表声明时不报
// （静态文本启发式；anchorFor + CHECK_STATIC_ID_SRC + refTemplateFor 三同步）。
// ---------------------------------------------------------------------------
function checkShardedBigTable(planText, mode) {
  const out = [];
  if (mode === "train") return out;
  const clean = stripYamlComments(planText);
  if (!/expectedResults\s*:/i.test(clean)) return out;
  const bigTables = [...clean.matchAll(/experiments\/results\/([^\s"'}\]]+)/gi)]
    .map((m) => String(m[1]).replace(/[,;\]]+$/, "")).filter(Boolean);
  if (!bigTables.length) return out;
  const caseNames = [...clean.matchAll(/^\s*-\s*(?:case|name)\s*:\s*["']?([^\s"'#}\]]+)/gim)]
    .map((m) => String(m[1]).trim()).filter(Boolean);
  if (caseNames.length < 2 && !isMultiJob(clean)) return out;
  // case 分片名 vs paper 大表名：任一分片名命中任一大表名即算对齐（大小写不敏感）
  const lowerTables = bigTables.join("\n").toLowerCase();
  if (caseNames.some((c) => c && lowerTables.includes(String(c).toLowerCase()))) return out;
  // test 已带分片接线（--case/--seed 或 {case}/{seed}）即视为可路由，不报
  const { test } = extractCommandBlobs(clean);
  if (/--case\b|--seed\b|\{case\}|\{seed\}/.test(test || "")) return out;
  out.push({
    severity: "warning",
    id: "sharded_big_table_mismatch",
    message: `case 分片（${caseNames.slice(0, 4).join("、")}${caseNames.length > 4 ? "…" : ""}）与 paper 大表（${bigTables.slice(0, 2).join("、")}）名不对齐且 test 缺 --case/--seed 分片接线（expectedResults 仅指向 paper 大表）`,
    suggestion: "test 补齐 --case {case} --seed {seed} 分片接线（真实正例）；或按分片命名大表 experiments/results/<case>.csv",
  });
  return out;
}

// ---------------------------------------------------------------------------
// final.yaml 聚合提示：paper final.csv 与分片 image_only 等不对齐时加 info 聚合提示
// （轻量判定：仅文本关键字启发式，不碰 warning 口径；sharded warning 原样保留。
// anchorFor + CHECK_STATIC_ID_SRC + refTemplateFor 三同步）。
// ---------------------------------------------------------------------------
function checkFinalCsvAggregation(planText) {
  const out = [];
  const clean = stripYamlComments(planText);
  if (!/final\.csv/i.test(clean)) return out;
  if (!/image_only|shard/i.test(clean)) return out;
  if (!/paper\s*:[\s\S]{0,400}?final\.csv/i.test(clean)) return out;
  // 聚合豁免：final.yaml/statistics/plotting 已声明聚合即豁免（statistics/plotting 聚合路径与 final.yaml 同轨）；
  // warning 口径不动（本提示恒为 info，sharded warning 原样保留）。
  if (/aggregat|final\.yaml|merge\s*:|reduce\s*:|statistics|plotting/i.test(clean)) return out;
  out.push({
    severity: "info",
    id: "final_csv_aggregation_hint",
    message: "paper final.csv 与分片 image_only/shard 明细不对齐（分片产物缺聚合到 final.csv，final.yaml/statistics/plotting 聚合提示）",
    suggestion: "在 final.yaml 或聚合步骤（statistics/plotting 聚合路径）中将各分片 image_only 产物汇总为 paper final.csv；或确认分片命名与 final.csv 对齐",
  });
  return out;
}

// ---------------------------------------------------------------------------
// G5 并发根写 + G8 job_name：占位 <JOB> + 同文件 + 6 根禁写 + job_name 缺失 → critical
// 6 根：".", "/", "", "work_dirs", "debug_runs", "runs"（归一化后比较，
//   "./"→".", "work_dirs/"→"work_dirs"，模板占位含 { 即跳过存在性判定）。
// ---------------------------------------------------------------------------
function planSlugOf(rel) {
  const base = String(rel || "").replace(/\\/g, "/").split("/").pop() || "";
  const stem = base.replace(/\.[^.]+$/, "");
  return stem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function isMultiJob(clean) {
  return /seeds\s*:\s*\[[^\]]*,/.test(clean)
    || /seed\s*:\s*\[[^\]]*,/.test(clean)
    || (/^\s*-\s*(case|name)\s*:/im.test(clean)
      && (clean.match(/^\s*-\s*(case|name)\s*:/gim) || []).length > 1);
}

function checkConcurrencyRisks(planText, mode) {
  const out = [];
  const clean = stripYamlComments(planText);
  if (/<JOB>/i.test(planText)) {
    out.push({ severity: "critical", id: "concurrency_job_placeholder", message: "残留 <JOB> 占位未渲染", suggestion: "改用 {job_name} / {index}_{case}_seed{seed} 显式命名，避免多 job 同文件" });
  }
  // 同文件风险：output/result 模板缺 case/seed/index/job_name/experiment_name 区分度
  const tplLines = clean.split(/\r?\n/).filter((l) => /(output_dir|outputDir|sweep_dir|job_name|result_csv|resultCsv)\s*:/i.test(l)).join("\n");
  const multiJob = isMultiJob(clean);
  if (tplLines) {
    const hasDiscriminator = /\{(case|seed|index|job_name|experiment_name)\}/.test(tplLines);
    if (!hasDiscriminator && (multiJob || mode === "train_test")) {
      out.push({ severity: "critical", id: "concurrency_same_file", message: "输出模板缺 case/seed/index/job_name 区分度，多 job 将写同一文件", suggestion: "job_name 用 {index}_{case}_seed{seed}，output 经 sweep_dir/job_name 拼装" });
    }
  }
  // G8 job_name 缺失：多 job 却无 job_name 键/占位 → critical（单 job 或无并发不报）
  const hasJobNameKey = /(^|\n)\s*(job_name|jobName)\s*:/i.test(clean) || /\{job_name\}/.test(clean);
  if (!hasJobNameKey && multiJob) {
    out.push({ severity: "critical", id: "concurrency_job_name_missing", message: "多 job 缺 job_name 模板，并发将写同一文件", suggestion: '在 naming 下补充 job_name: "{index}_{case}_seed{seed}"，output 经 sweep_dir/job_name 拼装' });
  }
  // 6 根禁写 → critical（归一化：反斜杠→/，去尾斜杠，去 ./ 前缀后比对）
  const dirVals = [];
  const re = /^\s*(output_dir|outputDir|sweep_dir|naming|dir)\s*:\s*["']?([^"'#\n]+)/gim;
  let mm;
  while ((mm = re.exec(clean)) !== null) dirVals.push(String(mm[2]).trim());
  for (const v of dirVals) {
    if (/\{/.test(v)) continue; // 占位路径跳过根写判定（未渲染前不判）
    const norm = v.replace(/\\/g, "/").replace(/\/+$/, "");
    const stripped = norm.replace(/^\.\//, "").toLowerCase();
    if (stripped === "." || stripped === "./" || stripped === "/" || stripped === "" || stripped === "work_dirs" || stripped === "debug_runs" || stripped === "runs") {
      out.push({ severity: "critical", id: "concurrency_root_write", message: `输出直写根目录本身: ${v}`, suggestion: "输出收敛到 work_dirs/<suite>/<job_name>/ 等子目录，禁止写根本身；debug 产物走 debug_runs 隔离目录但不得作为正式输出" });
      break;
    }
    // debug 隔离：正式输出不得指向 debug_runs/ 下（G6 调试隔离联动）
    if (/debug_runs\//i.test(v.replace(/\\/g, "/"))) {
      out.push({ severity: "critical", id: "concurrency_debug_isolation", message: `正式输出指向调试隔离目录: ${v}`, suggestion: "正式输出收敛到 work_dirs/<suite>/<job_name>/；debug_runs 仅做临时调试，不可作为 plan 输出" });
      break;
    }
  }
  return out;
}

// G5/G6 scp 禁令：命令出现 scp/rsync 明文 → critical（文件传输走 API，禁 scp/rsync/临时 SSH）
function checkScpForbidden(planText, rel) {
  const c = stripYamlComments(planText);
  if (/(^|[\s;|&'"])(scp|rsync)\b/i.test(c)) {
    return [{ file: rel, severity: "critical", id: "plan_scp_forbidden", message: "命令含 scp/rsync 明文传输", suggestion: "文件传输走 simple-local.simple-sftp API（>=0.2.4），禁 scp/rsync/临时 SSH" }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// G6 checkResultSchema：有 metrics_summary 样例验 8 列缺 → critical，
//     NaN/Inf/空 → critical，mapping 不掩盖；无样例跳过
// ---------------------------------------------------------------------------
const RESULT_SCHEMA_REQUIRED_8 = ["experiment_id", "suite", "method", "dataset", "split", "seed", "metric", "value"];
// Gate-1：metrics_case.csv 必填 5 列（mapping 不掩盖缺列）
const RESULT_CASE_REQUIRED_5 = ["experiment_id", "case_id", "dataset", "split", "method"];

function collectSampleCsvs(projectDir) {
  const all = [];
  const perType = { summary: 0, case: 0 }; // 双收：两类样例各最多计入 10 个
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
      if (ent.isDirectory() && EXCLUDE_DIR_NAMES.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      const rel = path.relative(projectDir, p).replace(/\\/g, "/");
      if (EXCLUDE_REL_PREFIXES.some((pr) => rel === pr.slice(0, -1) || rel.startsWith(pr))) continue;
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name === "metrics_summary.csv") {
        if (perType.summary < 10) { all.push(p); perType.summary += 1; }
      } else if (ent.isFile() && ent.name === "metrics_case.csv") {
        if (perType.case < 10) { all.push(p); perType.case += 1; }
      }
    }
  };
  walk(projectDir);
  return all.slice(0, 10); // 防刷屏：双收后总数上限 10，最多验 10 个样例
}

function parseCsvHeaderAndRows(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { header: [], rows: [] };
  const split = (l) => l.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
  return { header: split(lines[0]), rows: lines.slice(1, 51).map(split) };
}

function checkCaseSampleCsv(rel, parsed) {
  const out = [];
  const lower = parsed.header.map((h) => h.toLowerCase());
  // Gate-1：metrics_case.csv 按 5 必填列判定（mapping 不掩盖）
  const missing = RESULT_CASE_REQUIRED_5.filter((c) => !lower.includes(c));
  if (missing.length) {
    out.push({ file: rel, severity: "critical", id: "result_schema_case_missing_columns", message: `metrics_case 样例缺列: ${missing.join(", ")}（需 5 列 ${RESULT_CASE_REQUIRED_5.join(", ")}，csvColumnMapping 不掩盖缺列）`, suggestion: "补齐 5 列，或检查表头拼写（experiment_id,case_id,dataset,split,method）" });
  }
  const valueIdx = lower.indexOf("value");
  if (valueIdx >= 0) {
    for (let i = 0; i < parsed.rows.length; i += 1) {
      const raw = parsed.rows[i][valueIdx] ?? "";
      const v = String(raw).trim();
      // value 可空（空行不断言），但禁 NaN/Inf 占位
      if (/^nan$/i.test(v) || /^inf(inity)?$/i.test(v) || /^[+-]inf(inity)?$/i.test(v)) {
        out.push({ file: rel, severity: "critical", id: "result_schema_case_bad_value", message: `metrics_case 样例第 ${i + 2} 行 value 非法: '${raw}'（禁 NaN/Inf 占位，缺失留空）`, suggestion: "value 只写有限数值；缺失留空而非 NaN/Inf 占位" });
        break;
      }
    }
  }
  return out;
}

function checkSummarySampleCsv(rel, parsed) {
  const out = [];
  const lower = parsed.header.map((h) => h.toLowerCase());
  const missing = RESULT_SCHEMA_REQUIRED_8.filter((c) => !lower.includes(c));
  // mapping 不掩盖：即使有 csvColumnMapping，缺列仍报 critical
  if (missing.length) {
    out.push({ file: rel, severity: "critical", id: "result_schema_summary_missing_columns", message: `metrics_summary 样例缺列: ${missing.join(", ")}（需 8 列 ${RESULT_SCHEMA_REQUIRED_8.join(", ")}，csvColumnMapping 不掩盖缺列）`, suggestion: "补齐 8 列，或检查表头拼写（experiment_id,suite,method,dataset,split,seed,metric,value）" });
  }
  const valueIdx = lower.indexOf("value");
  if (valueIdx >= 0) {
    let bad = 0;
    for (let i = 0; i < parsed.rows.length && bad < 3; i += 1) {
      const v = String(parsed.rows[i][valueIdx] ?? "").trim();
      if (v === "" || /^nan$/i.test(v) || /^inf(inity)?$/i.test(v) || /^[+-]inf(inity)?$/i.test(v)) {
        bad += 1;
        out.push({ file: rel, severity: "critical", id: "result_schema_summary_bad_value", message: `metrics_summary 样例第 ${i + 2} 行 value 非法: '${parsed.rows[i][valueIdx] ?? ""}'（禁 NaN/Inf/空）`, suggestion: "value 只写有限数值；缺失用空行删去该行而非 NaN/Inf 占位" });
      }
    }
  }
  return out;
}

// G6 注：有 metrics_summary/metrics_case 样例才验（无样例跳过）；8 列/5 列缺列与 NaN/Inf/空 critical，mapping 不掩盖；双收各 ≤10、总数 ≤10 防刷屏。
function checkResultSchema(projectDir) {
  const out = [];
  const samples = collectSampleCsvs(projectDir);
  if (!samples.length) return out; // 无样例跳过
  for (const file of samples) {
    const rel = normRel(projectDir, file);
    const parsed = parseCsvHeaderAndRows(file);
    if (!parsed) continue;
    const base = path.basename(file);
    // 分流：metrics_case.csv 走 5 列门，metrics_summary.csv 走 8 列门
    if (base === "metrics_case.csv") {
      out.push(...checkCaseSampleCsv(rel, parsed));
      continue;
    }
    out.push(...checkSummarySampleCsv(rel, parsed));
  }
  return out;
}

// ---------------------------------------------------------------------------
// G7 checkPlottingContract：绘图五文件存在 + 字段（无声明跳过；扁平/by_plan 双轨放行；
//   文档 ⊆ 代码子集策略：缺文件 → warning，字段缺 → critical）
// 五文件：result_registry.json / statistics.json / paperTable CSV /
//   case_level_index.json / dataset profile.json
// ---------------------------------------------------------------------------
const PLOTTING_KEYWORDS_RE = /plotting_contract|result_registry|statistics\.json|case_level|paper_table|simple_results_table|dataset.*profile/i;
const G7_REGISTRY_NEED = ["resultId", "experimentId", "suite", "method", "dataset", "split", "seed"];
const G7_STATISTICS_NEED = ["suite", "metric", "mean", "std"];
const G7_PAPERTABLE_NEED = ["method", "dataset", "split", "metric", "mean", "std"];
const G7_CASELEVEL_NEED = ["case_id", "method", "dataset", "split", "metric", "value"];
const G7_PROFILE_NEED = ["dataset", "split"];

function plottingCandidates(projectDir, rel, flat, byPlan) {
  const slug = planSlugOf(rel);
  const cands = [];
  if (flat) cands.push(path.join(projectDir, flat));
  if (slug && byPlan) cands.push(path.join(projectDir, byPlan.replace("<slug>", slug)));
  // 无 slug 时 byPlan 退化为 flat（去重）
  return [...new Set(cands)];
}

function readJsonKeys(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    const keys = new Set();
    const walk = (o, depth) => {
      if (!o || depth > 2) return;
      if (Array.isArray(o)) { o.slice(0, 3).forEach((x) => walk(x, depth + 1)); return; }
      if (typeof o === "object") {
        for (const k of Object.keys(o)) keys.add(k);
        for (const v of Object.values(o)) {
          if (v && typeof v === "object") walk(v, depth + 1);
        }
      }
    };
    walk(obj, 0);
    return keys;
  } catch { return null; }
}

// G7 注：无绘图声明跳过；扁平/by_plan 双轨放行；缺文件 warning、字段缺 critical；五文件共用 missing_file 同 id，各块 message 内 key 区分（[DUP] 仅去重标记）。
function checkPlottingContract(planText, projectDir, rel) {
  const out = [];
  const clean = stripYamlComments(planText);
  if (!PLOTTING_KEYWORDS_RE.test(clean)) return out; // 无声明跳过（同 G6 无样例跳过）
  const slug = planSlugOf(rel);
  const specs = [
    { key: "result_registry", need: G7_REGISTRY_NEED, cands: plottingCandidates(projectDir, rel, "simple_cluster/results/result_registry.json", "simple_cluster/results/by_plan/<slug>/result_registry.json") },
    { key: "statistics", need: G7_STATISTICS_NEED, cands: plottingCandidates(projectDir, rel, "simple_cluster/results/statistics.json", "simple_cluster/results/by_plan/<slug>/statistics.json") },
    { key: "paper_table", need: G7_PAPERTABLE_NEED, cands: plottingCandidates(projectDir, rel, "paper/tables/simple_results_table.csv", "paper/tables/simple_results_table__<slug>.csv") },
    { key: "case_level", need: G7_CASELEVEL_NEED, cands: plottingCandidates(projectDir, rel, "simple_cluster/results/case_level_index.json", "simple_cluster/results/by_plan/<slug>/case_level_index.json") },
    { key: "dataset_profile", need: G7_PROFILE_NEED, cands: plottingCandidates(projectDir, rel, "simple_cluster/datasets/profile.json", "simple_cluster/datasets/by_plan/<slug>/profile.json") },
  ];
  void slug;
  for (const s of specs) {
    const hit = s.cands.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (!hit) {
      const want = s.cands.map((f) => path.relative(projectDir, f).replace(/\\/g, "/")).join(" 或 ");
      out.push({ file: rel, severity: "warning", id: "plotting_contract_missing_file", message: `绘图契约缺 ${s.key}（期望 ${want}）`, suggestion: "按 docs/output-contract-for-plotting.md 落盘五文件，或经 Scheduler 归档产出 result_registry/statistics/paperTable/caseLevel/profile" });
      continue;
    }
    if (/\.csv$/i.test(hit)) {
      const parsed = parseCsvHeaderAndRows(hit);
      if (!parsed) continue;
      const lower = parsed.header.map((h) => h.toLowerCase());
      const missing = s.need.filter((c) => !lower.includes(c.toLowerCase()));
      if (missing.length) {
        out.push({ file: rel, severity: "critical", id: "plotting_contract_bad_fields", message: `绘图契约 ${s.key} 缺字段: ${missing.join(", ")}（文件 ${path.relative(projectDir, hit).replace(/\\/g, "/")}）`, suggestion: `按 src/features/PlottingContract.ts#${s.key} 补齐字段（${s.need.join(", ")}，ci/pValue 可空不强制）` });
      }
    } else {
      const keys = readJsonKeys(hit);
      if (!keys) continue;
      const lower = new Set([...keys].map((k) => String(k).toLowerCase()));
      const missing = s.need.filter((c) => !lower.has(c.toLowerCase()));
      if (missing.length) {
        out.push({ file: rel, severity: "critical", id: "plotting_contract_bad_fields", message: `绘图契约 ${s.key} 缺字段: ${missing.join(", ")}（文件 ${path.relative(projectDir, hit).replace(/\\/g, "/")}）`, suggestion: `按 src/features/PlottingContract.ts#${s.key} 补齐字段（${s.need.join(", ")}，ci/pValue 可空不强制）` });
      }
    }
  }
  return out;
}

// O1 候选收敛：仅提取候选键域内的产物值（同行行内值/数组 + 后续 `- item` 列表块），
// 供 G8-4 扩展名判定；cases/secondaryMetrics 等非候选列表不再计入。
// 三键复用：summaryCsv/caseCsv/manifest 并入同一键正则，统一经 extractCandidateValues 提取，不再另起三路单值正则（防双轨漂移）。
const CANDIDATE_LIST_KEYS_RE = /^\s*(candidateCsv|candidateJson|consoleLogs|textLogs|summaryCsv|caseCsv|manifest|test\.results_csv|paper\.result_csv)\s*:(.*)$/i;
const ARTIFACT_TOKEN_RE = /["']?([^\s"'#,[\]{}]+\.[A-Za-z0-9]+)["']?/g;

function extractCandidateValues(clean) {
  const vals = [];
  // B3 归一 + posix 化：候选值统一 trim + 反斜杠→/（Windows 路径归一），占位检查前先归一；
  // test.results_csv / paper.result_csv 点分键已并入 CANDIDATE_LIST_KEYS_RE 同轨提取。
  const normCand = (v) => String(v == null ? "" : v).trim().replace(/\\/g, "/");
  const lines = String(clean || "").split(/\r?\n/);
  let inCandBlock = false;
  for (const line of lines) {
    const keyHit = CANDIDATE_LIST_KEYS_RE.exec(line);
    if (keyHit) {
      ARTIFACT_TOKEN_RE.lastIndex = 0;
      let tm;
      while ((tm = ARTIFACT_TOKEN_RE.exec(keyHit[2] || "")) !== null) vals.push(normCand(tm[1]));
      inCandBlock = true;
      continue;
    }
    if (inCandBlock) {
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item) {
        ARTIFACT_TOKEN_RE.lastIndex = 0;
        let im;
        while ((im = ARTIFACT_TOKEN_RE.exec(item[1])) !== null) vals.push(normCand(im[1]));
        continue;
      }
      inCandBlock = false;
    }
  }
  return vals;
}

function checkSimpleProject(projectDir) {
  const findings = { warnings: [], infos: [], errors: [] };
  let file = null;
  for (const rel of ["experiments/simple_project.yaml", "experiments/simple_project.yml"]) {
    const f = path.join(projectDir, rel);
    if (fs.existsSync(f)) { file = f; break; }
  }
  if (!file) return findings;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return findings;
  }
  const clean = stripYamlComments(text);
  const rel = normRel(projectDir, file);
  const push = (sev, id, message, suggestion) => {
    findings[sev === "critical" ? "errors" : sev === "warning" ? "warnings" : "infos"].push({ file: rel, severity: sev, id, message, suggestion });
  };
  // tensorboard 无消费只 info（无依赖不阻断；展示层降级，判定条件不变，明确不升级 critical）
  if (!/tensorboardLogDirs/i.test(clean)) {
    push("info", "simple_project_no_tensorboard", "simple_project 缺少 tensorboardLogDirs", "在 experiments/simple_project.yaml 中补充 tensorboardLogDirs（TensorBoard 日志目录），否则 TensorBoard 通道不可用；如需抑制此提醒，示例：node scripts/check-static.js --project <dir> --write-md --quiet-info");
  }
  // manifest 缺声明只 warning（Schema 默认 artifact_manifest.json，落 {output_dir}/ 下）
  if (!/manifest\s*:/i.test(clean)) {
    push("warning", "simple_project_no_manifest", "simple_project 缺少 outputs.manifest 声明", "在 outputs 中补充 manifest: artifact_manifest.json（落 {output_dir}/ 下），便于归档索引");
  }
  // Gate-2 版本锚定：仅行首 version 系 5 字段计入 SimpleExperiment 版本判定，
  // simpleSftp/agentVersion/python_version 等他字段版本永不触发 version_old/version_undeclared
  // （误报根因：裸 /(\d+)\.(\d+)\.(\d+)/ 全文匹配；此处锚定行首 ^[ \t]* + 5 字段全名）。
  const VERSION_KEYS_5 = "(?:version|simpleExperimentVersion|simple_experiment_version|pluginVersion|extensionVersion)";
  const verMatch = new RegExp(`^[ \\t]*${VERSION_KEYS_5}\\s*:\\s*["']?(\\d+)\\.(\\d+)\\.(\\d+)`, "im").exec(clean);
  if (verMatch) {
    const ver = [verMatch[1], verMatch[2], verMatch[3]];
    if (compareVersions(ver, ["0", "4", "2"]) < 0) {
      push("warning", "simple_project_version_old", `simple_project 版本 ${ver.join(".")} 过旧`, "升级 SimpleExperiment 至 >=0.4.2 后再跑 plan");
    }
  } else {
    // 无版本声明时回退为 info（不阻断、不告警，仅提示可声明 version 以启用版本门）
    push("info", "simple_project_version_undeclared", "simple_project 未声明 version（回退：跳过版本门）", "如需启用版本门，在 experiments/simple_project.yaml 顶层补充 version: <x.y.z>（>=0.4.2）；如需抑制此提醒，示例：node scripts/check-static.js --project <dir> --write-md --quiet-info");
  }
  // G8-1 SimpleSFTP >= 0.2.4：文件内 simpleSftp/simple-sftp 版本声明低于基线 → critical
  const sftpMatch = /simple[-_]?sftp[^0-9]*(\d+)\.(\d+)\.(\d+)/i.exec(text);
  if (sftpMatch) {
    if (compareVersions([sftpMatch[1], sftpMatch[2], sftpMatch[3]], ["0", "2", "4"]) < 0) {
      push("critical", "simple_project_simplesftp_version", `SimpleSFTP 版本 ${sftpMatch.slice(1, 4).join(".")} 低于基线 0.2.4`, "升级 simple-local.simple-sftp 至 >=0.2.4（文件传输走 API，禁 scp/rsync/临时 SSH）");
    }
  }
  // G6 单根禁 scp：simple_project 内出现 scp/rsync 明文 → critical（走 API，禁临时 SSH）
  if (/(^|[\s;|&'"])(scp|rsync)\b/i.test(clean)) {
    push("critical", "simple_project_scp_forbidden", "simple_project 含 scp/rsync 明文传输", "文件传输走 simple-local.simple-sftp API（>=0.2.4），禁 scp/rsync/临时 SSH");
  }
  // G8-2 AGENT_VERSION 漂移：simple_project 内 agentVersion 与代码单源不一致 → warning
  let codeAgentVersion = "";
  try {
    const agentSrc = fs.readFileSync(path.join(ROOT, "src", "clusterAgentRuntime.legacy.ts"), "utf8");
    const am = /AGENT_VERSION\s*=\s*"([^"]+)"/.exec(agentSrc);
    if (am) codeAgentVersion = am[1];
  } catch { /* 无源码时跳过 */ }
  const declAgent = /(agentVersion|agent_version)\s*:\s*["']?([^"'\s#}]+)/i.exec(clean);
  if (declAgent && codeAgentVersion && declAgent[2] !== codeAgentVersion) {
    push("warning", "simple_project_agent_version_drift", `agentVersion 漂移：声明 ${declAgent[2]} vs 代码 ${codeAgentVersion}`, "以 src/clusterAgentRuntime.legacy.ts#AGENT_VERSION 为单源对齐声明");
  }
  // G8-3 runWrapper 存在性：adapter.runWrapper 指向必须在项目内存在 → critical
  const rwMatch = /runWrapper\s*:\s*["']?([^"'\s#}]+)/i.exec(clean);
  if (rwMatch) {
    const rwRel = String(rwMatch[1]).trim();
    const rwAbs = path.join(projectDir, rwRel);
    let ok = false;
    try { ok = fs.statSync(rwAbs).isFile(); } catch { ok = false; }
    if (!ok) {
      push("critical", "simple_project_runwrapper_missing", `runWrapper 不存在: ${rwRel}`, "确认 experiments/simple_adapter/run_wrapper.py 存在且 adapter.runWrapper 指向项目内相对路径");
    }
  }
  // O1 候选收敛：candidateCsv/candidateJson/consoleLogs/textLogs + summaryCsv/caseCsv/manifest 七键
  // 统一经 extractCandidateValues 复用提取（行内值 + 后续 - item 块）；cases/secondaryMetrics 等
  // 非候选列表永不计入（全文任意 `- x.ext` 不再误伤）；合法扩展名收敛为
  // .csv/.json/.jsonl/.txt/.log/.out/.md/.markdown（config_diff.json 具名放行）。
  const candVals = extractCandidateValues(clean);
  for (const v of candVals) {
    if (/\*/.test(v)) continue; // 通配候选先跳过/豁免再判扩展名与路径（与 extractRemotePathCandidates 通配跳过同轨）
    if (/\{/.test(v)) continue; // 占位路径跳过扩展名判定
    if (/config_diff\.json$/i.test(v)) continue; // 具名放行：配置差分快照
    if (!/\.(csv|json|jsonl|txt|log|out|md|markdown)$/i.test(v)) {
      push("critical", "simple_project_candidate_extension", `候选产物扩展名非法: ${v}`, "候选扩展名收敛为 .csv/.json/.jsonl/.txt/.log/.out/.md/.markdown 之一（config_diff.json 具名放行）");
    }
  }
  // G8-5 metricAliases 落主次：别名值必须映射到 primaryMetric/secondaryMetrics
  const primary = /(primaryMetric)\s*:\s*["']?([^"'\s#}]+)/i.exec(clean);
  const secondaries = [...clean.matchAll(/-\s*["']?([A-Za-z0-9_]+)["']?/g)].map((x) => x[1]);
  const aliasPairs = [...clean.matchAll(/^\s{2,}([A-Za-z0-9_]+)\s*:\s*["']?([A-Za-z0-9_]+)["']?\s*$/gm)]
    .filter((x) => /metricAliases/i.test(clean.slice(Math.max(0, (x.index || 0) - 400), x.index || 0)));
  if (aliasPairs.length) {
    const targets = new Set([primary ? primary[2] : null, ...secondaries].filter(Boolean));
    for (const [, k, v] of aliasPairs) {
      if (targets.size && ![...targets].includes(v)) {
        push("warning", "simple_project_metric_alias", `metricAliases ${k}: ${v} 未落到主/次指标`, "别名值映射到 primaryMetric 或 secondaryMetrics其一");
      }
    }
  }
  // G8-6 entrypoints 可渲染：仅白名单 + checkpoint + python 风格分隔符
  for (const mm of clean.matchAll(/(trainCommandTemplate|testCommandTemplate)\s*:\s*["']?(.+?)["']?\s*$/gim)) {
    const tpl = mm[2];
    const masked = tpl.replace(/\{\{.*?\}\}/g, "").replace(/\$\{[^}]*\}/g, "");
    for (const vm of masked.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      if (!TEMPLATE_WHITELIST_16.has(vm[1]) && !TEMPLATE_TEST_ONLY.has(vm[1])) {
        push("critical", "simple_project_entrypoint_unrenderable", `entrypoints 含不可渲染变量 {${vm[1]}}`, "entrypoints 只用 16 白名单 + {checkpoint}（test）/ {python} 占位");
        break;
      }
    }
  }
  return findings;
}

const PATH_VALUE_KEYS = "(?:result_csv|resultCsv|results_csv|resultsCsv|metrics_csv|metricsCsv|summary_csv|summaryCsv|output_csv|outputCsv|result_json|resultJson|metrics_json|metricsJson|summary_txt|summaryTxt|log_file|logFile|output_dir|outputDir|output_path|result_dir|checkpoint|ckpt)";
const KEY_VALUE_RE = new RegExp(`${PATH_VALUE_KEYS}\\s*[:=]\\s*["']?([^"'\\s\\]]+)`, "gi");
const FLAG_RE = /--(?:result[-_]csv|results[-_]csv|metrics[-_]csv|summary[-_]csv|result[-_]json|metrics[-_]json|output[-_]dir|log[-_]file)[=\s]+([^\s"'\]]+)/gi;
const QUOTED_ARTIFACT_RE = /["']([^"'\n]*?\.(?:csv|json|txt|log|out))["']/gi;

function hasProjectRunWrapper(projectDir) {
  const wrapperFile = path.join(projectDir, "experiments", "simple_adapter", "run_wrapper.py");
  if (fs.existsSync(wrapperFile)) {
    return { ok: true, source: path.relative(projectDir, wrapperFile) || wrapperFile };
  }
  for (const rel of ["experiments/simple_project.yaml", "experiments/simple_project.yml", "simple_project.yaml", "simple_project.yml"]) {
    const f = path.join(projectDir, rel);
    if (!fs.existsSync(f)) continue;
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (/runWrapper\s*:/i.test(text)) return { ok: true, source: rel };
  }
  return { ok: false };
}

function extractRemotePathCandidates(text) {
  const found = new Set();
  for (const re of [KEY_VALUE_RE, FLAG_RE, QUOTED_ARTIFACT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // Gate-3 括号消歧：先剥离候选首尾括号/引号残留（含中英文括号），
      // 候选内部仍含括号视为文档片段（如 "(见...)" / "func(x)"）而非路径，直接丢弃。
      let v = String(m[1] || "").trim()
        .replace(/^[(<\[（【「《'"]+/, "")
        .replace(/[,;)\]>）】」》.'"]+$/, "");
      if (!v) continue;
      if (/[()（）【】「」《》]/.test(v)) continue;
      // 模板占位一律跳过：含 { 或 } 即视为未渲染占位（如 {output_dir}/{result_csv}/${...}），不做路径判定
      if (v && !/[{}]/.test(v) && !/^\$\{/.test(v) && !/\*/.test(v)) found.add(v);
    }
  }
  return [...found];
}

function checkPaths(candidates, projectLabel) {
  const findings = [];
  for (const candidate of candidates) {
    if (!isSafeRemotePath(candidate)) {
      findings.push({
        severity: "critical",
        id: "path_invalid",
        path: candidate,
        message: `路径不在远端读白名单内或含危险段: ${candidate}`,
        suggestion: "改为项目内相对路径（首段使用 simple_cluster/work_dirs/experiments/exports/results/paper/outputs/runs/logs 等白名单根），禁止绝对路径、C:/ 盘符、.. 回跳与 .pem/.key/ssh 私钥文件",
      });
      continue;
    }
    try {
      safeRemoteProjectChild(`/remote/${projectLabel}`, candidate);
    } catch (err) {
      findings.push({
        severity: "critical",
        id: "path_invalid",
        path: candidate,
        message: `路径逃逸工程根: ${candidate}（${err.message}）`,
        suggestion: "路径必须收敛在工程根内，去除 .. 回跳与前导 /",
      });
    }
  }
  return findings;
}

function main() {
  const args = parseArgs(process.argv);
  const projectDir = args.project;
  const projectLabel = path.basename(projectDir) || "project";
  const errors = [];
  const warnings = [];
  const infos = [];

  const planFiles = findPlanFiles(projectDir);
  if (!planFiles.length) {
    warnings.push({
      file: "(none)",
      severity: "warning",
      id: "no_plan_files",
      message: "目标项目内未发现 plan 文件（experiments/plans/**/*.yaml 或 plan*.yaml）",
      suggestion: "如需校验 Plan，请在目标项目 experiments/plans/ 下放置 plan.yaml；空项目此项为提醒，不阻断",
    });
  }

  const projectWrapper = hasProjectRunWrapper(projectDir);
  let wrapperCoveredCount = 0;
  const seenFindingKeys = new Set(); // 全局去重：file::severity::id::message 防刷屏
  const pushDedup = (bucket, f) => {
    if (!f.suggestion) f.suggestion = "（暂无自动修复建议，需人工排查）"; // G1-G8 必填 suggestion，禁空
    const key = `${f.file}::${f.severity}::${f.id || f.path}::${String(f.message || "").slice(0, 120)}`;
    if (seenFindingKeys.has(key)) return;
    seenFindingKeys.add(key);
    bucket.push(f);
  };

  for (const file of planFiles) {
    const rel = normRel(projectDir, file);
    const text = fs.readFileSync(file, "utf8");
    // plan 行锚：按 finding id 首段映射到 plan 键行（未命中回 1），随 finding.line 落 JSON，MD 明细渲染 `- 行号:` 不断链。plan行锚说明：B3 精确分支先于通用 output_contract 分支命中；新增 id 须同步 anchorFor + CHECK_STATIC_ID_SRC + refTemplateFor，否则抛错，禁止静默指向旧行号。
    const anchorFor = (f) => {
      if (f && f.line != null) return f.line;
      const id = String((f && (f.id || f.path)) || "");
      if (/^mode/.test(id)) return planLineOf(text, /mode\s*:/i);
      if (/^seeds/.test(id)) return planLineOf(text, /seeds\s*:/i);
      if (/^cases/.test(id)) return planLineOf(text, /cases|experiments\s*:/i);
      if (/^base_config|^config/.test(id)) return planLineOf(text, /base_config|config\s*:/i);
      if (/^train_command/.test(id)) return planLineOf(text, /train_command|trainCommand|command\s*:/i);
      if (/^test_command/.test(id)) return planLineOf(text, /test_command|testCommand\s*:/i);
      if (/^template/.test(id)) return planLineOf(text, /train_command|test_command|trainCommand|testCommand\s*:/i);
      // B3 行锚 key 行：同类 id 按 key 行精确定位（先于通用 output_contract 分支命中）。
      if (/missing_case_csv/.test(id)) return planLineOf(text, /metrics_case/i);
      if (/case_csv_via_wrapper/.test(id)) return planLineOf(text, /metrics_case/i);
      if (/missing_summary_csv/.test(id)) return planLineOf(text, /metrics_summary/i);
      if (/missing_big_table/.test(id)) return planLineOf(text, /experiments\/results/i);
      if (/big_table_via_injection/.test(id)) return planLineOf(text, /experiments\/results/i);
      if (/sharded_big_table/.test(id)) return planLineOf(text, /experiments\/results/i);
      if (/wrapper_summary/.test(id)) {
        const wlines = String(text || "").split(/\r?\n/);
        for (let li = 0; li < wlines.length; li += 1) {
          if (/run_wrapper|runWrapper/i.test(wlines[li])) return li + 1;
        }
        // 回退改锚 runner 行（runner/train_command/test_command，对应 baseline12-13/aoept10-11 口径，不再回退 paper 行）。
        return planLineOf(text, /runner\s*:|train_command|test_command/i);
      }
      // final.yaml 聚合提示行锚：paper final.csv 聚合位（paper/result_csv/final.csv/expectedResults）。
      if (/final_csv_aggregation/.test(id)) return planLineOf(text, /paper\s*:|result_csv|final\.csv|expectedResults/i);
      if (/env_snapshot/.test(id)) return planLineOf(text, /env_snapshot/i);
      if (/config_snapshot/.test(id)) return planLineOf(text, /config_snapshot/i);
      if (/tensorboard/.test(id)) return planLineOf(text, /tensorboard|SummaryWriter/i);
      if (/missing_case\b|cases_missing|cases_empty/.test(id)) return planLineOf(text, /cases|experiments\s*:/i);
      if (/^output_contract|^output_interface/.test(id)) return planLineOf(text, /expectedResults|result_csv|output_dir|consoleLogs\s*:/i);
      if (/^concurrency/.test(id)) return planLineOf(text, /naming|job_name|sweep_dir|output_dir\s*:/i);
      if (/suite/.test(id)) return planLineOf(text, /suite\s*:/i);
      return 1;
    };
    const pushPlan = (bucket, f) => pushDedup(bucket, { ...f, file: rel, line: anchorFor(f) });
    const { mode } = planModeOf(text);
    let result;
    try {
      result = validatePlan(text);
    } catch (err) {
      pushDedup(errors, { file: rel, severity: "critical", id: "validate_crash", message: `validatePlan 异常: ${err.message}`, suggestion: "检查 plan 文件编码是否为 UTF-8 文本" });
      continue;
    }
    // G1：legacy 同 file+id 去重升级（critical 优先，warning 去重）
    const upgraded = upgradeLegacyFindings(result, rel);
    for (const e of upgraded.errors) pushDedup(errors, e);
    for (const w of upgraded.warnings) pushDedup(warnings, w);
    // G1 补项（mode 非法 / seeds / cases / base_config / 按 mode 缺命令）
    for (const f of checkPlanContractHardening(text, projectDir)) {
      pushPlan(f.severity === "critical" ? errors : warnings, { ...f });
    }
    // G2 模板变量
    const tpl = checkTemplateVariables(text);
    for (const e of tpl.errors) pushPlan(errors, { ...e });
    for (const w of tpl.warnings) pushPlan(warnings, { ...w });
    // G3+G4 输出契约（run_wrapper 豁免 stdout/stderr：项目级 wrapper 或 plan 内显式 run_wrapper 均算覆盖；透传 projectWrapperOk 注明来源）
    const planHasRunWrapper = projectWrapper.ok || /run_wrapper(\.py)?/i.test(text) || /runWrapper\s*:/i.test(text);
    for (const f of checkOutputContract(text, mode, { hasRunWrapper: planHasRunWrapper, projectWrapperOk: projectWrapper.ok })) {
      pushPlan(f.severity === "critical" ? errors : f.severity === "info" ? infos : warnings, { ...f });
    }
    // W1 展示层折叠：同 plan 的 5 条 via_wrapper info（case_csv/stdout/stderr/env/config）折叠为 1 条
    // wrapper 汇总 info（判定条件不变：checkOutputContract 原样落桶，此处按同文件同 plan 折叠；findings 总数同步减少；
    // --quiet-wrapper 则连汇总一并抑制）。
    const WRAPPER_DETAIL_IDS = new Set([
      "output_contract_case_csv_via_wrapper",
      "output_contract_stdout_via_wrapper",
      "output_contract_stderr_via_wrapper",
      "output_contract_env_snapshot_via_wrapper",
      "output_contract_config_snapshot_via_wrapper",
    ]);
    const foldedWrapper = [];
    for (let i = infos.length - 1; i >= 0; i -= 1) {
      const fi = infos[i];
      if (fi && fi.file === rel && WRAPPER_DETAIL_IDS.has(fi.id)) {
        foldedWrapper.push(fi.id);
        infos.splice(i, 1);
      }
    }
    if (foldedWrapper.length > 0 && !args.quietWrapper) {
      const wnote = projectWrapper.ok ? "项目级 run_wrapper" : "plan 内 run_wrapper/runWrapper";
      const wcount = foldedWrapper.length;
      const wscope = foldedWrapper.includes("output_contract_case_csv_via_wrapper") ? "5项口径" : "4项口径";
      pushPlan(infos, {
        severity: "info",
        id: "output_contract_wrapper_summary",
        message: `run_wrapper 已覆盖 ${wcount} 项输出契约（${foldedWrapper.sort().join("、")}，已豁免，来源：${wnote}，明细已折叠，共${wcount}项/${wscope}；计入依据：同文件同plan折叠，wcount=foldedWrapper.length）`,
        suggestion: "wrapper 经 collect_outputs 自动采集/捕获，无需重复声明；如需消除此提醒可显式声明对应产物，或加 --quiet-wrapper 抑制本汇总（明细ID已豁免折叠：output_contract_case_csv_via_wrapper/output_contract_stdout_via_wrapper/output_contract_stderr_via_wrapper/output_contract_env_snapshot_via_wrapper/output_contract_config_snapshot_via_wrapper）；示例：node scripts/check-static.js --project <dir> --write-md --quiet-wrapper",
      });
    }
    // G10 分片大表错位（多分片 + paper 大表名不对齐 + test 缺分片接线 → warning）
    for (const f of checkShardedBigTable(text, mode)) {
      pushPlan(f.severity === "critical" ? errors : warnings, { ...f });
    }
    // final.yaml 聚合提示（paper final.csv vs 分片 image_only 不对齐 → info；warning 口径不变）
    for (const f of checkFinalCsvAggregation(text)) {
      pushPlan(infos, { ...f });
    }
    // 并发风险（G5 6 根禁写 + G8 job_name）
    for (const f of checkConcurrencyRisks(text, mode)) {
      pushPlan(f.severity === "critical" ? errors : warnings, { ...f });
    }
    // G5/G6 scp 禁令（单根：文件传输走 API，禁 scp/rsync）
    for (const f of checkScpForbidden(text, rel)) {
      pushDedup(errors, f);
    }
    // G7 绘图契约（无声明跳过；五文件存在 + 字段）
    for (const f of checkPlottingContract(text, projectDir, rel)) {
      pushDedup(f.severity === "critical" ? errors : warnings, f);
    }
    // 强契约基线：suite 为唯一必填顶层字段（PlanValidator.ts:57 正则基线 suite_missing=critical；
    // legacy 契约路径无 severity 字段会被降级为 warning，此处显式升级为 critical 并去重）。
    if (!/^\s*suite\s*:/m.test(stripYamlComments(text))) {
      const kept = [];
      for (const w of warnings) {
        if (w.file === rel && (w.id === "suite" || /套件名/.test(w.message))) continue;
        kept.push(w);
      }
      warnings.length = 0;
      warnings.push(...kept);
      pushPlan(errors, { severity: "critical", id: "suite_missing", message: "缺少 suite 字段", suggestion: "在 plan 顶层补充 suite，例如 suite: cls_smoke。" });
    }
    const iface = checkOutputInterface(text);
    if (!iface.ok) {
      const isTestPlan = /test_command\s*:|testCommandTemplate\s*:/i.test(text) || /^\s*mode\s*:\s*["']?(test|train_test|test_only)/im.test(text);
      if (!isTestPlan) {
        pushPlan(infos, { severity: "info", id: "output_interface_train_only", message: "train 任务未见显式输出接口，仅记录提示", suggestion: "train 阶段可不接 result_csv；如需统一采集可在命令中调用 collect_outputs/write_metrics_summary/write_standard_outputs" });
      } else if (!projectWrapper.ok) {
        pushPlan(errors, { severity: "critical", id: "output_interface_missing", message: "未验证的输出接口", suggestion: iface.fix });
      } else {
        wrapperCoveredCount += 1;
      }
    } else if (iface.note) {
      // tensorboard 降噪：仅 plan 含 SummaryWriter（大小写敏感精确）时落 infos，否则直接抑制不落桶；
      // simple_project_no_tensorboard 保持不动（缺声明仍 info）；severity 仍 info。
      if (text.includes("SummaryWriter")) {
        pushPlan(infos, { severity: "info", id: "output_interface_tensorboard", message: iface.note, suggestion: "在远端执行 pip show tensorboard 确认，或改用 run_wrapper 捕获；如需抑制此提醒，示例：node scripts/check-static.js --project <dir> --write-md --quiet-info" });
      }
    }
    const testCmdFinding = checkTestCommand(text);
    if (testCmdFinding) {
      pushPlan(testCmdFinding.severity === "critical" ? errors : testCmdFinding.severity === "info" ? infos : warnings, { ...testCmdFinding });
    }
    // D1 直接合并：同 plan 已报 test_command_via_injection 时，big_table_via_injection 直接 suppress
    // （判定条件不变：checkOutputContract 原样 warning 落桶，此处按同文件同 plan 直接丢弃，不落 infos；
    // 仅保留 test_command_via_injection 1 条；findings 总数同步减少）。
    if (testCmdFinding && testCmdFinding.id === "test_command_via_injection") {
      for (let i = warnings.length - 1; i >= 0; i -= 1) {
        const w = warnings[i];
        if (w && w.file === rel && w.id === "output_contract_big_table_via_injection") {
          warnings.splice(i, 1);
        }
      }
    }
    for (const f of checkPaths(extractRemotePathCandidates(text), projectLabel)) {
      pushPlan(f.severity === "critical" ? errors : warnings, { ...f });
    }
  }

  const adapterFile = path.join(projectDir, "experiments", "simple_project.yaml");
  if (fs.existsSync(adapterFile)) {
    const rel = normRel(projectDir, adapterFile);
    const text = fs.readFileSync(adapterFile, "utf8");
    for (const f of checkPaths(extractRemotePathCandidates(text), projectLabel)) {
      pushDedup(f.severity === "critical" ? errors : warnings, { file: rel, ...f });
    }
  }

  // G6 结果 Schema（项目级，有样例才验，无样例跳过）
  for (const f of checkResultSchema(projectDir)) {
    pushDedup(f.severity === "critical" ? errors : warnings, f);
  }

  const simpleProjectFindings = checkSimpleProject(projectDir);
  for (const e of simpleProjectFindings.errors || []) pushDedup(errors, e);
  for (const w of simpleProjectFindings.warnings) pushDedup(warnings, w);
  for (const i of simpleProjectFindings.infos) pushDedup(infos, i);
  // --quiet-info 展示层抑制（判定条件/severity/桶位不变；默认不抑制；quiet-wrapper 行为不变）：
  // 仅抑制 tensorboard 两项 info（simple_project_no_tensorboard/output_interface_tensorboard）与 version_undeclared info。
  if (args.quietInfo) {
    const QUIET_INFO_IDS = new Set([
      "simple_project_no_tensorboard",
      "output_interface_tensorboard",
      "simple_project_version_undeclared",
    ]);
    for (let i = infos.length - 1; i >= 0; i -= 1) {
      if (infos[i] && QUIET_INFO_IDS.has(infos[i].id)) infos.splice(i, 1);
    }
  }
  if (wrapperCoveredCount > 0 && projectWrapper.ok) {
    pushDedup(infos, { file: "(project)", severity: "info", id: "output_interface_project_wrapper", message: `${wrapperCoveredCount} 个 plan 内未见显式输出接口，但项目级 runWrapper 已存在（${projectWrapper.source}），视为通过`, suggestion: "如需消除此提醒，可在 plan 命令中显式使用 simple_adapter/run_wrapper 包裹，或调用 collect_outputs/write_metrics_summary/write_standard_outputs" });
  }

  const failed = errors.length > 0 || (args.failOnWarning && warnings.length > 0);
  const overall = failed ? "failed" : "passed";
  // MD/JSON 头：generatedAt（ISO）+ toolVersion（package.json version 单源）+ checkerSource
  // （本脚本相对路径单源 CHECKER_SOURCE）+ reportWritten（落盘后置 true）。
  // 120等11行语义找回：test_command 经 test.results_csv/paper.result_csv + expectedResults 大表
  // 注入时降 warning（test_command_via_injection，见 checkTestCommand:110-124），此处不截断该语义，
  // 报告头仅追加元信息，不改变 G1-G8 任一判定分支。
  let toolVersion = "0.0.0";
  try {
    toolVersion = String(require(path.join(ROOT, "package.json")).version || "0.0.0");
  } catch { /* 极端情况退化为 0.0.0，不阻断 */ }
  const report = {
    overall,
    project: projectDir,
    generatedAt: new Date().toISOString(),
    toolVersion,
    checkerSource: CHECKER_SOURCE,
    checkerSourceAbs: CHECKER_SOURCE_ABS,
    reportWritten: false,
    planFiles: planFiles.map((f) => normRel(projectDir, f)),
    summary: { errors: errors.length, warnings: warnings.length, infos: infos.length, plans: planFiles.length },
    errors,
    warnings,
    infos,
  };

  // MD 落盘：failed 必写，passed 仅 --write-md/--report-md 可选写。
  // 路径固定 projectDir/simple_cluster/check_reports/check-static-latest.md；
  // 该路径命中 EXCLUDE_REL_PREFIXES（simple_cluster/）属预期，不做排除前缀校验；
  // 仅做 .. 逃逸拒绝 + mkdir recursive。显式调用即确认覆盖（latest 语义），不静默跳过。
  const CHECK_STATIC_REPORT_REL = "simple_cluster/check_reports/check-static-latest.md";
  const CHECK_STATIC_REPORT_DIR_REL = "simple_cluster/check_reports";
  const resolveCheckStaticReportPath = (root, rel) => {
    const resolved = path.resolve(root, rel);
    const relative = path.relative(root, resolved);
    if (!rel || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`报告路径逃逸工程根，已拒绝：${rel}`);
    }
    // realpath 防 symlink 逃逸：取最近已存在祖先的真实路径回拼后二次校验
    try {
      const realRoot = fs.realpathSync(root);
      let cur = resolved;
      while (!fs.existsSync(cur)) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      const realCur = fs.realpathSync(cur);
      const realResolved = path.join(realCur, path.relative(cur, resolved));
      const realRelative = path.relative(realRoot, realResolved);
      if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw new Error(`报告路径经 symlink 逃逸工程根，已拒绝：${rel}`);
      }
    } catch (err) {
      if (/逃逸工程根/.test(err.message)) throw err;
      // 根不存在等极端情况：退化为词法校验（上文已做），不阻断
    }
    return resolved;
  };
  // O4 渲染归一：管道转义 + CRLF/换行折叠 + 连续空白折叠（单元格内多空格/tab 不再撑开表格）。
  const escCell = (v) => String(v == null ? "" : v).replace(/\r/g, "").replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/[ \t\u00a0]+/g, " ");
  // MD 明细用：finding 归一 id（path 类无 id 收敛为 path_invalid）+ 按 id 的源码定位 + 参考模板正例。
  // suggestion 禁空保留：缺失时回退统一文案（与 pushDedup 一致）。
  const MD_SUGGESTION_FALLBACK = "（暂无自动修复建议，需人工排查）";
  const refIdOf = (r) => r.id || (r.path ? "path_invalid" : "-");
  // ID_SRC 行号：静态表为兜底锚点（已重锚到本次实际行号），运行时由 resolveCheckStaticIdSrc
  // 动态提取优先（构造位 `id: "<id>"` > `=== "<id>"` 判定位 > 首个含引号 id 的行），
  // 兜底锚 CHECK_STATIC_ID_SRC_FALLBACK（落盘 writeFileSync 行，随源码移动重锚），未注册 id 直接抛错，禁止静默指向旧行号。
  const CHECK_STATIC_ID_SRC_FALLBACK = "scripts/check-static.js:1843";
  const CHECK_STATIC_ID_SRC = {
    test_command_via_injection: "scripts/check-static.js:149",
    test_command_missing_result_csv: "scripts/check-static.js:159",
    mode_invalid: "scripts/check-static.js:287",
    seeds_missing: "scripts/check-static.js:295",
    seeds_empty: "scripts/check-static.js:297",
    cases_missing: "scripts/check-static.js:302",
    cases_empty: "scripts/check-static.js:307",
    base_config_missing: "scripts/check-static.js:314",
    base_config_not_found: "scripts/check-static.js:321",
    train_command_missing: "scripts/check-static.js:328",
    test_command_missing: "scripts/check-static.js:331",
    template_unknown_variable: "scripts/check-static.js:377",
    template_train_writes_big_table: "scripts/check-static.js:386",
    output_contract_missing_summary_csv: "scripts/check-static.js:416",
    output_contract_missing_case_csv: "scripts/check-static.js:419",
    output_contract_case_csv_via_wrapper: "scripts/check-static.js:430",
    output_contract_missing_stdout_log: "scripts/check-static.js:425",
    output_contract_missing_stderr_log: "scripts/check-static.js:432",
    output_contract_stdout_via_wrapper: "scripts/check-static.js:423",
    output_contract_stderr_via_wrapper: "scripts/check-static.js:430",
    output_contract_missing_big_table: "scripts/check-static.js:442",
    output_contract_big_table_via_injection: "scripts/check-static.js:473",
    output_contract_wrapper_summary: "scripts/check-static.js:1177",
    sharded_big_table_mismatch: "scripts/check-static.js:548",
    final_csv_aggregation_hint: "scripts/check-static.js:569",
    output_contract_missing_env_snapshot: "scripts/check-static.js:447",
    output_contract_missing_config_snapshot: "scripts/check-static.js:450",
    output_contract_env_snapshot_via_wrapper: "scripts/check-static.js:449",
    output_contract_config_snapshot_via_wrapper: "scripts/check-static.js:457",
    output_contract_declaration_only: "scripts/check-static.js:457",
    concurrency_job_placeholder: "scripts/check-static.js:484",
    concurrency_same_file: "scripts/check-static.js:492",
    concurrency_job_name_missing: "scripts/check-static.js:498",
    concurrency_root_write: "scripts/check-static.js:510",
    concurrency_debug_isolation: "scripts/check-static.js:515",
    plan_scp_forbidden: "scripts/check-static.js:526",
    result_schema_case_missing_columns: "scripts/check-static.js:578",
    result_schema_case_bad_value: "scripts/check-static.js:587",
    result_schema_summary_missing_columns: "scripts/check-static.js:601",
    result_schema_summary_bad_value: "scripts/check-static.js:610",
    plotting_contract_missing_file: "scripts/check-static.js:696",
    plotting_contract_bad_fields: "scripts/check-static.js:705",
    simple_project_no_tensorboard: "scripts/check-static.js:821",
    simple_project_no_manifest: "scripts/check-static.js:779",
    simple_project_version_old: "scripts/check-static.js:789",
    simple_project_version_undeclared: "scripts/check-static.js:793",
    simple_project_simplesftp_version: "scripts/check-static.js:799",
    simple_project_scp_forbidden: "scripts/check-static.js:804",
    simple_project_agent_version_drift: "scripts/check-static.js:815",
    simple_project_runwrapper_missing: "scripts/check-static.js:825",
    simple_project_candidate_extension: "scripts/check-static.js:837",
    simple_project_metric_alias: "scripts/check-static.js:849",
    simple_project_entrypoint_unrenderable: "scripts/check-static.js:859",
    path_invalid: "scripts/check-static.js:917",
    no_plan_files: "scripts/check-static.js:952",
    validate_crash: "scripts/check-static.js:994",
    suite: "scripts/check-static.js:1031",
    suite_missing: "scripts/check-static.js:1036",
    output_interface_train_only: "scripts/check-static.js:1042",
    output_interface_missing: "scripts/check-static.js:1044",
    output_interface_tensorboard: "scripts/check-static.js:1106",
    output_interface_project_wrapper: "scripts/check-static.js:1147",
    mode: "scripts/check-static.js:219",
    seeds: "scripts/check-static.js:219",
    cases: "scripts/check-static.js:219",
    base_config: "scripts/check-static.js:220",
    train_command: "scripts/check-static.js:220",
    test_command: "scripts/check-static.js:220",
    result_output: "scripts/check-static.js:222",
  };
  // 注册表：静态表全量键即唯一可信源（66 项：59 检查位 + 7 legacy 裸 id 锚点）。
  const CHECK_STATIC_ID_REGISTRY = new Set(Object.keys(CHECK_STATIC_ID_SRC));
  let CHECK_STATIC_SELF_LINES = null; // 自身源码行缓存（动态提取每进程只读一次）
  function resolveCheckStaticIdSrc(refId) {
    if (!CHECK_STATIC_ID_REGISTRY.has(refId)) {
      if (refId === "-") return CHECK_STATIC_ID_SRC_FALLBACK;
      throw new Error(`[check-static] 未注册的 finding id: ${refId}（请同步 CHECK_STATIC_ID_SRC 与 refTemplateFor 后重跑）`);
    }
    try {
      if (!CHECK_STATIC_SELF_LINES) CHECK_STATIC_SELF_LINES = fs.readFileSync(__filename, "utf8").split(/\r?\n/);
      const quoted = `"${refId}"`;
      let idx = CHECK_STATIC_SELF_LINES.findIndex((l) => l.includes(`id: ${quoted}`) || l.includes(`id:${quoted}`));
      if (idx < 0) idx = CHECK_STATIC_SELF_LINES.findIndex((l) => l.includes(quoted) && l.includes("==="));
      if (idx < 0) idx = CHECK_STATIC_SELF_LINES.findIndex((l) => l.includes(quoted));
      if (idx >= 0) return `scripts/check-static.js:${idx + 1}`;
    } catch { /* 读自身源码失败时退到静态表 */ }
    return CHECK_STATIC_ID_SRC[refId] || CHECK_STATIC_ID_SRC_FALLBACK;
  }
  const GOOD_PLAN_REF = [
    "suite: demo",
    "mode: train_test",
    "base_config: configs/base.yaml",
    "seeds: [0]",
    "cases:",
    "  - name: smoke",
    "naming:",
    "  job_name: \"{index}_{case}_seed{seed}\"",
    "paper:",
    "  result_csv: \"{output_dir}/metrics_summary.csv\"",
    "runner:",
    "  train_command: \"python train.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}\"",
    "  test_command: \"python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}\"",
    "expectedResults:",
    "  - \"{output_dir}/metrics_summary.csv\"",
    "  - \"experiments/results/demo.csv\"",
  ];
  // 按 id 取参考模板源码块：validate_crash / no_plan_files / path_invalid 给正例，其余按类别给最小正例片段。
  const refTemplateFor = (refId) => {
    if (refId === "validate_crash") {
      return [
        "# 正例：UTF-8 纯文本 plan（validate_crash 要求文件可被正常解析，禁 BOM/二进制/非法编码）",
        "suite: demo",
        "mode: train_test",
        "base_config: configs/base.yaml",
        "seeds: [0]",
        "cases:",
        "  - name: smoke",
        "runner:",
        "  train_command: \"python train.py --config {config} --output-dir {output_dir}\"",
      ];
    }
    if (refId === "no_plan_files") {
      return [
        "# 正例：在目标项目下放置 plan 文件即可消除 no_plan_files 提醒",
        "# experiments/plans/plan.yaml",
        "suite: demo",
        "mode: train",
        "base_config: configs/base.yaml",
        "seeds: [0]",
        "cases:",
        "  - name: smoke",
        "runner:",
        "  train_command: \"python train.py --config {config} --output-dir {output_dir}\"",
      ];
    }
    if (refId === "path_invalid") {
      return [
        "# 正例：项目内相对路径（白名单根），禁绝对路径/C 盘符/.. 回跳/私钥文件",
        "paper:",
        "  result_csv: \"{output_dir}/metrics_summary.csv\"",
        "expectedResults:",
        "  - \"experiments/results/demo.csv\"",
        "log_file: \"simple_cluster/work_dirs/run.log\"",
      ];
    }
    // B3 独立模板：missing_case / tensorboard 各走独立正例（置于通用分支之前，禁止被通用收敛吞并）。
    if (refId === "output_contract_missing_case_csv") {
      return [
        "# 正例：per-job 双 csv 之 metrics_case.csv（missing_case 独立模板，key 行见 metrics_case）",
        "expectedResults:",
        "  - \"{output_dir}/metrics_case.csv\"",
        "paper:",
        "  result_csv: \"{output_dir}/metrics_summary.csv\"",
      ];
    }
    if (refId === "output_contract_case_csv_via_wrapper") {
      return [
        "# 正例：metrics_case.csv 经 run_wrapper 自动采集（case_csv_via_wrapper 独立模板，key 行见 metrics_case）",
        "expectedResults:",
        "  - \"{output_dir}/metrics_case.csv\"",
        "# 或依赖项目级 run_wrapper collect_outputs 自动采集 per-job 双 csv，无需重复声明",
      ];
    }
    if (refId === "test_command_via_injection") {
      return [
        "# 正例：test 缺 --result-csv 但经注入闭环（via_injection 独立模板，key 行见 test_command）",
        "paper:",
        "  result_csv: \"{output_dir}/metrics_summary.csv\"",
        "runner:",
        "  test_command: \"python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}\"",
        "expectedResults:",
        "  - \"experiments/results/demo.csv\"",
        "outputs:",
        "  candidateCsv:",
        "    - \"experiments/results/demo.csv\"",
      ];
    }
    if (refId === "output_contract_wrapper_summary") {
      return [
        "# 正例：run_wrapper 覆盖 4 项输出契约（wrapper_summary 独立模板·4项口径，明细已折叠为 1 条，共4项）",
        "runner:",
        "  train_command: \"python train.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}\"",
        "  test_command: \"python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}\"",
        "# 4项口径（成员式判定，以 message 为准）：output_contract_config_snapshot_via_wrapper/output_contract_stdout_via_wrapper/output_contract_stderr_via_wrapper/output_contract_env_snapshot_via_wrapper（config_snapshot.yaml/stdout.log/stderr.log/env_snapshot.json，不含 output_contract_case_csv_via_wrapper 时为 4 项）",
        "# 正例：run_wrapper 覆盖 5 项输出契约（wrapper_summary 独立模板·5项口径，明细已折叠为 1 条，共5项）",
        "runner:",
        "  train_command: \"python train.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}\"",
        "  test_command: \"python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}\"",
        "# 5项口径（成员式判定，以 message 为准）：4项 + output_contract_case_csv_via_wrapper（metrics_case.csv，含 output_contract_case_csv_via_wrapper 时为 5 项）",
        "# 项目级 experiments/simple_adapter/run_wrapper.py 存在时自动采集上述产物",
      ];
    }
    if (refId === "final_csv_aggregation_hint") {
      return [
        "# 正例：分片 image_only 经 final.yaml 聚合到 paper final.csv（final_csv_aggregation_hint 独立模板，info 聚合提示）",
        "paper:",
        "  result_csv: \"{output_dir}/final.csv\"",
        "expectedResults:",
        "  - \"{output_dir}/final.csv\"",
        "# final.yaml 聚合各分片 image_only 明细后汇总为 final.csv（statistics/plotting 聚合路径同轨豁免）",
      ];
    }
    if (refId === "sharded_big_table_mismatch") {
      return [
        "# 正例：多分片 case 经 --case/--seed 路由到大表（sharded_big_table_mismatch 独立模板）",
        "cases:",
        "  - name: smoke",
        "  - name: public",
        "runner:",
        "  test_command: \"python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}\"",
        "expectedResults:",
        "  - \"experiments/results/demo.csv\"",
      ];
    }
    if (refId === "output_contract_big_table_via_injection") {
      return [
        "# 正例：大表经注入/candidateCsv 降级（big_table_via_injection 独立模板，key 行见 experiments/results）",
        "paper:",
        "  result_csv: \"{output_dir}/metrics_summary.csv\"",
        "runner:",
        "  test_command: \"python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}\"",
        "expectedResults:",
        "  - \"experiments/results/demo.csv\"",
        "outputs:",
        "  candidateCsv:",
        "    - \"experiments/results/demo.csv\"",
      ];
    }
    if (refId === "simple_project_no_tensorboard" || refId === "output_interface_tensorboard") {
      return [
        "# 正例：TensorBoard 通道（tensorboard 独立模板，key 行见 tensorboardLogDirs/SummaryWriter）",
        "tensorboardLogDirs:",
        "  - \"{output_dir}/runs\"",
        "# 或入口代码使用 SummaryWriter 并在远端安装 tensorboard",
      ];
    }
    if (/^(mode_invalid|mode|seeds_missing|seeds_empty|seeds|cases_missing|cases_empty|cases|base_config_missing|base_config_not_found|base_config|config|train_command_missing|train_command|test_command_missing|test_command|result_output_missing|result_output|suite)/.test(refId)) {
      return [
        "suite: demo",
        "mode: train_test",
        "base_config: configs/base.yaml",
        "seeds: [0, 1]",
        "cases:",
        "  - name: smoke",
        "runner:",
        "  train_command: \"python train.py --config {config} --output-dir {output_dir}\"",
        "  test_command: \"python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}\"",
      ];
    }
    if (/^template_/.test(refId)) {
      return [
        "# 16 白名单变量 + test 可加 {checkpoint}；双分隔符放行；train 禁直写大表",
        "runner:",
        "  train_command: \"python train.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}\"",
        "  test_command: \"python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}\"",
      ];
    }
    if (/^(output_contract_|test_command_|output_interface_)/.test(refId)) {
      return [
        "paper:",
        "  result_csv: \"{output_dir}/metrics_summary.csv\"",
        "runner:",
        "  test_command: \"python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}\"",
        "expectedResults:",
        "  - \"{output_dir}/metrics_summary.csv\"",
        "  - \"experiments/results/demo.csv\"",
      ];
    }
    if (/^concurrency_/.test(refId)) {
      return [
        "naming:",
        "  sweep_dir: work_dirs/baseline",
        "  job_name: \"{index}_{case}_seed{seed}\"",
      ];
    }
    if (/scp_forbidden/.test(refId)) {
      return [
        "# 文件传输走 simple-local.simple-sftp API（>=0.2.4），禁 scp/rsync/临时 SSH",
        "runner:",
        "  train_command: \"python train.py --config {config} --output-dir {output_dir}\"",
      ];
    }
    if (/^result_schema_summary_/.test(refId)) {
      return [
        "experiment_id,suite,method,dataset,split,seed,metric,value",
        "E1,demo,svm,cls,train,0,acc,0.91",
      ];
    }
    if (/^result_schema_case_/.test(refId)) {
      return [
        "experiment_id,case_id,dataset,split,method",
        "E1,c1,cls,train,svm",
      ];
    }
    if (/^plotting_contract_/.test(refId)) {
      return [
        "# 按 docs/output-contract-for-plotting.md 落盘五文件",
        "outputs:",
        "  registry: \"simple_cluster/results/result_registry.json\"",
        "  stats: \"simple_cluster/results/statistics.json\"",
      ];
    }
    if (/^simple_project_/.test(refId)) {
      return [
        "projectName: demo",
        "version: 0.4.2",
        "outputs:",
        "  manifest: artifact_manifest.json",
      ];
    }
    if (refId === "-") return GOOD_PLAN_REF; // 无 id 无 path 的兜底形状（理论不可达），保留全量基线快照
    throw new Error(`[check-static] 参考模板未注册: ${refId}（请在 refTemplateFor 中为该 finding id 补充正例片段，禁止静默回退 GOOD_PLAN_REF）`);
  };
  // frontmatter 回读：首部 --- 块可 parse，计数以 report 对象为准（渲染层不重算口径）。
  const parseCheckStaticFrontmatter = (md) => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(md || ""));
    if (!m) return null;
    const get = (k) => {
      const r = new RegExp("^" + k + ":\\s*(.+?)\\s*$", "m").exec(m[1]);
      if (!r) return null;
      return String(r[1]).replace(/^"(.*)"$/, "$1");
    };
    const num = (k) => { const v = get(k); return v == null ? null : Number(v); };
    return { overall: get("overall"), errors: num("errors"), warnings: num("warnings"), infos: num("infos"), plans: num("plans"), generatedAt: get("generatedAt"), toolVersion: get("toolVersion"), checkerSource: get("checkerSource") };
  };
  const renderCheckStaticMarkdown = (rep) => {
    const lines = [];
    // 1. YAML frontmatter（--- 块，可经 parseCheckStaticFrontmatter 回读；计数以 rep 对象为准不变）。
    lines.push("---");
    lines.push(`overall: ${rep.overall}`);
    lines.push(`errors: ${rep.summary.errors}`);
    lines.push(`warnings: ${rep.summary.warnings}`);
    lines.push(`infos: ${rep.summary.infos}`);
    lines.push(`plans: ${rep.summary.plans}`);
    lines.push(`generatedAt: "${String(rep.generatedAt || "")}"`);
    lines.push(`toolVersion: "${String(rep.toolVersion || "")}"`);
    lines.push(`checkerSource: "${String(rep.checkerSource || CHECKER_SOURCE)}"`);
    lines.push("---");
    lines.push("");
    lines.push("# check-static 报告");
    lines.push("");
    lines.push(`- overall: ${rep.overall}`);
    lines.push(`- project: ${escCell(rep.project)}`);
    lines.push(`- generatedAt: ${escCell(rep.generatedAt || "")}`);
    lines.push(`- toolVersion: ${escCell(rep.toolVersion || "")}`);
    lines.push(`- checkerSource: ${escCell(rep.checkerSource || CHECKER_SOURCE)}`);
    lines.push(`- checkerSourceAbs: ${escCell(rep.checkerSourceAbs || CHECKER_SOURCE_ABS)}`);
    lines.push(`- reportWritten: ${rep.reportWritten === true ? "true" : "false"}`);
    lines.push(`- reportRel: ${escCell(CHECK_STATIC_REPORT_REL)}`);
    lines.push(`- reportDir: ${escCell(CHECK_STATIC_REPORT_DIR_REL)}`);
    lines.push("");
    lines.push("## summary");
    lines.push(`- summary: errors=${rep.summary.errors} warnings=${rep.summary.warnings} infos=${rep.summary.infos} plans=${rep.summary.plans}`);
    lines.push("");
    lines.push("## planFiles");
    if (!rep.planFiles.length) lines.push("- (none)");
    else for (const f of rep.planFiles) lines.push(`- ${escCell(f)}`);
    const normFileOf = (f) => String(f == null ? "" : f).replace(/\\/g, "/"); // 复用 normRel 归一语义（\→/）
    const oneLineFull = (v) => String(v == null ? "" : v).replace(/\r/g, "").replace(/\n/g, " "); // 全量单行化，禁截断
    // 豁免口径去重附录（呈现层短引用，JSON/byId/计数不变）：
    // A1=来源说明（已豁免+来源二分+projectWrapperOk），A2=计入依据（同文件同plan折叠+wcount口径），A3=明细ID清单（5 via_wrapper IDs）。
    const APPENDIX_A3_IDS = "output_contract_case_csv_via_wrapper/output_contract_stdout_via_wrapper/output_contract_stderr_via_wrapper/output_contract_env_snapshot_via_wrapper/output_contract_config_snapshot_via_wrapper";
    const shortAppendix = (s) => String(s == null ? "" : s)
      .replace(/（[^）]*?，已豁免，来源：[^）]*?，明细已折叠，共(\d+)项\/([^；）]+)；计入依据：[^）]*?）/g, "（共$1项/$2[附录A1][附录A2][附录A3]）")
      .replace(/（已豁免，来源：[^）]*?projectWrapperOk=(?:true|false)）/g, "（已豁免[附录A1]）")
      .replace(/（已豁免，详见 output_contract_wrapper_summary）/g, "（[附录A2]）")
      .replace(/（明细ID已豁免折叠：[^）]*?）/g, "（[附录A3]）")
      .replace(/output_contract_(?:case_csv|stdout|stderr|env_snapshot|config_snapshot)_via_wrapper(?:[、/]output_contract_(?:case_csv|stdout|stderr|env_snapshot|config_snapshot)_via_wrapper)+/g, "[附录A3]");
    const byFileId = (a, b) => {
      const fa = normFileOf(a.file); const fb = normFileOf(b.file);
      if (fa < fb) return -1; if (fa > fb) return 1;
      const ia = refIdOf(a); const ib = refIdOf(b);
      if (ia < ib) return -1; if (ia > ib) return 1;
      return 0;
    };
    const section = (title, rows) => {
      lines.push("");
      lines.push(`## ${title} (${rows.length})`);
      if (!rows.length) { lines.push("- (none)"); return; }
      lines.push("| file | severity | id | message | suggestion |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const r of [...rows].sort(byFileId)) {
        // 全桶不截断：message/suggestion 均 escCell 全量；豁免长串以附录短引用呈现（JSON 原文不变）。
        lines.push(`| ${escCell(normFileOf(r.file))} | ${escCell(r.severity)} | ${escCell(refIdOf(r))} | ${escCell(shortAppendix(r.message))} | ${escCell(shortAppendix(r.suggestion || MD_SUGGESTION_FALLBACK))} |`);
      }
    };
    section("errors", rep.errors);
    section("warnings", rep.warnings);
    section("infos", rep.infos);
    // 明细：每个 finding 恰一个 ### 块（块数 == finding 总数），含文件:行号映射 + 参考模板源码块。
    // 去重标记：全局首现全量、之后 [DUP]；同 file+id 首个 [NEW]、之后 [DUP]（标题标记口径不变）。
    // O4 渲染归一折叠：参考模板按 id 全局折叠（首个同 id 块全量并记录块序号+MD行号、之后单行引用指向首块），与 file 无关；
    // refTemplateFor 照常调用（G9 不编造：未注册 id 照抛错，禁止静默回退）。
    // diff 围栏已删除（非 unified 不可 apply，只留模板 yaml 围栏）；无行号 loc 写 bare file（省略#L0，- 行号:行保持省略）。
    const FENCE = String.fromCharCode(96, 96, 96);
    // 2. 明细按 file 分组 + severity 排序：桶序 errors>warnings>infos 不变，桶内按 file、id 排序。
    const errSorted = [...rep.errors].sort(byFileId);
    const warnSorted = [...rep.warnings].sort(byFileId);
    const infoSorted = [...rep.infos].sort(byFileId);
    const all = [
      ...errSorted.map((r) => ({ sec: "errors", r })),
      ...warnSorted.map((r) => ({ sec: "warnings", r })),
      ...infoSorted.map((r) => ({ sec: "infos", r })),
    ];
    const seenGlobal = new Set();
    const seenFileId = new Map();
    const seenIdTpl = new Map(); // 模板按 id 全局折叠：首个同 id 块全量并记块序号+MD行号、之后单行引用指向首块
    lines.push("");
    lines.push(`## findings明细 (${all.length})`);
    all.forEach((item, idx) => {
      const r = item.r;
      const refId = refIdOf(r);
      const file = normFileOf(r.file || "(none)");
      const key = `${file}::${r.severity}::${refId}::${String(r.message || "").slice(0, 120)}`;
      const isDup = seenGlobal.has(key);
      if (!isDup) seenGlobal.add(key);
      const fk = `${file}::${refId}`;
      const n = (seenFileId.get(fk) || 0) + 1;
      seenFileId.set(fk, n);
      const mark = isDup || n > 1 ? "[DUP]" : "[NEW]";
      const src = resolveCheckStaticIdSrc(refId);
      const sug = r.suggestion || MD_SUGGESTION_FALLBACK;
      const msgFull = oneLineFull(shortAppendix(r.message));
      const sugFull = oneLineFull(shortAppendix(sug));
      const loc = r.line != null ? `${file}#L${String(r.line)}` : file; // 无行号时 bare file 省略#L0（- 行号:行保持省略），loc 统一正斜杠经 normFileOf 归一
      lines.push("");
      lines.push(`### [${item.sec}][\`${refId}\`] ${loc} ${mark}`);
      const headingMdLine = lines.length; // 该块标题的 MD 行号（1-based，供 DUP 折叠引用）
      lines.push(`- 文件: ${escCell(file)}`);
      if (r.line != null) lines.push(`- 行号: ${escCell(String(r.line))}（plan 行锚，位置 ${escCell(loc)}）`);
      lines.push(`- 参考: ${escCell(src)}`);
      lines.push(`- message: ${msgFull}`);
      lines.push(`- suggestion: ${sugFull}`);
      if (isDup) lines.push("- 去重: [DUP] 与首现块同 finding，详见首个同 id 全量块。");
      // plotting 说明：绘图契约五文件（result_registry/statistics/paper_table/case_level/dataset_profile）
      // 共用同一 id（plotting_contract_missing_file），五缺项各为独立缺文件；
      // [DUP] 仅为同 id 去重标记，不代表重复计数，定位以各块 message 中的 key 为准。
      if (refId === "plotting_contract_missing_file") lines.push("- 说明: 绘图契约五文件共用同一 id，五缺项各为独立缺文件，[DUP] 仅为同 id 去重标记（key 见 message）。");
      lines.push(`#### 参考模板 (\`${refId}\`)`);
      lines.push(`${FENCE}yaml`);
      // O4 折叠 + G9 不编造：先照常取模板（未注册照抛错），同 id 首个块全量、之后折叠为指向首块块号+MD行号的单行引用。
      const tplLines = refTemplateFor(refId);
      if (seenIdTpl.has(refId)) {
        const first = seenIdTpl.get(refId);
        lines.push(`# [DUP] 模板已折叠，完整正例见第${first.blockNo}块（MD行L${first.mdLine}）：${refId}`);
      } else {
        seenIdTpl.set(refId, { blockNo: idx + 1, mdLine: headingMdLine });
        for (const t of tplLines) lines.push(t);
      }
      lines.push(FENCE);
    });
    lines.push("");
    // 4. 文末 json summary 机器块（human 看表 AI 读块；计数以 rep 对象为准，byId 按 refId 计数）。
    lines.push("## summary-json（机器可读）");
    lines.push(`${FENCE}json`);
    {
      const byId = {};
      for (const item of all) {
        const id = refIdOf(item.r);
        byId[id] = (byId[id] || 0) + 1;
      }
      const summaryJson = { overall: rep.overall, errors: rep.summary.errors, warnings: rep.summary.warnings, infos: rep.summary.infos, plans: rep.summary.plans, byId };
      for (const l of JSON.stringify(summaryJson, null, 2).split("\n")) lines.push(l);
    }
    lines.push(FENCE);
    lines.push("");
    // 附录（豁免口径去重展开，呈现层短引用展开；判定/severity/桶位/计数口径不变）。
    lines.push("## 附录（豁免口径，去重展开）");
    lines.push("- 附录A1（来源说明）：已豁免指经 run_wrapper 自动采集/捕获/产出、无需在 plan 内重复声明；来源二分为“项目级 run_wrapper”（experiments/simple_adapter/run_wrapper.py 存在，projectWrapperOk=true）与“plan 内 run_wrapper/runWrapper”（plan 文本显式引用，projectWrapperOk=false）；判定仍以 hasRunWrapper 为准（任一覆盖即豁免）。");
    lines.push("- 附录A2（计入依据）：同文件同 plan 的 via_wrapper info 折叠为 1 条 output_contract_wrapper_summary（findings 总数同步减少；--quiet-wrapper 则连汇总一并抑制）；wcount=foldedWrapper.length，含 output_contract_case_csv_via_wrapper 时为 5 项口径、否则为 4 项口径。");
    lines.push(`- 附录A3（明细ID清单）：${APPENDIX_A3_IDS}。`);
    lines.push("");
    // O4 渲染归一：CRLF 归一为 LF，连续空行折叠为单个空行。
    return lines.join("\n").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n");
  };
  let savedReportPath = "";
  if (failed || args.writeMd) {
    // MD 头 reportWritten 语义：落盘分支内先置 true 再渲染，MD 头与 JSON 终态一致；
    // 写失败时回退 false（此时多半无文件，JSON 仍如实为 false）。
    report.reportWritten = true;
    try {
      const reportPath = resolveCheckStaticReportPath(projectDir, CHECK_STATIC_REPORT_REL);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, renderCheckStaticMarkdown(report), "utf8");
      savedReportPath = reportPath;
      report.reportWritten = true;
    } catch (err) {
      report.reportWritten = false;
      console.error(`[check-static] report write failed: ${err.message}`);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const problemFiles = new Set([...errors.map((e) => e.file), ...warnings.map((w) => w.file)]);
    console.log(`[check-static] project=${projectDir}`);
    console.log(`[check-static] plans=${planFiles.length} errors=${errors.length} warnings=${warnings.length} infos=${infos.length}`);
    for (const f of planFiles) {
      const rel = normRel(projectDir, f);
      if (!problemFiles.has(rel)) continue;
      console.log(`  plan: ${rel}`);
    }
    for (const e of errors) {
      console.log(`  ERROR ${e.file} [${e.id || e.path}] ${e.message}`);
      if (e.suggestion) console.log(`    fix: ${e.suggestion}`);
    }
    for (const w of warnings) {
      console.log(`  WARN ${w.file} [${w.id || w.path}] ${w.message}`);
      if (w.suggestion) console.log(`    fix: ${w.suggestion}`);
    }
    for (const i of infos) {
      console.log(`  INFO ${i.file} [${i.id || i.path || "-"}] ${i.message}`);
      if (i.suggestion) console.log(`    fix: ${i.suggestion}`);
    }
    console.log(`[check-static] overall=${overall}`);
  }
  if (savedReportPath) {
    // --json 时 stdout 必须保持纯 JSON（单测 JSON.parse），落盘提示走 stderr。
    const msg = `[check-static] saved ${path.relative(projectDir, savedReportPath)}`;
    if (args.json) console.error(msg);
    else console.log(msg);
  }
  process.exitCode = failed ? 1 : 0;
}

main();
