"use strict";
/**
 * 发行包内容策略分类器（JS 端，规则数据单源：scripts/package-content-policy.json）。
 * Python 端 scripts/package_content_policy.py 加载同一 JSON；两端行为由
 * test/features/packageContentPolicy.test.js 的通过/拒绝矩阵强制等价。
 * 诊断只输出 路径<category:类别>，绝不输出文件内容。
 */
const fs = require("node:fs");
const path = require("node:path");

const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, "package-content-policy.json"), "utf8"));

function normalizePath(p) {
  let s = String(p || "").trim().replace(/\\/g, "/").toLowerCase();
  for (;;) {
    if (s.startsWith("./")) s = s.slice(2);
    else if (s.startsWith("extension/")) s = s.slice("extension/".length);
    else break;
  }
  return s.replace(/\/+$/, "");
}

function basenameOf(norm) {
  const i = norm.lastIndexOf("/");
  return i < 0 ? norm : norm.slice(i + 1);
}

function classify(pathLike) {
  const norm = normalizePath(pathLike);
  if (!norm) return undefined;
  const base = basenameOf(norm);
  const atRoot = !norm.includes("/");
  if (atRoot && POLICY.legal_root_basenames.includes(base)) return undefined;
  if (atRoot && POLICY.toolchain_readme_exception.root_basenames.includes(base)) return undefined;
  const docMarkdownSkipped = new Set();
  if (POLICY.markdown_runtime_allow_files.includes(norm)) docMarkdownSkipped.add(".md");
  for (const rule of POLICY.forbidden_ordered) {
    if (rule.paths && rule.paths.some(candidate => norm === normalizePath(candidate))) return rule.category;
    if (rule.basename_contains && base.includes(rule.basename_contains)) return rule.category;
    if (rule.path_segments && rule.path_segments.some(seg => norm.split("/").includes(seg))) return rule.category;
    if (rule.suffixes && rule.suffixes.some(suffix => base.endsWith(suffix))) return rule.category;
    if (rule.basenames && rule.basenames.includes(base)) return rule.category;
    if (rule.path_prefixes && rule.path_prefixes.some(prefix => norm.startsWith(prefix))) return rule.category;
    if (rule.basename_prefixes && rule.basename_prefixes.some(prefix => base.startsWith(prefix))) return rule.category;
    if (rule.extension && base.endsWith(rule.extension)) {
      if (docMarkdownSkipped.has(rule.extension)) continue;
      return rule.category;
    }
  }
  return undefined;
}

function checkListing(entries) {
  const violations = [];
  const seen = new Set();
  for (const entry of entries) {
    const norm = normalizePath(entry);
    if (!norm) continue;
    seen.add(norm);
    const category = classify(norm);
    if (category) violations.push(`${norm} <category:${category}>`);
  }
  for (const required of POLICY.required) {
    const norm = normalizePath(required);
    if (!seen.has(norm)) violations.push(`missing required ${norm}`);
  }
  const readmeKept = POLICY.toolchain_readme_exception.root_basenames.some(name => seen.has(name));
  if (!readmeKept) violations.push("missing toolchain-exception root readme.md (vsce-enforced)");
  return violations;
}

module.exports = { POLICY, normalizePath, classify, checkListing, REQUIRED: POLICY.required.map(p => normalizePath(p)) };
