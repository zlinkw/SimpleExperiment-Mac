const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assertProjectResultPublicationBaseGeneration, publishProjectResultFiles, projectResultPublicationJournalPath, recoverProjectResultPublication } = require("../../dist/results/ProjectResultPublication");

const resultDirectory = "experiments/results";
const tablePath = resultDirectory + "/set/final/final.csv";
const registryPath = "simple_cluster/results/project_table_registry.json";
const hash = text => crypto.createHash("sha256").update(text, "utf8").digest("hex");

async function workspace(t) {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "simple-result-publication-"));
  t.after(() => fsSync.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function write(root, relative, text) {
  const full = path.join(root, ...relative.split("/"));
  fsSync.mkdirSync(path.dirname(full), { recursive: true });
  fsSync.writeFileSync(full, text, "utf8");
}

test("multi-file publication rolls back all targets after a rename failure", async t => {
  const root = await workspace(t);
  await write(root, tablePath, "old-table");
  await write(root, registryPath, "old-registry");
  const id = crypto.randomUUID();
  const nextRegistry = JSON.stringify({ schemaVersion: 1, publicationGeneration: id, plans: {} });
  let targetRenames = 0;
  const rename = async (from, to) => {
    if (!String(from).includes("project_table_publication.json.tmp-")) {
      targetRenames++;
      if (targetRenames === 2) throw new Error("injected publish rename failure");
    }
    return fs.rename(from, to);
  };
  await assert.rejects(publishProjectResultFiles(root, resultDirectory, [
    { relativePath: tablePath, contents: "new-table" },
    { relativePath: registryPath, contents: nextRegistry },
  ], { rename, generationId: id }), /injected publish rename failure/);
  assert.equal(fsSync.readFileSync(path.join(root, ...tablePath.split("/")), "utf8"), "old-table");
  assert.equal(fsSync.readFileSync(path.join(root, ...registryPath.split("/")), "utf8"), "old-registry");
  assert.equal(JSON.parse(await fs.readFile(projectResultPublicationJournalPath(root), "utf8")).status, "rolled-back");
  assert.equal(await recoverProjectResultPublication(root, resultDirectory), "clean");
});

test("identical originals are hash-verified and excluded from replacement and staging", async t => {
  const root = await workspace(t), original = resultDirectory + '/raw/original.csv';
  await write(root, original, 'original');
  const previous = fsSync.statSync(path.join(root, original)).mtimeMs;
  const id = crypto.randomUUID(), registry = JSON.stringify({ schemaVersion: 1, publicationGeneration: id, plans: {} });
  const renamed = [];
  await publishProjectResultFiles(root, resultDirectory, [
    { relativePath: original, contents: 'original', immutable: true },
    { relativePath: tablePath, contents: 'table' }, { relativePath: registryPath, contents: registry },
  ], { generationId: id, rename: async (from, to) => { renamed.push(to); return fs.rename(from, to); } });
  assert.equal(renamed.includes(path.join(root, original)), false);
  assert.equal(fsSync.statSync(path.join(root, original)).mtimeMs, previous);
  const journal = JSON.parse(await fs.readFile(projectResultPublicationJournalPath(root), 'utf8'));
  assert.deepEqual(journal.entries.map(entry => entry.target), [tablePath, registryPath]);
  await publishProjectResultFiles(root, resultDirectory, [{ relativePath: original, contents: 'original' }]);
  assert.equal(JSON.parse(await fs.readFile(projectResultPublicationJournalPath(root), 'utf8')).id, id);
});

test("large wrapper bundles reach path preflight beyond the legacy 4096-file cap", async t => {
  const root = await workspace(t);
  const files = Array.from({ length: 4097 }, (_, index) => ({ relativePath: index ? resultDirectory + '/raw/' + index + '.csv' : 'outside.csv', contents: 'x' }));
  await assert.rejects(publishProjectResultFiles(root, resultDirectory, files), /目录外目标/);
  await assert.rejects(publishProjectResultFiles(root, resultDirectory, Array.from({ length: 32769 }, () => files[0])), /上限 32768/);
});

test("Windows journal retries longer sharing violations without downgrading a committed generation", { skip: process.platform !== 'win32' }, async t => {
  const root = await workspace(t), rename = fs.rename;
  const journalPath = projectResultPublicationJournalPath(root);
  let locked = 0;
  fs.rename = async (from, to) => {
    if (to === journalPath && ++locked <= 6) throw Object.assign(new Error('journal indexer holds handle'), { code: 'EPERM' });
    return rename(from, to);
  };
  try { await publishProjectResultFiles(root, resultDirectory, [{ relativePath: tablePath, contents: 'new' }]); }
  finally { fs.rename = rename; }
  assert.ok(locked > 6);
  assert.equal(await fs.readFile(path.join(root, tablePath), 'utf8'), 'new');
  assert.equal(JSON.parse(await fs.readFile(journalPath, 'utf8')).status, 'committed');
});

test("final journal write failure leaves the published generation recoverable instead of recording a false rollback", async t => {
  const root = await workspace(t), rename = fs.rename, id = crypto.randomUUID();
  const journalPath = projectResultPublicationJournalPath(root);
  fs.rename = async (from, to) => {
    if (to === journalPath && JSON.parse(await fs.readFile(from, 'utf8')).status === 'committed')
      throw Object.assign(new Error('final journal write unavailable'), { code: 'EIO' });
    return rename(from, to);
  };
  try {
    await assert.rejects(publishProjectResultFiles(root, resultDirectory, [
      { relativePath: tablePath, contents: 'new-table' },
      { relativePath: registryPath, contents: JSON.stringify({ schemaVersion: 1, publicationGeneration: id, plans: {} }) },
    ], { generationId: id }), /final journal write unavailable/);
  } finally { fs.rename = rename; }
  assert.equal(JSON.parse(await fs.readFile(journalPath, 'utf8')).status, 'publishing');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, registryPath), 'utf8')).publicationGeneration, id);
  assert.equal(await recoverProjectResultPublication(root, resultDirectory), 'recovered');
  assert.equal(JSON.parse(await fs.readFile(journalPath, 'utf8')).status, 'committed');
});

test("recovery completes a prepared generation before readers consume its registry", async t => {
  const root = await workspace(t);
  await write(root, tablePath, "old-table");
  await write(root, registryPath, "old-registry");
  const id = crypto.randomUUID();
  const stageRoot = `simple_cluster/tmp/result_publication/${id}`;
  const nextRegistry = JSON.stringify({ schemaVersion: 1, publicationGeneration: id, plans: {} });
  const rows = [
    { target: tablePath, contents: "new-table" },
    { target: registryPath, contents: nextRegistry },
  ];
  const entries = [];
  for (const [index, row] of rows.entries()) {
    const staged = `${stageRoot}/${index}.new`;
    const backup = `${stageRoot}/${index}.old`;
    await write(root, staged, row.contents);
    await write(root, backup, row.target === tablePath ? "old-table" : "old-registry");
    entries.push({ target: row.target, staged, backup, hadPrevious: true, nextHash: hash(row.contents), previousHash: hash(row.target === tablePath ? "old-table" : "old-registry") });
  }
  await fs.rename(path.join(root, ...entries[0].staged.split("/")), path.join(root, ...entries[0].target.split("/")));
  await write(root, "simple_cluster/results/project_table_publication.json", JSON.stringify({ schemaVersion: 1, id, resultDirectory, status: "publishing", entries }));
  assert.equal(await recoverProjectResultPublication(root, resultDirectory), "recovered");
  assert.equal(fsSync.readFileSync(path.join(root, ...tablePath.split("/")), "utf8"), "new-table");
  assert.equal(fsSync.readFileSync(path.join(root, ...registryPath.split("/")), "utf8"), nextRegistry);
  assert.equal(JSON.parse(await fs.readFile(projectResultPublicationJournalPath(root), "utf8")).status, "committed");
  assert.equal(fsSync.readFileSync(path.join(root, ...entries[0].backup.split("/")), "utf8"), "old-table", "legacy backups remain available for explicit inspection");
});

test("recovery rejects transaction targets outside the configured result directory", async t => {
  const root = await workspace(t);
  const id = crypto.randomUUID();
  await write(root, "simple_cluster/results/project_table_publication.json", JSON.stringify({ schemaVersion: 1, id, resultDirectory, status: "preparing", entries: [
    { target: "src/extension.ts", staged: `simple_cluster/tmp/result_publication/${id}/0.new`, backup: `simple_cluster/tmp/result_publication/${id}/0.old`, hadPrevious: false, nextHash: hash("x") },
  ] }));
  await assert.rejects(recoverProjectResultPublication(root, resultDirectory), /目录外目标/);
});

test("a stale result registry generation cannot overwrite a newer publication", async t => {
  const root = await workspace(t);
  await write(root, registryPath, JSON.stringify({ schemaVersion: 1, publicationGeneration: "new-generation", plans: {} }));
  await assert.rejects(assertProjectResultPublicationBaseGeneration(root, "old-generation"), error => error.code === "RESULT_REGISTRY_CONFLICT");
  await assert.doesNotReject(assertProjectResultPublicationBaseGeneration(root, "new-generation"));
});

test("same-process publications serialize and the registry remains the last generation marker", async t => {
  const root = await workspace(t);
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const first = publishProjectResultFiles(root, resultDirectory, [
    { relativePath: tablePath, contents: "first-table" },
    { relativePath: registryPath, contents: JSON.stringify({ schemaVersion: 1, publicationGeneration: firstId, plans: {} }) },
  ], { generationId: firstId });
  const second = publishProjectResultFiles(root, resultDirectory, [
    { relativePath: tablePath, contents: "second-table" },
    { relativePath: registryPath, contents: JSON.stringify({ schemaVersion: 1, publicationGeneration: secondId, plans: {} }) },
  ], { generationId: secondId });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.generationId, firstId);
  assert.equal(secondResult.generationId, secondId);
  assert.equal(fsSync.readFileSync(path.join(root, ...tablePath.split("/")), "utf8"), "second-table");
  assert.equal(JSON.parse(fsSync.readFileSync(path.join(root, ...registryPath.split("/")), "utf8")).publicationGeneration, secondId);
  assert.equal(JSON.parse(await fs.readFile(projectResultPublicationJournalPath(root), "utf8")).id, secondId);
  await assert.rejects(publishProjectResultFiles(root, resultDirectory, [
    { relativePath: registryPath, contents: "invalid-order" },
    { relativePath: tablePath, contents: "invalid-order" },
  ]), /必须是最后提交/);
});

test("recovery refuses journal staging paths that are not owned by that transaction", async t => {
  const root = await workspace(t);
  await write(root, "simple_cluster/results/project_table_publication.json", JSON.stringify({ schemaVersion: 1, id: crypto.randomUUID(), resultDirectory, status: "preparing", entries: [
    { target: tablePath, staged: "simple_cluster/results/project_table_registry.json", backup: "simple_cluster/results/other.json", hadPrevious: false, nextHash: hash("x") },
  ] }));
  await assert.rejects(recoverProjectResultPublication(root, resultDirectory), /暂存路径不属于当前事务/);
});

test("repeated publications reuse bounded slots and retain only the latest settled journal", async t => {
  const root = await workspace(t);
  for (let index = 0; index < 20; index++) {
    const id = crypto.randomUUID();
    const result = await publishProjectResultFiles(root, resultDirectory, [
      { relativePath: tablePath, contents: `table-${index}` },
      { relativePath: registryPath, contents: JSON.stringify({ schemaVersion: 1, publicationGeneration: id, plans: {} }) },
    ], { generationId: id });
    assert.equal(result.cleanupPending, false);
    assert.equal(await recoverProjectResultPublication(root, resultDirectory), "clean");
    const journal = JSON.parse(await fs.readFile(projectResultPublicationJournalPath(root), "utf8"));
    assert.equal(journal.status, "committed");
    assert.equal(journal.id, id);
    assert.deepEqual(await fs.readdir(path.join(root, "simple_cluster/tmp/result_publication")), ["current"]);
    assert.ok((await fs.readdir(path.join(root, "simple_cluster/tmp/result_publication/current"))).length <= 2);
  }
});

test("a hard-linked reusable backup is rejected without corrupting the linked file or current results", async t => {
  const root = await workspace(t);
  await write(root, tablePath, "old-table");
  await write(root, "protected.txt", "protected");
  await fs.mkdir(path.join(root, "simple_cluster/tmp/result_publication/current"), { recursive: true });
  await fs.link(path.join(root, "protected.txt"), path.join(root, "simple_cluster/tmp/result_publication/current/0.old"));
  await assert.rejects(publishProjectResultFiles(root, resultDirectory, [{ relativePath: tablePath, contents: "new-table" }]), /不是普通独占文件/);
  assert.equal(await fs.readFile(path.join(root, "protected.txt"), "utf8"), "protected");
  assert.equal(await fs.readFile(path.join(root, tablePath), "utf8"), "old-table");
  assert.equal(JSON.parse(await fs.readFile(projectResultPublicationJournalPath(root), "utf8")).status, "rolled-back");
});

test("interrupted preparation is settled without touching targets or deleting partial slots", async t => {
  const root = await workspace(t);
  const id = crypto.randomUUID();
  const staged = "simple_cluster/tmp/result_publication/current/0.new";
  await write(root, tablePath, "old-table");
  await write(root, staged, "partial");
  await write(root, "simple_cluster/results/project_table_publication.json", JSON.stringify({ schemaVersion: 1, id, resultDirectory, status: "preparing", entries: [
    { target: tablePath, staged, backup: "simple_cluster/tmp/result_publication/current/0.old", hadPrevious: true, nextHash: hash("new-table"), previousHash: hash("old-table") },
  ] }));
  assert.equal(await recoverProjectResultPublication(root, resultDirectory), "rolled-back");
  assert.equal(await fs.readFile(path.join(root, tablePath), "utf8"), "old-table");
  assert.equal(await fs.readFile(path.join(root, staged), "utf8"), "partial");
  await publishProjectResultFiles(root, resultDirectory, [{ relativePath: tablePath, contents: "new-table" }]);
  assert.equal(await fs.readFile(path.join(root, tablePath), "utf8"), "new-table");
});
