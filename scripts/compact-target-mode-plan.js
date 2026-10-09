const fs = require("fs");
const path = require("path");

const DEFAULT_PATH = path.join("docs", "target-mode-plan.md");
const MAX_LINES = 80;
const MAX_SECTION_BULLETS = 8;
const MAX_BATCH_RECORD_BULLETS = 4;
const MAX_SUBSECTION_BULLETS = 8;

function normalizeNewlines(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitSections(text) {
  const lines = normalizeNewlines(text).split("\n");
  const sections = [];
  let current = { title: "", level: 0, lines: [] };
  for (const line of lines) {
    const match = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current.lines.length || current.title) sections.push(current);
      current = { title: match[2].trim(), level: match[1].length, lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length || current.title) sections.push(current);
  return sections;
}

function sectionKind(title) {
  const value = String(title || "");
  if (!value) return "preamble";
  if (/^目标模式当前计划/.test(value) || value.startsWith("目标模式")) return "title";
  if (value === "固定边界" || value === "范围与保护") return "fixed";
  if (value === "后续优先级" || value === "当前状态") return "priority";
  if (/^当前批次/.test(value) || value === "当前目标") return "current";
  if (value === "本批记录" || value === "批次完成条件") return "record";
  if (/历史|已完成|流水|归档|验证日志|旧批次|过往/.test(value)) return "history";
  return "other";
}

function trimBullets(lines, maxBullets) {
  const output = [];
  let bullets = 0;
  for (const line of lines) {
    if (/^\s*-\s+/.test(line) && ++bullets > maxBullets) continue;
    output.push(line);
  }
  return output;
}

function trimBulletsPerSubsection(lines, maxBullets) {
  const output = [];
  let bullets = 0;
  for (const line of lines) {
    if (/^###\s+/.test(line)) bullets = 0;
    if (/^\s*-\s+/.test(line) && ++bullets > maxBullets) continue;
    output.push(line);
  }
  return output;
}

function compactSection(section) {
  const kind = sectionKind(section.title);
  if (kind === "history" || kind === "other") return null;
  const lines = [...section.lines];
  if (!lines.length) return null;
  const head = lines[0];
  let body = lines.slice(1);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  while (body.length && !body[0].trim()) body.shift();
  if (kind === "fixed" || kind === "priority") body = trimBullets(body, MAX_SECTION_BULLETS);
  if (kind === "record") body = trimBullets(body, MAX_BATCH_RECORD_BULLETS);
    if (kind === "current") {
      const kept = [];
      let skip = false;
      for (const line of body) {
        if (/^###\s+/.test(line)) {
          const subsection = line.replace(/^###\s+/, "").trim();
          skip = !/^(修复点|(?:相邻)?回归风险|验证清单|边界)$/.test(subsection) && !/^project-\d+\s+记录$/.test(subsection);
          if (skip) continue;
        }
        if (!skip) kept.push(line);
      }
      body = trimBulletsPerSubsection(kept, MAX_SUBSECTION_BULLETS);
  }
  return [head, ...body].join("\n").trimEnd();
}

function ensureSkeleton(versionHint) {
  return [
    "# 目标模式当前计划：待刷新",
    "",
    "本文档只保留最新活动目标。历史批次、验证和部署记录以 git 提交为准。",
    "打包/清理时会自动压缩本文件，禁止堆积流水账。",
    "",
    "## 固定边界",
    "",
    "- 以 `README.md` 为最高优先级；用户可见文案中文优先。",
    "- 不迁移、删除或重写旧任务、结果和安装产物。",
    "",
    "## 后续优先级",
    "",
    "- 待填写。",
    "",
    "## 当前批次：待刷新",
    "",
    "### 修复点",
    "",
    "- 待填写。",
    "",
    "### 验证清单",
    "",
    "- `npm run build`",
    "",
    "## 本批记录",
    "",
    versionHint ? `- 目标版本：\`${versionHint}\`。` : "- 目标版本：待定。",
    "",
  ].join("\n");
}

function compactTargetModePlan(text, options = {}) {
  const maxLines = Number(options.maxLines || MAX_LINES);
  const source = normalizeNewlines(text).trim();
  if (!source) return { text: ensureSkeleton(options.versionHint), changed: true, reason: "empty" };
  const sections = splitSections(source);
  const title = sections.find((section) => sectionKind(section.title) === "title") || sections[0];
  const kept = [];
  let titleBlock = compactSection(title || { title: "目标模式当前计划", lines: ["# 目标模式当前计划"] }) || "# 目标模式当前计划";
  if (!/只保留最新活动目标/.test(titleBlock)) titleBlock += "\n\n本文档只保留最新活动目标。历史批次、验证和部署记录以 git 提交为准。";
  if (!/自动压缩本文件|禁止堆积流水账/.test(titleBlock)) titleBlock += "\n打包/清理时会自动压缩本文件，禁止堆积流水账。";
  kept.push(titleBlock);
  for (const section of sections) {
    const kind = sectionKind(section.title);
    if (kind === "title" || kind === "preamble") continue;
    const compacted = compactSection(section);
    if (compacted) kept.push(compacted);
  }
  const kinds = new Set(kept.map((block) => sectionKind((/^(#{1,2})\s+(.+)$/m.exec(block) || [])[2] || "")));
  if (!kinds.has("fixed") || !kinds.has("priority") || !kinds.has("current") || !kinds.has("record")) {
    return { text: ensureSkeleton(options.versionHint), changed: true, reason: "missing-required" };
  }
  let output = `${kept.join("\n\n").trim()}\n`;
  let lines = output.split("\n");
  if (lines.length > maxLines) output = `${lines.slice(0, maxLines).join("\n").replace(/\n+$/, "")}\n`;
  const normalizedSource = `${normalizeNewlines(text).replace(/\s+$/g, "")}\n`;
  return { text: output, changed: normalizedSource !== output, reason: normalizedSource !== output ? "compacted" : "already-compact", lineCount: output.split("\n").length };
}

function readPackageVersion(rootDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
}

function compactTargetModePlanFile(options = {}) {
  const root = path.resolve(options.rootDir || process.cwd());
  const filePath = path.resolve(root, options.filePath || DEFAULT_PATH);
  const dryRun = Boolean(options.dryRun);
  if (!fs.existsSync(filePath)) {
    return { root, filePath, dryRun, changed: false, reason: "missing-local-development-document", lineCount: 0 };
  }
  const original = fs.readFileSync(filePath, "utf8");
  // The Mac persistent plan has a character budget. Below its threshold,
  // preserve all statuses and commit evidence verbatim.
  const characterCap = /字符上限\s+(\d+)/.exec(original);
  if (characterCap && original.length < Number(characterCap[1]) * 0.9) {
    return { root, filePath, dryRun, changed: false, reason: "below-character-threshold", lineCount: original.split("\n").length };
  }
  const result = compactTargetModePlan(original, { maxLines: options.maxLines, versionHint: options.versionHint || readPackageVersion(root) });
  if (characterCap && result.text.length >= Number(characterCap[1])) {
    throw new Error("Persistent plan still exceeds character cap; preserve the source and condense completed history before continuing.");
  }
  if (result.changed && !dryRun) fs.writeFileSync(filePath, result.text, "utf8");
  return { root, filePath, dryRun, changed: result.changed, reason: result.reason, lineCount: result.lineCount || result.text.split("\n").length };
}

function parseArgs(argv) {
  const args = { dryRun: false, rootDir: process.cwd(), filePath: DEFAULT_PATH, maxLines: MAX_LINES };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--root") args.rootDir = argv[++index];
    else if (arg === "--file") args.filePath = argv[++index];
    else if (arg === "--max-lines") args.maxLines = Number(argv[++index] || MAX_LINES);
  }
  return args;
}

if (require.main === module) {
  const result = compactTargetModePlanFile(parseArgs(process.argv.slice(2)));
  const mode = result.dryRun ? "would compact" : result.changed ? "compacted" : "unchanged";
  console.log(`[target-mode-plan] ${mode} (${result.reason || "ok"}), lines=${result.lineCount}`);
  console.log(result.filePath);
}

module.exports = { DEFAULT_PATH, MAX_LINES, compactTargetModePlan, compactTargetModePlanFile, ensureSkeleton, sectionKind, splitSections };
