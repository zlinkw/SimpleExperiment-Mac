const { assert, fs, http, os, path, test, spawn, root, cli, validPlan, invalidPlan, runCli, writeProject, wrappedRuntimeCapture, corimObservation, FAILURE_KEYS, physicalWorkerFixture } = require("./simpleCli.support.cjs");

test("training progress parser returns null without a recognized line", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  assert.equal(parseTrainingProgress("no metrics here"), null);
  const progress = parseTrainingProgress("[A assigned seed=43] epoch 21/300 74% 126/171 0:00:42\n  当前 loss 0.3806\n  lr 1.00e-03   显存 5.2 GiB");
  assert.equal(progress.epoch, 21);
  assert.equal(progress.max_epoch, 300);
  assert.equal(progress.batch, 126);
  assert.equal(progress.total_batch, 171);
  assert.equal(progress.percent, 6.9);
  assert.equal(progress.loss, 0.3806);
  assert.equal(progress.lr, "1.00e-03");
  assert.equal(progress.memory, "5.2 GiB");
  assert.equal(parseTrainingProgress("epoch 21/300 74%\n当前 loss 0.3").percent, 6.9);
  const localOnly = parseTrainingProgress("74%\n当前 loss 0.3");
  assert.equal(localOnly.percent, null);
  assert.equal(localOnly.loss, 0.3);
});

test("current training loop percent uses completed epochs and bounded within-epoch progress", () => {
  const { currentTrainingLoopPercent, overallTrainingPercent } = require("../../dist/cli/runtime.js");
  assert.equal(currentTrainingLoopPercent(21, 300, 126, 171, 74), 6.9);
  assert.equal(currentTrainingLoopPercent(24, 300, 53, 171, null), 7.8);
  assert.equal(currentTrainingLoopPercent(1, 300, 0, 171, null), 0);
  assert.equal(currentTrainingLoopPercent(300, 300, 171, 171, null), 100);
  assert.equal(currentTrainingLoopPercent(300, 300, 200, 171, null), 100);
  assert.equal(currentTrainingLoopPercent(1, 300, -4, 171, null), 0);
  assert.equal(currentTrainingLoopPercent(21, 300, null, null, 74), 6.9);
  assert.equal(currentTrainingLoopPercent(21, 300, null, null, null), 6.7);
  assert.equal(currentTrainingLoopPercent(0, 300, 0, 171, null), 0);
  assert.equal(currentTrainingLoopPercent(301, 300, 171, 171, null), 100);
  assert.equal(currentTrainingLoopPercent(21, 0, 126, 171, 74), null);
  assert.equal(currentTrainingLoopPercent(null, 300, 126, 171, 74), null);
  assert.equal(currentTrainingLoopPercent(NaN, 300, 126, 171, 74), null);
  assert.equal(currentTrainingLoopPercent(21, Infinity, 126, 171, 74), null);
  assert.equal(overallTrainingPercent(21, 300, 126, 171, 74), currentTrainingLoopPercent(21, 300, 126, 171, 74));
});

test("training loop percent may reset within one worker run", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const first = parseTrainingProgress("[A assigned seed=42] epoch 102/300 50% 85/171 0:02:00\n当前 loss 0.2");
  const second = parseTrainingProgress("[A shuffled seed=42] epoch 17/300 13% 22/171 0:03:00\n当前 loss 0.2");
  assert.equal(first.percent, 33.8);
  assert.equal(second.percent, 5.4);
  assert.ok(second.percent < first.percent);
});

test("standard epoch validation logs expose the latest completed epoch", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const capture = [
    "2026-09-24 16:16:10 INFO - Epoch 8: Val Loss = 0.8649, accuracy = 0.72",
    "2026-09-24 16:17:44 INFO - Epoch 9: Val Loss = 1.0077, accuracy = 0.73",
  ].join("\n");
  const progress = parseTrainingProgress(capture, 300);
  assert.equal(progress.epoch, 9);
  assert.equal(progress.max_epoch, 300);
  assert.equal(progress.percent, 3);
  assert.equal(progress.loss, 1.0077);
  assert.equal(progress.batch, null);
  assert.equal(progress.total_batch, null);
  const withoutMax = parseTrainingProgress(capture);
  assert.equal(withoutMax.epoch, 9);
  assert.equal(withoutMax.max_epoch, null);
  assert.equal(withoutMax.percent, null);
  assert.equal(withoutMax.loss, 1.0077);
  assert.equal(parseTrainingProgress("Epoch 12: Val Loss = 1.25e-03", 300).loss, 0.00125);
  assert.equal(parseTrainingProgress("Epoch 13: accuracy = 0.7", 300).loss, null);
  assert.equal(parseTrainingProgress(`${capture}\nStarting p100_low inference...`, 300), null);
  assert.equal(parseTrainingProgress(`${capture}\n[simple-experiment-runtime] done index=0`, 300), null);
});

test("mixed progress formats use the latest epoch signal", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const rich = "epoch 30/300 50% 10/20 0:00:10\n当前 loss 0.2";
  const standard = "Epoch 31: Val Loss = 0.18";
  assert.equal(parseTrainingProgress(`${rich}\n${standard}`, 300).epoch, 31);
  const latestRich = parseTrainingProgress(`${standard}\n${rich.replace("30/300", "32/300")}`, 300);
  assert.equal(latestRich.epoch, 32);
  assert.equal(latestRich.loss, 0.2);
  assert.equal(parseTrainingProgress("epoch 2/300 20% 2/10 0:00:10\nepoch 3/300 50% 5/10 0:00:10", 300).epoch, 3);
});

test("TerminalProgress wide layout does not depend on numeric ETA", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const progress = parseTrainingProgress([
    "Epoch 26/300 [Train] ━━━━━━━━━━━━━━━━━━━━ 0% 0/171 -:--:--",
    "  当前 loss --   本轮均值 --   速度 0.0 batch/s",
    "  lr 1.00e-03   显存 0.0 GiB",
  ].join("\n"), 300);
  assert.equal(progress.epoch, 26);
  assert.equal(progress.max_epoch, 300);
  assert.equal(progress.batch, 0);
  assert.equal(progress.total_batch, 171);
  assert.equal(progress.percent, 8.3);
  assert.equal(progress.loss, null);
  assert.equal(progress.lr, "1.00e-03");
  assert.equal(progress.memory, "0.0 GiB");
  const advancing = parseTrainingProgress([
    "Epoch 26/300 [Train] ━━━━━━━━━━━━━━━━━━━━ 42% 72/171 0:00:23",
    "  当前 loss 1.2344   本轮均值 1.1000   速度 2.1 batch/s",
    "  lr 1.00e-03   显存 5.2 GiB",
  ].join("\n"), 300);
  assert.equal(advancing.batch, 72);
  assert.equal(advancing.percent, 8.5);
  assert.equal(advancing.loss, 1.2344);
});

test("newer compact Rich evidence replaces stale standard epoch without guessing epoch", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const standard = "Epoch 25: Val Loss = 1.3000";
  const compact = [
    "Train ━━━━━━━━ 42% 72/171 0:00:23",
    "  当前 loss 1.2344   本轮均值 1.1000   速度 2.1 batch/s",
    "  lr 1.00e-03   显存 5.2 GiB",
  ].join("\n");
  const progress = parseTrainingProgress(`${standard}\n${compact}`, 300);
  assert.equal(progress.epoch, null);
  assert.equal(progress.max_epoch, 300);
  assert.equal(progress.batch, 72);
  assert.equal(progress.total_batch, 171);
  assert.equal(progress.percent, null);
  assert.equal(progress.loss, 1.2344);
  assert.equal(progress.lr, "1.00e-03");
  assert.equal(progress.memory, "5.2 GiB");
  const laterStandard = parseTrainingProgress(`${compact}\n${standard}`, 300);
  assert.equal(laterStandard.epoch, 25);
  assert.equal(laterStandard.percent, 8.3);
  assert.equal(laterStandard.loss, 1.3);
});

test("compact validation is partial progress and test phase is not training", () => {
  const { parseTrainingProgress } = require("../../dist/cli/runtime.js");
  const validation = parseTrainingProgress("Val low ━━━━━━━━ 60% 6/10 -:--:--", 300);
  assert.equal(validation.epoch, null);
  assert.equal(validation.max_epoch, 300);
  assert.equal(validation.batch, 6);
  assert.equal(validation.total_batch, 10);
  assert.equal(validation.percent, null);
  assert.equal(parseTrainingProgress("Epoch 25: Val Loss = 1.3\nTest ━━━━━━━━ 30% 3/10 0:00:20", 300), null);
  assert.equal(parseTrainingProgress("cache hit 42% 72/171", 300), null);
});

test("training epoch count accepts only positive integers from job config", () => {
  const { trainingMaxEpochFromYaml } = require("../../dist/cli/runtime.js");
  assert.equal(trainingMaxEpochFromYaml("train:\n  epochs: 300\n"), 300);
  assert.equal(trainingMaxEpochFromYaml("train:\n  max_epochs: 120\n"), 120);
  assert.equal(trainingMaxEpochFromYaml("train:\n  num_epochs: 50\n"), 50);
  for (const invalid of ["0", "-1", "auto", "300 epochs", "1.5"]) {
    assert.equal(trainingMaxEpochFromYaml(`train:\n  epochs: ${invalid}\n`), null);
  }
  assert.equal(trainingMaxEpochFromYaml("epochs: 70\n"), 70);
});
