const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { advancePreviewIndex, assertIndexCheckout, publishPreviewIndex } = require("../../scripts/mac-preview-index");
function release(version = "0.5.307") {
  const tag = `preview-v${version}`, prefix = `https://github.com/zlinkw/SimpleExperiment-Mac/releases/download/${tag}/`;
  const expected = ["release.json", "simple-sftp-mac-0.2.97-darwin-arm64.vsix", `simple-experiment-mac-${version}-darwin-arm64.vsix`].map((name, i) => ({ name, size: 100 + i, sha256: "a".repeat(64) }));
  return { expected, published: { tag_name: tag, draft: false, prerelease: true, published_at: "2026-10-10T06:00:00Z",
    assets: expected.map(a => ({ ...a, state: "uploaded", digest: "sha256:" + a.sha256, browser_download_url: prefix + a.name })) } };
}
test("only complete public previews advance the static channel; repeat is immutable and history remains", () => {
  const older = release("0.5.306"), current = release();
  const previous = JSON.parse(advancePreviewIndex(undefined, older.published, older.expected));
  const bytes = advancePreviewIndex(previous, current.published, current.expected), next = JSON.parse(bytes);
  assert.deepEqual(next.releases.map(r => r.tag_name), ["preview-v0.5.307", "preview-v0.5.306"]);
  assert.deepEqual(advancePreviewIndex(next, current.published, current.expected), bytes);
  for (const broken of [{ ...current.published, draft: true }, { ...current.published, prerelease: false }, { ...current.published, assets: current.published.assets.slice(1) }])
    assert.throws(() => advancePreviewIndex(previous, broken, current.expected));
  assert.throws(() => advancePreviewIndex(next, release("0.5.305").published, release("0.5.305").expected), /backwards/);
  const changed = structuredClone(current); changed.expected[0].size++; changed.published.assets[0].size++;
  assert.throws(() => advancePreviewIndex(next, changed.published, changed.expected), /overwrite/);
});
function checkout(options = {}) {
  const root = path.resolve(__dirname, "../../release-artifacts", "index-git-tests", crypto.randomUUID()); fs.mkdirSync(root, { recursive: true });
  const source = "a".repeat(40), indexCommit = "b".repeat(40), calls = [];
  let head = source, upstream = source, committedBytes, staged = false, attempts = 0;
  const file = path.join(root, "preview.json"), journal = { status: "published" }, saves = [];
  const command = (name, args) => {
    assert.equal(name, "git"); calls.push(args.join(" "));
    if (args[0] === "branch") return "master";
    if (args[0] === "remote") return "https://github.com/zlinkw/SimpleExperiment-Mac.git";
    if (args[0] === "status") {
      if (options.unrelated) return " M README.md";
      return fs.existsSync(file) && (!committedBytes || !fs.readFileSync(file).equals(committedBytes)) ? staged ? "A  preview.json" : "?? preview.json" : "";
    }
    if (args[0] === "rev-parse") {
      if (args.includes("--abbrev-ref")) return "origin/master";
      return args[1] === "HEAD^" ? source : args[1] === "origin/master" ? upstream : head;
    }
    if (args[0] === "fetch") { if (options.remoteAdvanced) upstream = "c".repeat(40); return ""; }
    if (args[0] === "diff") return args.includes("--check") ? "" : args.includes("--cached") && !staged ? "" : "preview.json";
    if (args[0] === "add") { staged = true; return ""; }
    if (args[0] === "commit") { assert.ok(staged); head = indexCommit; committedBytes = fs.readFileSync(file); staged = false; return ""; }
    if (args[0] === "show") return committedBytes.toString("utf8").trim();
    if (args[0] === "push") { attempts++; if (options.failFirstPush && attempts === 1) throw Error("push offline"); upstream = head; return ""; }
    throw Error("Unexpected git invocation " + args.join(" "));
  };
  return { root, source, indexCommit, calls, journal, command, save: () => saves.push(structuredClone(journal)), saves };
}
test("index publication stages one file and ordinary pushes; a failed push resumes its owned commit", () => {
  const f = checkout({ failFirstPush: true }), r = release();
  assert.throws(() => publishPreviewIndex(r.published, r.expected, f.source, f.journal, f.save, f.command, f.root), /offline/);
  assert.equal(f.journal.indexCommit, f.indexCommit); assert.equal(f.journal.indexStatus, "committed");
  publishPreviewIndex(r.published, r.expected, f.source, f.journal, f.save, f.command, f.root);
  assert.equal(f.journal.indexStatus, "published");
  assert.equal(f.calls.filter(c => c.startsWith("commit ")).length, 1);
  assert.equal(f.calls.filter(c => c === "push origin master").length, 2);
  assert.equal(f.calls.some(c => /force|reset|merge|rebase/.test(c)), false);
  assert.ok(f.saves[0].indexHash);
});
test("unrelated local changes and advanced remote stop before index write or push", () => {
  const r = release();
  for (const options of [{ unrelated: true }, { remoteAdvanced: true }]) {
    const f = checkout(options);
    assert.throws(() => publishPreviewIndex(r.published, r.expected, f.source, f.journal, f.save, f.command, f.root), /unrelated|advanced|differs/);
    assert.equal(fs.existsSync(path.join(f.root, "preview.json")), false);
    assert.equal(f.calls.some(c => c.startsWith("push ")), false);
  }
});
test("a crash after index commit but before journal update recovers exactly that commit", () => {
  const f = checkout(), r = release(); let saved, count = 0;
  const save = () => { if (++count === 2) throw Error("journal write interrupted"); saved = structuredClone(f.journal); };
  assert.throws(() => publishPreviewIndex(r.published, r.expected, f.source, f.journal, save, f.command, f.root), /interrupted/);
  assert.equal(saved.indexCommit, undefined); assert.ok(saved.indexHash);
  publishPreviewIndex(r.published, r.expected, f.source, saved, () => {}, f.command, f.root);
  assert.equal(saved.indexCommit, f.indexCommit); assert.equal(saved.indexStatus, "published");
  assert.equal(f.calls.filter(c => c.startsWith("commit ")).length, 1);
});
test("a changed index after a journalled failure cannot resume or publish", () => {
  const f = checkout({ failFirstPush: true }), r = release();
  assert.throws(() => publishPreviewIndex(r.published, r.expected, f.source, f.journal, f.save, f.command, f.root));
  fs.appendFileSync(path.join(f.root, "preview.json"), " ", "utf8");
  assert.throws(() => assertIndexCheckout(f.source, f.journal, f.command, f.root), /unrelated/);
});
test("the release publisher advertises index only after verified public attachment confirmation", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../scripts/mac-release-publish.js"), "utf8");
  const normal = source.slice(source.indexOf('const published = JSON.parse'));
  assert.ok(normal.indexOf("verifyRemoteAssets(expected, published.assets)") < normal.indexOf("publishPreviewIndex(published"));
  const resume = source.slice(source.indexOf("if (existing && !existing.draft)"), source.indexOf("let draft;"));
  assert.ok(resume.indexOf("verifyRemoteAssets(expected, existing.assets)") < resume.indexOf("publishPreviewIndex(existing"));
});
