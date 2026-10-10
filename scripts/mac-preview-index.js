"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { EXPERIMENT_ROOT, REPOSITORY, run, verifyRemoteAssets } = require("./mac-release-common");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function advancePreviewIndex(previous, published, expected) {
  const { parsePreviewIndex } = require("../dist/mac/PreviewRelease");
  if (published.draft !== false || published.prerelease !== true || !published.published_at) throw new Error("Only confirmed public previews may enter the index");
  verifyRemoteAssets(expected, published.assets);
  const entry = { tag_name: published.tag_name, prerelease: true, draft: false, published_at: published.published_at,
    assets: published.assets.map(({ name, browser_download_url, size, digest }) => ({ name, browser_download_url, size, digest })).sort((a, b) => a.name.localeCompare(b.name)) };
  const old = previous ? parsePreviewIndex(previous) : [];
  if (previous && old.length !== previous.releases.length) throw new Error("Existing preview index contains invalid entries");
  const same = old.find(item => item.tag_name === entry.tag_name);
  if (same && JSON.stringify(same) !== JSON.stringify(entry)) throw new Error("Never overwrite an indexed release version");
  if (!same) {
    const semver = require("semver"), version = entry.tag_name.slice("preview-v".length);
    if (old.some(item => semver.compare(version, item.tag_name.slice("preview-v".length)) <= 0)) throw new Error("Preview index cannot move backwards");
  }
  const next = { protocolVersion: 1, channel: "preview", updatedAt: same ? previous.updatedAt : published.published_at, releases: same ? old : [entry, ...old] };
  if (parsePreviewIndex(next).length !== next.releases.length) throw new Error("Published preview metadata is invalid");
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8");
  if (bytes.length > 4 * 1024 * 1024) throw new Error("Preview index exceeds client size limit");
  return bytes;
}

// Recovery permits only this publisher's one index commit or exact journalled
// index bytes. Other changes/remote advances stop without merge or rebase.
function assertIndexCheckout(sourceCommit, journal, command = run, root = EXPERIMENT_ROOT) {
  const git = args => command("git", args, root);
  if (git(["branch", "--show-current"]) !== "master" || git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) !== "origin/master"
    || ![`https://github.com/${REPOSITORY}.git`, `https://github.com/${REPOSITORY}`, `git@github.com:${REPOSITORY}.git`].includes(git(["remote", "get-url", "origin"]))) throw new Error("Unexpected preview index checkout");
  const status = git(["status", "--porcelain"]), file = path.join(root, "preview.json");
  if (status && (!journal.indexHash || !["?? preview.json", " M preview.json", "A  preview.json", "M  preview.json"].includes(status)
    || fs.lstatSync(file).isSymbolicLink() || hash(fs.readFileSync(file)) !== journal.indexHash)) throw new Error("Preview index checkout contains unrelated changes");
  git(["fetch", "origin"]);
  const head = git(["rev-parse", "HEAD"]), upstream = git(["rev-parse", "origin/master"]);
  if (head !== sourceCommit) {
    if (status || !journal.indexHash || journal.indexCommit && journal.indexCommit !== head
      || git(["rev-parse", "HEAD^"]) !== sourceCommit || git(["diff", "--name-only", sourceCommit, head]) !== "preview.json"
      || hash(Buffer.from(git(["show", `${head}:preview.json`]) + "\n", "utf8")) !== journal.indexHash) throw new Error("Release source changed beyond its owned index commit");
  }
  if (upstream !== sourceCommit && upstream !== head) throw new Error("origin/master advanced; stop without merge or rebase");
  if (head === sourceCommit && upstream !== head) throw new Error("Source HEAD differs from origin/master");
  return head;
}

function publishPreviewIndex(published, expected, sourceCommit, journal, save, command = run, root = EXPERIMENT_ROOT) {
  let head = assertIndexCheckout(sourceCommit, journal, command, root);
  const file = path.join(root, "preview.json");
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
  const bytes = advancePreviewIndex(previous, published, expected);
  const nextHash = hash(bytes);
  if (journal.indexHash && journal.indexHash !== nextHash) throw new Error("Prepared index differs from publication journal");
  journal.indexHash = nextHash; save();
  if (head === sourceCommit) {
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.lstatSync(file).nlink !== 1)) throw new Error("Unsafe preview index file identity");
    fs.writeFileSync(file, bytes, { encoding: "utf8", flag: fs.existsSync(file) ? "w" : "wx" });
    command("git", ["diff", "--check"], root);
    command("git", ["add", "--", "preview.json"], root);
    if (command("git", ["diff", "--cached", "--name-only"], root) !== "preview.json") throw new Error("Only the preview index may be staged");
    command("git", ["commit", "-m", `Publish preview index for ${published.tag_name}`], root);
    head = command("git", ["rev-parse", "HEAD"], root);
  }
  journal.indexCommit = head; journal.indexStatus = "committed"; save();
  assertIndexCheckout(sourceCommit, journal, command, root);
  command("git", ["push", "origin", "master"], root);
  command("git", ["fetch", "origin"], root);
  if (command("git", ["rev-parse", "HEAD"], root) !== command("git", ["rev-parse", "origin/master"], root)) throw new Error("Preview index push could not be confirmed");
  journal.indexStatus = "published"; save();
}
module.exports = { advancePreviewIndex, assertIndexCheckout, publishPreviewIndex };
