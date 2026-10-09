const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const agentPath = path.join(root, "src/clusterAgentRuntime.legacy.ts");
const fixturePath = path.join(__dirname, "scheduler_state_cleanup_ownership_fixture.py");
const source = fs.readFileSync(agentPath, "utf8");

test("scheduler state cleanup requires exact project, Plan, run, attempt and terminal proof", () => {
  const result = spawnSync("python", ["-X", "utf8", fixturePath], {
    input: source,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.match(result.stdout, /scheduler state ownership ok/);
});

test("cleanup exposes only owned scheduler state and revalidates ownership before deletion", () => {
  const candidatesStart = source.indexOf("def cache_cleanup_candidates(root):");
  const candidatesEnd = source.indexOf("\ndef cache_delete_exact_file(", candidatesStart);
  const candidates = source.slice(candidatesStart, candidatesEnd);
  assert.match(candidates, /scheduler_state_cleanup_owner_matches\(root_real, path, state\)/);
  assert.match(candidates, /已终止 Plan 的专属调度状态/);
  assert.match(candidates, /stat\.st_mtime > cutoff/);

  const deleteStart = source.indexOf("def cache_delete_exact_file(");
  const deleteEnd = source.indexOf("\ndef handle_action(", deleteStart);
  const deletion = source.slice(deleteStart, deleteEnd);
  assert.match(deletion, /scheduler_state_cleanup_owner_matches\(root_real, full_path, state\)/);
  assert.match(deletion, /cd -- \"\$1\"/);
  assert.ok(deletion.includes('rm -- "./$2"'));
});
