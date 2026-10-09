#!/usr/bin/env node
/**
 * check-tmux-guard — TMUX 围栏违规检测
 * 等价于 package.json 中 powershell 巡检：
 *   Select-String -Path 'src/**\/*.ts' -Pattern 'ssh\.exe.*".*&&|ssh\.exe.*"cd |ssh .* "conda activate'
 *   | Where-Object { $_.Path -notmatch 'docs|\.legacy' }
 * 违规判定：src/** 下（排除 docs 与 .legacy）出现裸 ssh "command &&" / "cd / conda activate 直连
 * 合法通道：仅允许经 src/tunnel/TmuxRemoteExecutor.ts 的 tmux load-buffer/paste-buffer 围栏
 */
const fs = require("fs");
const path = require("path");

const SRC_ROOT = path.join(__dirname, "..", "src");
const PATTERN = /ssh\.exe.*".*&&|ssh\.exe.*"cd |ssh .* "conda activate/;
const EXCLUDE = /(docs|\.legacy)/;

function collectFiles(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) collectFiles(p, out);
    else if (ent.isFile() && p.endsWith(".ts")) out.push(p);
  }
}

const files = [];
collectFiles(SRC_ROOT, files);

const hits = [];
for (const file of files) {
  if (EXCLUDE.test(file)) continue;
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (PATTERN.test(line)) {
      // 额外过滤：TmuxRemoteExecutor.ts 本身的围栏实现是合法的（load-buffer/paste-buffer），不计为违规
      // 该文件仅通过 ssh.exe 传输 tmux 围栏指令，不含 && / cd / conda activate 裸拼接，已被 PATTERN 自然排除
      hits.push({ file: path.relative(path.join(__dirname, ".."), file), line: idx + 1, text: line.trim() });
    }
  });
}

if (hits.length) {
  console.error("TMUX 围栏违规 — 以下文件命中裸 ssh 直连模式：");
  for (const h of hits) console.error(`  ${h.file}:${h.line}: ${h.text}`);
  console.error(`\n共 ${hits.length} 处违规，请改为经 TmuxRemoteExecutor 走 tmux load-buffer/paste-buffer 围栏`);
  process.exit(1);
} else {
  console.log("TMUX guard pass");
}
