const { test } = require("node:test");
const assert = require("node:assert/strict");
const { collectDistributedJobArtifacts } = require("../../dist/features/DistributedJobArtifacts.js");

const hash = "a".repeat(64);

test("mirrors job-owned logs and artifacts without machine-state tmux logs", () => {
  const output = "work_dirs/case/attempts/run-1";
  assert.deepEqual(collectDistributedJobArtifacts(output, {
    [`${output}/stdout.log`]: { sha256: hash },
    [`${output}/weights/best.pth`]: { sha256: hash.toUpperCase() },
    [`${output}/run.pid`]: { sha256: hash },
    "tmp/tmux_logs/gpu-0.log": { sha256: hash },
  }), { [`${output}/stdout.log`]: hash, [`${output}/weights/best.pth`]: hash });
});

test("requires a stable job-owned log before marking a job mirrored", () => {
  const output = "work_dirs/case/attempts/run-1";
  assert.throws(() => collectDistributedJobArtifacts(output, {
    [`${output}/best_model.pth`]: { sha256: hash },
    "tmp/tmux_logs/gpu-0.log": { sha256: hash },
  }), /缺少独立运行日志/);
});

test("failed job recovery can preserve partial artifacts before a log exists", () => {
  const output = "work_dirs/case/attempts/run-1";
  assert.deepEqual(collectDistributedJobArtifacts(output, {
    [`${output}/partial_checkpoint.pth`]: { sha256: hash },
  }, false), { [`${output}/partial_checkpoint.pth`]: hash });
});
