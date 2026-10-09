const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const queueApi = require("../../dist/features/DistributedPlanQueue.js");
const retention = require("../../dist/features/PlanOutputRetention.js");
const source = fs.readFileSync(require.resolve("../../dist/extension/legacy.js"), "utf8");
const root = "C:/project";
const hash = "a".repeat(64);
const fragments = ["config.yaml", "test_results/formal_result_rows.csv", "test_results/four_state_metrics.csv"];
const required = [...fragments, "best_model.pth"];

function methods(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last).replace(/}\s+async /g, "}, async ");
}

function fixture({ emptyOriginal = false, cold = false, allMissing = false, retry = false, respectDepth = false, inventoryStdin = false } = {}) {
  const outputDir = "work_dirs/ebmc/job/attempts/run-b";
  const files = Object.fromEntries([...required, "stdout.log"].map(name => [`${outputDir}/${name}`, { sha256: hash }]));
  let state = { schemaVersion: 1, plans: ["run-a", "run-b"].map((id, index) => ({
    id, planFile: "experiments/plans/ebmc.yaml", revision: "r", codeFingerprint: "fp", fullPlanJobCount: 1,
    enqueuedAt: new Date(1700000000000 + index).toISOString(), jobs: [{
      index: 0, case: "bus", seed: 42, attempt: 1, status: "completed", commandId: id, workerId: "w1",
      outputDir: outputDir.replace("run-b", id), artifacts: Object.fromEntries(Object.keys(files).map(file => [file.replace("run-b", id), hash])),
      mirroredWorkerIds: ["w1", "w2", "w3"], fragmentWorkerIds: ["w1", "w2", "w3"],
      ...(retry ? { artifactRetryAfter: new Date(Date.now() + 30000).toISOString() } : {}),
    }],
  })) };
  const inventory = { w1: emptyOriginal || allMissing ? {} : { ...files }, w2: {}, w3: allMissing ? {} : { ...files } };
  const transfers = [], errors = [], events = [], inventoryCalls = [];
  const sandbox = {
    Buffer,
    SafeRequestRetry_1: require("../../dist/core/SafeRequestRetry.js"),
    PlanOutputRetention: retention, PlanRunFreshness: require("../../dist/results/PlanRunFreshness.js"),
    workspaceRoot: () => root, errorMessage: value => value.message,
    collectDistributedJobArtifacts: require("../../dist/features/DistributedJobArtifacts.js").collectDistributedJobArtifacts,
    DistributedJobArtifacts_1: require("../../dist/features/DistributedJobArtifacts.js"),
    workerFpsyncTaskLabel: () => "sync", PlanArtifactTransfer_1: { workerFpsyncTaskLabel: () => "sync" },
    mapLimited: async (items, _count, fn) => Promise.all(items.map(fn)),
    vscode: { ProgressLocation: { Notification: 15 }, window: { withProgress: async (_options, work) => work({ report: value => events.push(value.message) }) } },
  };
  vm.createContext(sandbox);
  const body = methods("async postprocessDistributedResultsForManual(", "async enqueueDistributedPlan(") + ",\n"
    + methods("async syncDistributedJobArtifacts(", "async rebuildDistributedResults(");
  vm.runInContext(`this.methods = { ${body} };`, sandbox);
  const host = {
    ...sandbox.methods, distributedPostprocessPromise: undefined,
    lastWorkerProbes: cold ? {} : { w1: { status: "ok" }, w2: { status: "ok" }, w3: { status: "ok" } },
    localPlanMetadata: { plans: [{ planFile: "experiments/plans/ebmc.yaml", revision: "r", jobCount: 1 }] },
    async loadDistributedQueue() { return queueApi.cloneDistributedQueue(state); },
    distributedProjectContract: () => ({ fragmentPaths: fragments, requiredPaths: required }),
    planOutputRetentionMode: () => "latest-complete",
    workerCodeSyncTargets: () => ["w1", "w2", "w3"].map(id => ({ id })),
    sftpServerOptions: value => ({ id: value.id }), assertSshTransportIdentities: async () => {},
    simpleSftpCapability: async () => ({ features: { projectInventoryStdinScopes: inventoryStdin } }),
    async refreshDistributedResultSyncProbes() {
      events.push("probe");
      this.lastWorkerProbes = { w1: { status: "ok" }, w2: { status: "ok" }, w3: { status: "ok" } };
    },
    async verifiedSftpProjectInventory({ source: server, relativePath, scopePaths, recursive }) {
      inventoryCalls.push({ workerId: server.id, relativePath, scopePaths, recursive });
      return { files: Object.fromEntries(Object.entries(inventory[server.id]).filter(([name]) => {
        if (respectDepth && relativePath === "." && recursive === false && name.includes("/")) return false;
        return scopePaths ? scopePaths.some(scope => name === scope || recursive && name.startsWith(scope + "/"))
          : name === relativePath || name.startsWith(relativePath + "/");
      })) };
    },
    async simpleSftpApiCall(method, payload) {
      assert.equal(method, "sync.serverToServerFpsync");
      transfers.push({ source: payload.source.id, destination: payload.destination.id, paths: [...payload.relativePaths] });
      assert.equal(payload.compression, "auto");
      assert.equal(payload.singleStream, true);
      for (const file of payload.relativePaths) {
        assert.ok(inventory[payload.source.id][file], `missing source ${file}`);
        inventory[payload.destination.id][file] = { ...inventory[payload.source.id][file] };
      }
    },
    async patchDistributedJob(_root, id, index, _attempt, fields) {
      const job = state.plans.find(plan => plan.id === id).jobs.find(row => row.index === index);
      for (const [key, value] of Object.entries(fields)) {
        if (/^replace/.test(key)) continue;
        const replace = key === "fragmentWorkerIds" ? fields.replaceFragmentWorkerIds : fields.replaceMirroredWorkerIds;
        job[key] = Array.isArray(value) ? replace ? [...value] : [...new Set([...(job[key] || []), ...value])] : value;
      }
    },
    async rebuildDistributedResults(_root, _queue, preview, verifyAll) {
      events.push(preview ? "preview" : "formal");
      if (!preview) for (const id of ["w1", "w2", "w3"]) for (const file of Object.keys(files))
        assert.equal(inventory[id][file]?.sha256, hash, `published before ${id}/${file} was restored`);
    },
    recordActionError(value) { errors.push(value); }, postState() {},
    queuePlanArtifactSyncStatusCheck(force) { assert.equal(force, true); },
  };
  return { host, inventory, files, transfers, errors, events, inventoryCalls, get state() { return state; } };
}

test("scoped nested artifact hashes respect the real SFTP directory depth contract", async () => {
  const f = fixture({ respectDepth: true });
  await f.host.postprocessDistributedResultsForManual(root, "full");
  assert.deepEqual(f.errors, []);
  assert.equal(f.events.includes("formal") || f.events.includes("preview"), false);
  assert.ok(f.inventoryCalls.filter(call => call.scopePaths).every(call => call.recursive === true));
});

test("108 completed jobs batch verification by Worker and recheck copied destinations", async (t) => {
  const f = fixture({ respectDepth: true });
  const model = f.state.plans[1];
  f.state.plans.length = 0;
  for (let index = 0; index < 108; index++) {
    const plan = JSON.parse(JSON.stringify(model));
    plan.id = `run-${index}`;
    plan.planFile = `experiments/plans/model-${index}.yaml`;
    const job = plan.jobs[0];
    job.outputDir = `work_dirs/model-${index}/job/attempts/${plan.id}`;
    job.commandId = `command-${index}`;
    job.artifacts = Object.fromEntries(required.map(name => [`${job.outputDir}/${name}`, hash]));
    for (const id of ["w1", "w3"]) for (const file of Object.keys(job.artifacts)) f.inventory[id][file] = { sha256: hash };
    f.state.plans.push(plan);
  }
  await f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "fragments", true);
  assert.deepEqual(f.errors, []);
  assert.equal(f.transfers.length, 1);
  assert.equal(f.transfers[0].paths.length, 324);
  assert.ok(f.inventoryCalls.length < 40, `must avoid 324 sequential SSH queries: ${f.inventoryCalls.length}`);
  assert.ok(f.inventoryCalls.every(call => call.recursive === true && call.scopePaths.length <= 128
    && Buffer.byteLength(JSON.stringify(call.scopePaths), "utf8") <= 10240));
  assert.ok(f.inventoryCalls.filter(call => call.workerId === "w2").length > f.inventoryCalls.filter(call => call.workerId === "w1").length,
    "destination must be queried again after transfer");
  t.diagnostic(`108 jobs / 324 fragment files: ${f.inventoryCalls.length} bounded inventory calls, including post-transfer verification`);
});

test("source verification errors retain the cause rather than reporting every replica as missing", async () => {
  const f = fixture();
  f.host.verifiedSftpProjectInventory = async () => { throw new Error("SSH_AUTH_FAILED: permission denied"); };
  await assert.rejects(f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "fragments", true), /SSH_AUTH_FAILED/);
  assert.equal(f.transfers.length, 0);
});

test("verification batches are bounded by UTF-8 bytes and deduplicate exact paths", async () => {
  const f = fixture();
  const paths = Array.from({ length: 180 }, (_, index) => `work_dirs/${"数据".repeat(70)}/${index}/attempts/run-b/result.csv`);
  for (const file of paths) f.inventory.w1[file] = { sha256: hash };
  const hashes = await f.host.distributedOutputHashes({ id: "w1" }, [...paths, ...paths]);
  assert.equal(Object.keys(hashes).length, paths.length);
  assert.ok(paths.every(file => hashes[file] === hash));
  assert.ok(f.inventoryCalls.length > 1);
  assert.equal(f.inventoryCalls.flatMap(call => call.scopePaths).length, paths.length);
  assert.ok(f.inventoryCalls.every(call => call.scopePaths.length <= 128
    && Buffer.byteLength(JSON.stringify(call.scopePaths), "utf8") <= 10240));
});

test("negotiated stdin inventory checks 5400 paths in two batches without command-line expansion", async (t) => {
  const f = fixture({ inventoryStdin: true, respectDepth: true });
  const paths = Array.from({ length: 5400 }, (_, index) => `work_dirs/method-${index % 17}/job-${index % 6}/attempts/distributed-plan-current/logs/file-${index}.csv`);
  for (const file of paths) f.inventory.w1[file] = { sha256: hash };
  const answer = await f.host.distributedOutputHashes({ id: "w1" }, paths);
  assert.equal(Object.keys(answer).length, 5400);
  assert.equal(f.inventoryCalls.length, 2);
  assert.ok(f.inventoryCalls.every(call => call.scopePaths.length <= 5000
    && Buffer.byteLength(JSON.stringify(call.scopePaths), "utf8") <= 1048576));
  assert.ok(paths.every(file => answer[file] === hash));
  t.diagnostic(`5400 explicit paths: ${f.inventoryCalls.length} inventory calls with negotiated stdin support`);
});

test("preflight hashes expire at the request boundary and changed copies fail visibly", async () => {
  const f = fixture({ respectDepth: true });
  await f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "fragments", true);
  for (const id of ["w1", "w2", "w3"]) for (const file of Object.keys(f.inventory[id])) f.inventory[id][file].sha256 = "b".repeat(64);
  const before = f.inventoryCalls.length;
  await assert.rejects(f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "fragments", true), /SHA256 不一致/);
  assert.ok(f.inventoryCalls.length > before);
});

test("post-transfer verification does not reuse a preflight snapshot", async () => {
  const f = fixture({ respectDepth: true });
  const transfer = f.host.simpleSftpApiCall.bind(f.host);
  f.host.simpleSftpApiCall = async (method, payload) => {
    await transfer(method, payload);
    for (const file of payload.relativePaths) f.inventory[payload.destination.id][file].sha256 = "b".repeat(64);
  };
  await assert.rejects(f.host.postprocessDistributedResultsForManual(root, "full"), /内容校验失败/);
  assert.equal(f.events.includes("formal"), false);
});

test("one cold manual click repairs deleted mirrors and result fragments before formal publication", async () => {
  const f = fixture({ cold: true, retry: true });
  await f.host.postprocessDistributedResultsForManual(root, "full");
  assert.ok(f.events.includes("probe"));
  assert.deepEqual(f.errors, []);
  assert.ok(f.transfers.length > 0);
  assert.ok(f.transfers.every(row => row.paths.every(file => file.includes("/attempts/run-b/"))));
  assert.equal(f.state.plans[1].jobs[0].artifactRetryAfter, undefined);
  const count = f.transfers.length;
  await f.host.postprocessDistributedResultsForManual(root, "full");
  assert.equal(f.transfers.length, count, "unchanged verified files must not be copied again");
});

test("deleted original output is recovered from a hash-verified mirror of the same run", async () => {
  const f = fixture({ emptyOriginal: true });
  await f.host.postprocessDistributedResultsForManual(root, "full");
  assert.deepEqual(f.errors, []);
  assert.ok(f.transfers.some(row => row.source === "w3" && row.destination === "w1"));
});

test("bulk repair includes fragments even if deletion occurs after the fragment phase", async () => {
  const f = fixture();
  await f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "bulk", true);
  assert.deepEqual(f.errors, []);
  for (const file of Object.keys(f.files)) assert.equal(f.inventory.w2[file]?.sha256, hash);
});

test("full synchronization rescans latest attempt weights beyond a previously complete artifact manifest", async () => {
  const f = fixture({ inventoryStdin: true });
  const job = f.state.plans[1].jobs[0];
  const lateWeights = [`${job.outputDir}/last_checkpoint.pth`, `${job.outputDir}/checkpoints/epoch-90.safetensors`];
  for (const file of lateWeights) f.inventory.w1[file] = { sha256: "b".repeat(64) };
  await f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "bulk", true);
  assert.deepEqual(f.errors, []);
  for (const file of lateWeights) {
    assert.equal(job.artifacts[file], "b".repeat(64));
    assert.equal(f.inventory.w2[file]?.sha256, "b".repeat(64));
    assert.equal(f.inventory.w3[file]?.sha256, "b".repeat(64));
  }
  assert.ok(f.transfers.every(row => lateWeights.every(file => row.paths.includes(file))));
  assert.equal(f.inventoryCalls.filter(call => call.workerId === "w1").length, 1,
    "one bounded directory preflight discovers weights without per-job extra SSH queries");
  const dispatched = f.transfers.length;
  await f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "bulk", true);
  assert.equal(f.transfers.length, dispatched, "unchanged latest weights are verified and skipped");
});

test("full synchronization confines work_dirs to selected latest attempts and excludes temporary state", async () => {
  const f = fixture({ inventoryStdin: true });
  const latest = f.state.plans[1].jobs[0].outputDir;
  const old = f.state.plans[0].jobs[0].outputDir;
  const excluded = [`${old}/last_checkpoint.pth`, "work_dirs/untracked/checkpoint.pth",
    `${latest}-old/best_model.pth`, `${latest}/worker.pid`, `${latest}/transfer.lock`, `${latest}/job.exit_code`];
  for (const file of excluded) f.inventory.w1[file] = { sha256: hash };
  await f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "bulk", true);
  assert.deepEqual(f.errors, []);
  assert.ok(f.inventoryCalls.every(call => call.scopePaths.every(scope => scope === latest || scope.startsWith(latest + "/"))),
    "never inventory the entire work_dirs root or a retired attempt");
  assert.ok(f.transfers.length > 0);
  assert.ok(f.transfers.every(row => row.paths.every(file => file.startsWith(latest + "/") && !excluded.includes(file))));
  for (const file of excluded) {
    assert.equal(f.inventory.w2[file], undefined);
    assert.equal(f.state.plans[1].jobs[0].artifacts[file], undefined);
    assert.ok(f.inventory.w1[file], "synchronization must not delete historical or temporary source files");
  }
});

test("different Plans sharing a Worker pair use one compressed batch", async () => {
  const f = fixture();
  const next = JSON.parse(JSON.stringify(f.state.plans[1]));
  next.id = "other-plan-run";
  next.planFile = "experiments/plans/cpsc.yaml";
  const job = next.jobs[0];
  job.outputDir = job.outputDir.replace("ebmc", "cpsc");
  job.commandId = next.id;
  job.artifacts = Object.fromEntries(Object.entries(job.artifacts).map(([file, value]) => [file.replace("ebmc", "cpsc"), value]));
  f.state.plans.push(next);
  for (const id of ["w1", "w3"]) for (const [file, value] of Object.entries(f.files)) f.inventory[id][file.replace("ebmc", "cpsc")] = value;
  await f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "bulk", true);
  assert.equal(f.transfers.length, 1);
  assert.ok(f.transfers[0].paths.some(file => file.includes("/ebmc/")));
  assert.ok(f.transfers[0].paths.some(file => file.includes("/cpsc/")));
});

test("missing all copies fails visibly and never publishes cached success", async () => {
  const f = fixture({ allMissing: true });
  await assert.rejects(f.host.postprocessDistributedResultsForManual(root, "full"), /来源|产物|校验/);
  assert.equal(f.events.includes("formal"), false);
  assert.equal(f.transfers.length, 0);
});

test("a later successful destination cannot clear another destination's sync failure", async () => {
  const f = fixture();
  f.inventory.w3 = {};
  const transfer = f.host.simpleSftpApiCall.bind(f.host);
  f.host.simpleSftpApiCall = async (method, payload) => {
    if (payload.destination.id === "w2") throw new Error("destination unavailable");
    return transfer(method, payload);
  };
  await assert.rejects(f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "bulk", true), /destination unavailable/);
  const job = f.state.plans[1].jobs[0];
  assert.match(job.artifactError, /destination unavailable/);
  assert.ok(job.artifactRetryAfter);
  assert.ok(job.mirroredWorkerIds.includes("w3"));
  assert.equal(job.mirroredWorkerIds.includes("w2"), false);
});

test("a full request waits for a metrics request and then performs the missing bulk phase", async () => {
  const f = fixture();
  let resume;
  const metrics = new Promise(resolve => { resume = resolve; });
  f.host.distributedPostprocessPromise = metrics;
  f.host.distributedPostprocessScope = "metrics";
  const full = f.host.postprocessDistributedResultsForManual(root, "full");
  f.host.distributedPostprocessPromise = undefined;
  resume();
  await Promise.all([metrics, full]);
  assert.equal(f.events.filter(value => value === "formal").length, 0);
  assert.ok(f.transfers.length > 0);
});

test("batched hash progress reports the Worker and verified counts separately from transfer", async () => {
  const f = fixture({ inventoryStdin: true });
  const progress = [];
  const paths = Object.keys(f.files);
  await f.host.distributedOutputHashes({ id: "w1" }, paths, detail => progress.push(detail));
  assert.equal(progress.length, 2);
  assert.equal(progress[0].checkedCount, 0);
  assert.equal(progress[1].checkedCount, paths.length);
  assert.equal(progress[1].phase, "hashing");
  assert.ok(progress[1].elapsedMs >= 0);
  await f.host.postprocessDistributedResultsForManual(root, "full");
  assert.ok(f.events.some(message => /SHA256 校验 · w1 · 第 1 批/.test(message)));
  assert.ok(f.events.some(message => /压缩传输 · w1 → w2/.test(message)));
});

test("metric fragment syncing never rebuilds a remote preview or leaves an abandoned wait", async () => {
  const f = fixture({ inventoryStdin: true });
  f.host.rebuildDistributedResults = async () => assert.fail("remote rebuild is retired from automatic/manual result syncing");
  await f.host.postprocessDistributedResultsForManual(root, "metrics");
  assert.equal(f.host.distributedPostprocessPromise, undefined);
  assert.equal(f.events.some(message => /重建.*预览/.test(message)), false);
  assert.ok(f.transfers.every(transfer => transfer.paths.every(file => !file.endsWith(".pth"))));
});

test("missing bulk inventories share bounded Worker scope queries instead of per-job SSH", async (t) => {
  const f = fixture({ inventoryStdin: true });
  const model = JSON.parse(JSON.stringify(f.state.plans[1]));
  f.state.plans.length = 0;
  for (let index = 0; index < 20; index++) {
    const plan = JSON.parse(JSON.stringify(model));
    plan.id = `complete-${index}`;
    plan.planFile = `experiments/plans/complete-${index}.yaml`;
    const job = plan.jobs[0];
    job.outputDir = `work_dirs/complete-${index}/job/attempts/${plan.id}`;
    job.artifacts = Object.fromEntries(fragments.map(name => [`${job.outputDir}/${name}`, hash]));
    for (const worker of ["w1", "w3"]) for (const name of [...required, "stdout.log"]) {
      f.inventory[worker][`${job.outputDir}/${name}`] = { sha256: hash };
    }
    f.state.plans.push(plan);
  }
  const read = f.host.verifiedSftpProjectInventory.bind(f.host);
  f.host.verifiedSftpProjectInventory = async options => {
    const response = await read(options);
    if (options.scopePaths) response.files = Object.fromEntries(Object.entries(f.inventory[options.source.id])
      .filter(([file]) => options.scopePaths.some(scope => file === scope || file.startsWith(scope + "/"))));
    return response;
  };
  await f.host.syncDistributedJobArtifacts(root, await f.host.loadDistributedQueue(), "bulk", true);
  assert.deepEqual(f.errors, []);
  assert.equal(f.transfers.length, 1);
  assert.equal(f.transfers[0].paths.length, 100);
  assert.ok(f.inventoryCalls.length <= 4, `${f.inventoryCalls.length} inventory calls for 20 jobs`);
  assert.ok(f.inventoryCalls.every(call => call.scopePaths?.length && call.relativePath === "."));
  assert.ok(f.state.plans.every(plan => plan.jobs[0].artifacts[`${plan.jobs[0].outputDir}/best_model.pth`] === hash));
  t.diagnostic(`20 complete jobs / 100 bulk files: ${f.inventoryCalls.length} scoped inventory calls including fresh destination verification`);
});

test("in-flight inventory byte and file progress reaches the outer notification", async () => {
  const f = fixture({ inventoryStdin: true });
  const read = f.host.verifiedSftpProjectInventory.bind(f.host);
  f.host.verifiedSftpProjectInventory = async options => {
    options.onProgress?.({ phase: "hashing", processedFiles: 4, processedBytes: 3 * 1048576, elapsedMs: 4200 });
    return read(options);
  };
  await f.host.postprocessDistributedResultsForManual(root, "full");
  assert.ok(f.events.some(message => /SHA256 校验 · w1/.test(message) && /已处理 4 个文件/.test(message)
    && /3.0 MiB 校验读取/.test(message) && /本步已耗时 4 秒/.test(message) && /总耗时 \d+ 秒/.test(message)));
});

test("directory verification shows explicit task directories and live cache evidence", async () => {
  const f = fixture({ inventoryStdin: true });
  const read = f.host.verifiedSftpProjectInventory.bind(f.host);
  f.host.verifiedSftpProjectInventory = async options => {
    options.onProgress?.({ phase: "hashing", processedFiles: 5, processedBytes: 1024, cacheHits: 4, cacheRehash: 1, cacheStatus: 'ready' });
    return { ...await read(options), reusedFiles: 4, hashedFiles: 1, cacheStatus: 'ready' };
  };
  await f.host.postprocessDistributedResultsForManual(root, "full");
  assert.ok(f.events.some(message => message.includes('核验 1 个任务目录') && message.includes('缓存命中 4，重算 1 个文件')));
  assert.ok(f.events.some(message => message.includes('已核验 1 个任务目录')));
  assert.ok(f.events.every(message => !/\d+\/\d+ 范围/.test(message)));
});

test("unavailable inventory cache is explained instead of silently claiming cache reuse", async () => {
  const f = fixture({ inventoryStdin: true });
  const read = f.host.verifiedSftpProjectInventory.bind(f.host);
  f.host.verifiedSftpProjectInventory = async options => ({ ...await read(options), reusedFiles: 0, hashedFiles: 5, cacheStatus: 'write-failed' });
  await f.host.postprocessDistributedResultsForManual(root, 'full');
  assert.ok(f.events.some(message => message.includes('缓存写入失败，正在完整校验') && message.includes('缓存命中 0，重算 5 个文件')));
});

test("transfer notification explains skipped identical and truly changed files", async () => {
  const f = fixture({ inventoryStdin: true });
  const transfer = f.host.simpleSftpApiCall.bind(f.host);
  f.host.simpleSftpApiCall = async (method, payload, _timeout, onProgress) => {
    onProgress?.({ phase: 'streaming', processedFiles: 0, transferredBytes: 1024, comparedFiles: 3816, changedFiles: 2106,
      unchangedFiles: 1710, missingFiles: 2100, differentFiles: 6 });
    return transfer(method, payload);
  };
  await f.host.postprocessDistributedResultsForManual(root, 'full');
  assert.ok(f.events.some(message => message.includes('差异 2106/3816 文件') && message.includes('相同跳过 1710，目标缺失 2100，内容不同 6')));
});

test("stream notification shows committed totals and hides legacy zero stage counters", async () => {
  const f = fixture({inventoryStdin:true});
  const transfer=f.host.simpleSftpApiCall.bind(f.host);
  f.host.simpleSftpApiCall=async (method,payload,_timeout,onProgress)=>{
    onProgress?.({phase:'streaming',processedFiles:0,transferredBytes:6*1024**3,elapsedMs:250000});
    onProgress?.({phase:'streaming',processedFiles:0,completedFiles:12,totalFiles:30,completedGroups:3,totalGroups:8,
      transferredBytes:7*1024**3,elapsedMs:251000});
    return transfer(method,payload);
  };
  await f.host.postprocessDistributedResultsForManual(root,'full');
  const rows=f.events.filter(message=>/流处理（打包、传输与解包）/.test(message));
  assert.ok(rows.length>=2);
  assert.ok(rows.every(message=>!message.includes('已处理 0 个文件')));
  assert.ok(rows.some(message=>message.includes('已完成 12/30 个文件')&&message.includes('分组 3/8')));
});

test("a directory inventory cannot inject sibling attempts or unrelated project files", async () => {
  const f = fixture({ inventoryStdin: true });
  const scope = "work_dirs/model/job/attempts/latest";
  f.host.verifiedSftpProjectInventory = async () => ({ files: {
    [`${scope}/stdout.log`]: { sha256: hash },
    [`${scope}-old/stdout.log`]: { sha256: hash },
    "work_dirs/unrelated/config.yaml": { sha256: hash },
  } });
  const hashes = await f.host.distributedOutputHashes({ id: "w1" }, [scope], undefined, true);
  assert.equal(hashes[`${scope}/stdout.log`], hash);
  assert.equal(hashes[`${scope}-old/stdout.log`], undefined);
  assert.equal(hashes["work_dirs/unrelated/config.yaml"], undefined);
});
