const { assert, fs, os, path, test, runCli, writeProject } = require("./simpleCli.support.cjs");

// FIXTURE POLICY: zero cleanup. All fixtures stay under this retained unique run directory.
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `legacy-removal-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);

function fixtureDir(name) {
  const dir = path.join(FIXTURE_ROOT, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("revoked legacy entries refuse explicitly and point to the new command", async () => {
  const expectations = [
    { args: ["api", "status"], match: /raw API passthrough removed/ },
    { args: ["status"], match: /simpleex project status/ },
    { args: ["self-check"], match: /simpleex doctor/ },
    { args: ["agent", "health"], match: /agent health stub removed/ },
    { args: ["experiments", "list"], match: /simpleex experiment list/ },
    { args: ["metrics", "leaderboard"], match: /simpleex metric list/ },
    { args: ["results", "parse"], match: /simpleex result list/ },
    { args: ["run", "--name", "manual", "--", process.execPath, "-e", "console.log('x')"], match: /recorded local run removed[\s\S]*experiment run/ },
  ];
  for (const item of expectations) {
    const result = await runCli([...item.args, "--json"]);
    assert.equal(result.code, 1, `${item.args.join(" ")} must exit usage: ${result.stdout}${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.success, false);
    assert.match(body.error.message + body.error.detail, item.match);
  }
});

test("plan build is a first-class plan action with strict JSON", async () => {
  const dir = fixtureDir("plan-build");
  writeProject(dir, { "experiments/plans/placeholder.yaml": "name: p\n" });
  const text = await runCli(["plan", "build", "--suite", "demo", "--base", "cfg.yaml", "--seeds", "1,2"], { cwd: dir });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /demo/);
  assert.match(text.stdout, /cfg\.yaml/);

  const json = await runCli(["plan", "build", "--suite", "demo", "--json"], { cwd: dir });
  assert.equal(json.code, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.suite, "demo");
  assert.match(body.yaml, /demo/);
});

test("metric leaderboard parses a metrics file locally with strict JSON mode", async () => {
  const dir = fixtureDir("metric-board");
  const file = path.join(dir, "metrics.csv");
  fs.writeFileSync(file, "runKey,experimentId,DSC,HD95\nm_seed1,e1,0.8,10\nm_seed2,e2,0.9,8\n", "utf8");
  const ok = await runCli(["metric", "leaderboard", "--file", file], { cwd: dir });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /DSC/);
  assert.match(ok.stdout, /m_seed2/);

  const json = await runCli(["metric", "leaderboard", "--file", file, "--json"], { cwd: dir });
  assert.equal(json.code, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.ok(body.metrics.includes("DSC"));

  const missing = await runCli(["metric", "leaderboard", "--json"], { cwd: dir });
  assert.equal(missing.code, 1);
  const gone = await runCli(["metric", "leaderboard", "--file", path.join(dir, "absent.csv"), "--json"], { cwd: dir });
  assert.equal(gone.code, 3);
});

test("result paper-table reads a registry locally with strict JSON mode", async () => {
  const dir = fixtureDir("paper");
  const registry = path.join(dir, "registry.json");
  fs.writeFileSync(registry, JSON.stringify({ records: [
    { runKey: "a_s1", suite: "s", dataset: "d", seed: 1, metrics: { AUC: 0.8, accuracy: 0.7 }, status: "success" },
    { runKey: "a_s2", suite: "s", dataset: "d", seed: 2, metrics: { AUC: 0.9, accuracy: 0.8 }, status: "success" },
  ] }), "utf8");
  const table = await runCli(["result", "paper-table", "--file", registry, "--metrics", "AUC,accuracy"], { cwd: dir });
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /AUC/);

  const csv = await runCli(["result", "paper-table", "--file", registry, "--format", "csv"], { cwd: dir });
  assert.equal(csv.code, 0, csv.stderr);
  assert.match(csv.stdout, /AUC/);

  const json = await runCli(["result", "paper-table", "--file", registry, "--json"], { cwd: dir });
  assert.equal(json.code, 0, json.stderr);
  assert.ok(Array.isArray(JSON.parse(json.stdout).rows));

  const conflict = await runCli(["result", "paper-table", "--file", registry, "--format", "csv", "--json"], { cwd: dir });
  assert.equal(conflict.code, 1);

  const parseMissing = await runCli(["result", "parse", "--json"], { cwd: dir });
  assert.equal(parseMissing.code, 1);
  const parseGone = await runCli(["result", "parse", "--file", path.join(dir, "absent.csv"), "--json"], { cwd: dir });
  assert.equal(parseGone.code, 3);
});

test("help no longer advertises revoked raw api, self-check, or run entries", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /simpleex api/);
  assert.doesNotMatch(result.stdout, /simpleex self-check/);
  assert.doesNotMatch(result.stdout, /simpleex run/);
  assert.match(result.stdout, /simpleex doctor/);
});
