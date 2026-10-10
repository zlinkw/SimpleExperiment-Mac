"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { EXPERIMENT_ROOT, SFTP_ROOT, REPOSITORY, run, json, fingerprint, assertSource, verifyRemoteAssets, assertNewerPreview } = require("./mac-release-common");
const { assertIndexCheckout, publishPreviewIndex } = require("./mac-preview-index");

function main() {
  const tag = process.argv[2] || `preview-v${json(path.join(EXPERIMENT_ROOT, "package.json")).version}`;
  if (!/^preview-v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Invalid preview release tag");
  const directory = path.join(EXPERIMENT_ROOT, "release-artifacts", tag);
  if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error("Release directory identity is unsafe");
  const manifest = json(path.join(directory, "release.json"));
  const { parseManifest } = require("../dist/mac/PreviewRelease"), { verifyVsix } = require("../dist/mac/Vsix");
  const assets = manifest.components.map(item => ({ name: item.downloadUrl.split("/").at(-1), browser_download_url: item.downloadUrl, size: item.size }));
  const parsed = parseManifest(manifest, { tag_name: tag, assets }, "1.100.0");
  const expected = ["release.json", ...assets.map(item => item.name)].map(name => fingerprint(path.join(directory, name)));
  const journalPath = path.join(directory, "publish-receipt.json");
  let journal = fs.existsSync(journalPath) ? json(journalPath) : undefined;
  const owned = journal?.tag === tag && journal.manifestHash === expected[0].sha256;
  for (let index = 0; index < 2; index++) {
    const root = [SFTP_ROOT, EXPERIMENT_ROOT][index], repo = ["SimpleSFTP-Mac", "SimpleExperiment-Mac"][index];
    if (index === 1 && owned && journal.status === "published") assertIndexCheckout(parsed.components[index].sourceCommit, journal);
    else if (assertSource(root, repo) !== parsed.components[index].sourceCommit) throw new Error("Prepared source changed; publish from the original verified commit");
    verifyVsix(fs.readFileSync(path.join(directory, assets[index].name)), parsed.components[index]);
  }
  const info = JSON.parse(run("gh", ["repo", "view", REPOSITORY, "--json", "visibility"]));
  if (info.visibility !== "PUBLIC") throw new Error("Preview downloads require a public repository");
  const listing = JSON.parse(run("gh", ["api", `repos/${REPOSITORY}/releases?per_page=100`]));
  const existing = listing.find(item => item.tag_name === tag);
  if (existing && (!owned || journal.releaseId !== existing.id)) throw new Error("Release version already exists; never overwrite published or unowned drafts");
  assertNewerPreview(tag, listing.filter(item => item !== existing));
  const save = () => fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n", "utf8");
  if (existing && !existing.draft) {
    if (!existing.prerelease || existing.tag_name !== tag) throw new Error("Owned release is not a public preview");
    verifyRemoteAssets(expected, existing.assets);
    journal.status = "published"; journal.publishedAt = existing.published_at; save();
    publishPreviewIndex(existing, expected, parsed.components[1].sourceCommit, journal, save);
    process.stdout.write(`Published paired preview and static index: ${existing.html_url}\n`); return;
  }
  let draft;
  if (existing) {
    if (!existing.draft || !journal || journal.releaseId !== existing.id || journal.manifestHash !== expected[0].sha256) throw new Error("Release version already exists; never overwrite published or unowned drafts");
    draft = existing;
  } else {
    if (journal) throw new Error("Recorded draft is absent; inspect ownership rather than create another release");
    if (run("git", ["ls-remote", "origin", `refs/tags/${tag}`])) throw new Error("Release tag already exists");
    const requestPath = path.join(directory, "draft-request.json");
    const payload = { tag_name: tag, target_commitish: parsed.components[1].sourceCommit, name: `${tag} · Mac 配套更新测试版`, body: fs.readFileSync(path.join(directory, "release-notes.md"), "utf8"), draft: true, prerelease: true };
    fs.writeFileSync(requestPath, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    draft = JSON.parse(run("gh", ["api", "--method", "POST", `repos/${REPOSITORY}/releases`, "--input", requestPath]));
    journal = { releaseId: draft.id, manifestHash: expected[0].sha256, tag, status: "draft" };
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  }
  const remote = JSON.parse(run("gh", ["api", `repos/${REPOSITORY}/releases/${draft.id}/assets?per_page=100`]));
  if (remote.some(item => !expected.some(file => file.name === item.name))) throw new Error("Draft contains foreign assets; retained for inspection");
  for (const file of expected) {
    const found = remote.filter(item => item.name === file.name);
    if (found.length) { verifyRemoteAssets([file], found); continue; }
    run("gh", ["release", "upload", tag, path.join(directory, file.name), "--repo", REPOSITORY], EXPERIMENT_ROOT, { timeout: 120000 });
  }
  const complete = JSON.parse(run("gh", ["api", `repos/${REPOSITORY}/releases/${draft.id}/assets?per_page=100`]));
  verifyRemoteAssets(expected, complete);
  run("gh", ["api", "--method", "PATCH", `repos/${REPOSITORY}/releases/${draft.id}`, "-F", "draft=false"]);
  const published = JSON.parse(run("gh", ["api", `repos/${REPOSITORY}/releases/${draft.id}`]));
  if (published.draft || !published.prerelease || published.tag_name !== tag) throw new Error("Release publication could not be confirmed");
  verifyRemoteAssets(expected, published.assets);
  journal.status = "published"; journal.publishedAt = published.published_at;
  save();
  publishPreviewIndex(published, expected, parsed.components[1].sourceCommit, journal, save);
  process.stdout.write(`Published paired preview and static index: ${published.html_url}\n`);
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { main };
