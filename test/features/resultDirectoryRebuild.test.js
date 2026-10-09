const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { replaceResultDirectory } = require("../../dist/results/ResultDirectoryRebuild.js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-result-directory-"));
  const resultDir = "experiments/results";
  const stagedDir = "simple_cluster/downloads/result_rebuild/batch";
  const old = path.join(root, resultDir, "final/final.csv");
  const fresh = path.join(root, stagedDir, "dataset/final/final.csv");
  for (const full of [old, fresh]) fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(old, "old mixed table", "utf8");
  fs.writeFileSync(fresh, "new dataset table", "utf8");
  return { root, resultDir, stagedDir, batchId: "batch", old, fresh };
}

test("replacement keeps old bytes and fills only the fresh dataset structure", async () => {
  const opts = fixture();
  const result = await replaceResultDirectory(opts);
  assert.equal(fs.existsSync(opts.old), false);
  assert.equal(fs.readFileSync(path.join(result.backup, "final/final.csv"), "utf8"), "old mixed table");
  assert.equal(fs.readFileSync(path.join(result.source, "dataset/final/final.csv"), "utf8"), "new dataset table");
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.root, "clean_dir/MANIFEST.md"), "utf8").trim());
  assert.equal(manifest.source, result.source);
  assert.equal(manifest.destination, result.backup);
  assert.ok(manifest.inventory.some(row => row.type === "file" && row.sha256.length === 64));
});

test("an existing backup is retained in superseded topology with explicit authorization", async () => {
  const opts = fixture();
  const previous = path.join(opts.root, "clean_dir", opts.resultDir, "previous.csv");
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  fs.writeFileSync(previous, "previous backup", "utf8");
  await assert.rejects(replaceResultDirectory(opts), /备份目标已存在/);
  assert.equal(fs.readFileSync(opts.old, "utf8"), "old mixed table");
  const result = await replaceResultDirectory({ ...opts, allowSuperseded: true });
  assert.equal(fs.readFileSync(path.join(result.superseded, "previous.csv"), "utf8"), "previous backup");
  assert.equal(fs.readFileSync(path.join(result.backup, "final/final.csv"), "utf8"), "old mixed table");
});

test("failed publication restores the original directory without deleting anything", async () => {
  const opts = fixture();
  const rename = fsp.rename;
  fsp.rename = async (from, to) => {
    if (from === path.join(opts.root, opts.stagedDir)) throw new Error("injected publish failure");
    return rename(from, to);
  };
  try { await assert.rejects(replaceResultDirectory(opts), /injected publish failure/); }
  finally { fsp.rename = rename; }
  assert.equal(fs.readFileSync(opts.old, "utf8"), "old mixed table");
  assert.equal(fs.readFileSync(opts.fresh, "utf8"), "new dataset table");
});

test("symlinks, missing final, dirty tracked files and changed workspace stop before moving", async () => {
  const linked = fixture();
  fs.symlinkSync(path.dirname(linked.fresh), path.join(linked.root, linked.resultDir, "link"), "junction");
  await assert.rejects(replaceResultDirectory(linked), /链接/);
  const noFinal = fixture();
  fs.renameSync(noFinal.fresh, noFinal.fresh + ".renamed");
  await assert.rejects(replaceResultDirectory(noFinal), /没有数据集总表/);
  const dirty = fixture();
  await assert.rejects(replaceResultDirectory({ ...dirty, gitStatus: " M experiments/results/final/final.csv" }), /未提交/);
  await assert.rejects(replaceResultDirectory({ ...dirty, isCurrent: () => false }), /工作区已切换/);
  for (const opts of [linked, noFinal, dirty]) assert.equal(fs.readFileSync(opts.old, "utf8"), "old mixed table");
});

test("protected paths and stage overlap never become cleanup scopes", async () => {
  const opts = fixture();
  await assert.rejects(replaceResultDirectory({ ...opts, resultDir: "experiments" }), /受保护/);
  await assert.rejects(replaceResultDirectory({ ...opts, stagedDir: opts.resultDir + "/stage" }), /重叠/);
  fs.mkdirSync(path.join(opts.root, opts.resultDir, ".git"));
  await assert.rejects(replaceResultDirectory(opts), /受保护/);
  assert.equal(fs.readFileSync(opts.old, "utf8"), "old mixed table");
});

test("a workspace switch during the move restores the captured original directory", async () => {
  const opts = fixture();
  const rename = fsp.rename;
  let current = true;
  fsp.rename = async (from, to) => {
    await rename(from, to);
    if (from === path.join(opts.root, opts.resultDir)) current = false;
  };
  try { await assert.rejects(replaceResultDirectory({ ...opts, isCurrent: () => current }), /工作区已切换/); }
  finally { fsp.rename = rename; }
  assert.equal(fs.readFileSync(opts.old, "utf8"), "old mixed table");
});
