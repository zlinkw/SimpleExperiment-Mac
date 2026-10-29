const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// 并行编排专用用例：Git 网络分支与 Worker 上传分支互不取消、逐目标写租约、并发度 2 补位。
// 全部用可控 promise + 事件顺序断言，不用计时器，不设性能阈值。
const root = path.resolve(__dirname, "..", "..");
const srcSource = fs.readFileSync(path.join(root, "src/extension/legacy.ts"), "utf8");
const distSource = fs.readFileSync(path.join(root, "dist/extension/legacy.js"), "utf8");
const Gate = require("../../dist/features/DispatchHandoffGate.js");

function sliceMethod(source, name) {
  const asyncAt = source.indexOf("\n    async " + name + "(");
  const plainAt = source.indexOf("\n    " + name + "(");
  const start = asyncAt >= 0 ? asyncAt + 1 : plainAt + 1;
  assert.ok(start > 0, name);
  const rest = source.slice(start + name.length + 8);
  const next = rest.search(/\n {4}(?:async )?[A-Za-z_][A-Za-z0-9_]*\([^;]*\) \{/);
  assert.ok(next > 0, name + " end");
  return source.slice(start, start + name.length + 8 + next);
}

function compiled(name) {
  const body = sliceMethod(distSource, name).replace(/^\s{4}/gm, "");
  const prefix = body.startsWith("async ") ? "async function " : "function ";
  return body.replace(new RegExp("^(?:async )?" + name + "\\("), prefix + name + "(");
}

// 真实的 mapLimited 本体（并发度与补位行为由生产代码决定，不在测试里另写一份）。
const mapLimitedStart = distSource.indexOf("async function mapLimited(");
assert.ok(mapLimitedStart > 0, "mapLimited");
const mapLimitedEnd = distSource.indexOf("\n}\n", mapLimitedStart);
const mapLimited = new Function(distSource.slice(mapLimitedStart, mapLimitedEnd + 3) + "\nreturn mapLimited;")();

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// 事件顺序观测：不 sleep，等某个事件被记录只用微任务等待。
function recorder() {
  const events = [];
  const waiters = new Map();
  const record = (name) => {
    events.push(name);
    const pending = waiters.get(name) || [];
    waiters.delete(name);
    for (const resolveOne of pending) resolveOne();
  };
  const once = (name) => (events.includes(name) ? Promise.resolve()
    : new Promise((resolveOne) => waiters.set(name, (waiters.get(name) || []).concat(resolveOne))));
  return { events, record, once };
}

function publishHarness({ gitOk, workerOk, uploadMessage = "已同步 1 台，待同步 0 台" }) {
  const watch = recorder();
  const notices = [];
  const errors = [];
  const gitDeferred = deferred();
  const workerDeferred = deferred();
  const vscode = {
    ProgressLocation: { Notification: 15 },
    window: {
      withProgress: async (_options, run) => run({ report: (value) => { if (value && value.message) watch.record("progress:" + value.message); } }),
      showInformationMessage: async (message) => { notices.push(String(message)); },
      showErrorMessage: async (message) => { errors.push(String(message)); },
    },
  };
  const publishToGitHub = new Function("vscode", "errorMessage", compiled("publishToGitHub") + "\nreturn publishToGitHub;")(
    vscode, (error) => (error && error.message) || String(error || ""));
  const host = {
    githubUpdateToken: async () => "token",
    prepareLocalGitPublish: async (_taskName, report) => {
      watch.record("git-prepare");
      report("待推送提交已确定：publish-test");
      return { repo: {}, message: "publish-test", committed: false, hasRemote: true };
    },
    publishPreparedGitBranch: async (_prepared, report) => {
      watch.record("git-push-start");
      await gitDeferred.promise;
      if (!gitOk) throw new Error("git 网络失败");
      report("正在推送到 GitHub…");
      watch.record("git-push-done");
      return { pushed: true, createdRemote: false };
    },
    uploadProjectToWorkers: async (_confirm, options) => {
      watch.record("worker-start");
      await workerDeferred.promise;
      if (!workerOk) throw new Error("worker 写入失败");
      options.progressReport("正在读取 Worker B 的远端清单（2/2）…");
      watch.record("worker-done");
      return { message: uploadMessage };
    },
  };
  const run = () => publishToGitHub.call(host, "publish-test");
  return { watch, notices, errors, gitDeferred, workerDeferred, run };
}

test("Git 推送卡住时 Worker 上传照样进入，不被 Git 网络拖住", async () => {
  const h = publishHarness({ gitOk: true, workerOk: true });
  const run = h.run();
  await h.watch.once("worker-start");
  assert.ok(h.watch.events.includes("git-prepare"), "本机准备必须先于网络分支");
  assert.ok(h.watch.events.includes("git-push-start"), "Git 网络分支已发起");
  assert.ok(!h.watch.events.includes("git-push-done"), "此刻 Git 推送仍未结束");
  assert.ok(h.watch.events.indexOf("git-prepare") < h.watch.events.indexOf("worker-start"), "本机准备完成后才开 Worker 分支");
  assert.match(h.watch.events.filter((name) => name.startsWith("progress:")).join("\n"), /并行进行/);
  h.gitDeferred.resolve();
  h.workerDeferred.resolve();
  await run;
  assert.ok(h.watch.events.includes("worker-done"));
});

test("Worker 上传卡住时 Git 推送照样完成，不被上传拖住", async () => {
  const h = publishHarness({ gitOk: true, workerOk: true });
  const run = h.run();
  await h.watch.once("worker-start");
  h.gitDeferred.resolve();
  await h.watch.once("git-push-done");
  assert.ok(!h.watch.events.includes("worker-done"), "此刻 Worker 上传仍未结束");
  h.workerDeferred.resolve();
  await run;
});

test("Git 失败不自动取消已并行的 Worker 上传，且不说“已发布”", async () => {
  const h = publishHarness({ gitOk: false, workerOk: true });
  const run = h.run();
  await h.watch.once("worker-start");
  h.gitDeferred.resolve();
  await h.watch.once("git-push-start");
  assert.ok(!h.watch.events.includes("worker-done"), "Worker 分支继续跑，未被 Git 失败取消");
  h.workerDeferred.resolve();
  await assert.rejects(run, /git 网络失败/);
  assert.ok(h.watch.events.includes("worker-done"), "Worker 分支跑完才算结束");
  assert.equal(h.notices.length, 0, "Git 失败不得发成功通知");
  assert.match(h.errors.join("\n"), /GitHub 发布失败/);
  assert.match(h.errors.join("\n"), /Worker 上传已完成/);
  assert.match(h.errors.join("\n"), /成功目标未回滚/);
  assert.doesNotMatch(h.errors.join("\n"), /GitHub 已发布/);
});

test("Worker 失败不回滚已成功的目标，播报仍分开陈述", async () => {
  const h = publishHarness({ gitOk: true, workerOk: false });
  const run = h.run();
  await h.watch.once("worker-start");
  h.gitDeferred.resolve();
  h.workerDeferred.resolve();
  await assert.rejects(run, /worker 写入失败/);
  assert.ok(h.watch.events.includes("git-push-done"), "Git 分支不因 Worker 失败被取消");
  assert.match(h.errors.join("\n"), /GitHub 已发布，但 Worker 上传失败/);
  assert.doesNotMatch(h.notices.join("\n"), /GitHub 已发布；/);
});

test("两侧都失败时分别给原因，未知写入提示先查询不自动重放", async () => {
  const h = publishHarness({ gitOk: false, workerOk: false });
  const run = h.run();
  await h.watch.once("worker-start");
  h.gitDeferred.resolve();
  h.workerDeferred.resolve();
  await assert.rejects(run, /git 网络失败/);
  assert.ok(h.watch.events.includes("git-push-start") && h.watch.events.includes("worker-start"), "两侧都真正发起过");
  assert.match(h.errors.join("\n"), /均失败/);
  assert.match(h.errors.join("\n"), /git 网络失败/);
  assert.match(h.errors.join("\n"), /worker 写入失败/);
  assert.match(h.errors.join("\n"), /不会自动重放/);
});

test("两侧都成功才给合并成功播报，Worker 分支进度仍按分支文案归并", async () => {
  const h = publishHarness({ gitOk: true, workerOk: true });
  const run = h.run();
  await h.watch.once("worker-start");
  h.gitDeferred.resolve();
  h.workerDeferred.resolve();
  await run;
  assert.equal(h.errors.length, 0);
  assert.match(h.notices.at(-1), /GitHub 已发布；已同步 1 台/);
  const merged = h.watch.events.filter((name) => name.startsWith("progress:GitHub："));
  assert.ok(merged.some((name) => /Worker：正在读取 Worker B/.test(name)), "归并文案带分支专属状态");
  assert.ok(merged.some((name) => /GitHub：已推送/.test(name)), "Git 分支状态单独可见");
});

test("并发度保持 2：一个槽位释放即补位，不等前两个全部结束", async () => {
  const watch = recorder();
  const gates = [deferred(), deferred(), deferred()];
  let inflight = 0;
  let peak = 0;
  const run = mapLimited([0, 1, 2], 2, async (index) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    watch.record("start" + index);
    await gates[index].promise;
    inflight -= 1;
    watch.record("end" + index);
  });
  await watch.once("start1");
  assert.equal(inflight, 2, "同时最多两个在跑，且不因串行只剩一个");
  assert.ok(!watch.events.includes("start2"), "第三项必须等槽位释放");
  gates[0].resolve();
  await watch.once("start2");
  assert.ok(!watch.events.includes("end1"), "补位发生在单个槽位释放时，不等另一目标结束");
  gates[1].resolve();
  gates[2].resolve();
  await run;
  assert.equal(peak, 2, "并发度仍是 2，没有放大成无界并发");
  assert.deepEqual(watch.events.filter((name) => name.startsWith("end")).length, 3);
});

test("同一规范服务器加同一实际 root 互斥，不同 Worker ID 不绕过租约", async () => {
  const table = Gate.createTargetLeaseTable();
  const key = "worker.example:22:/work/proj";
  const first = await Gate.acquireTargetLease(table, key, "sync-A");
  let secondDone = false;
  const second = Gate.acquireTargetLease(table, key, "sync-B").then((token) => { secondDone = true; return token; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(secondDone, false, "不同 Worker ID 指向同一实际写目标必须排队");
  Gate.releaseTargetLease(table, first);
  const secondToken = await second;
  assert.equal(secondDone, true);
  assert.equal(secondToken.ownerId, "sync-B");
  Gate.releaseTargetLease(table, secondToken);
});

test("不同实际写目标不被误锁，不同 root 可并行取租约", async () => {
  const table = Gate.createTargetLeaseTable();
  const held = await Gate.acquireTargetLease(table, "worker.example:22:/work/proj", "sync-A");
  let otherDone = false;
  const other = Gate.acquireTargetLease(table, "worker.example:22:/work/other", "sync-B").then((token) => { otherDone = true; return token; });
  const otherToken = await other;
  assert.equal(otherDone, true, "不同实际 root 不得互相等待");
  Gate.releaseTargetLease(table, otherToken);
  Gate.releaseTargetLease(table, held);
});

test("租约键取规范服务器与端口加实际 root，不取 Worker ID", async () => {
  const leaseSource = sliceMethod(srcSource, "acquireCodeUploadTargetLeaseLocal") + sliceMethod(srcSource, "resolveCodeUploadTargetIdentityLocal");
  // 身份只能走生产侧已有链路，解不出来就明确失败，不允许占位身份。
  assert.match(leaseSource, /: this\.resolveCodeUploadTargetIdentityLocal\(target\);/, "没有预解身份时必须走生产身份链");
  assert.match(leaseSource, /resolvedIdentity\?\.key \? \{ key: String\(resolvedIdentity\.key\) \}/, "等锁前预解出的目标键可以直接交出，但不编造身份");
  assert.match(leaseSource, /this\.sftpServerOptions\(target\)/);
  assert.match(leaseSource, /host\.toLowerCase\(\)\}:\$\{port\}:\$\{remoteRoot\}/, "主机不区分大小写，POSIX root 保留原大小写");
  assert.doesNotMatch(leaseSource, /key = [^\n]*target\.id/, "键不得掺入 Worker ID");
  assert.match(leaseSource, /\u65e0\u6cd5\u89e3\u6790\u4ee3\u7801\u5199\u5165\u76ee\u6807|\u7f3a\u5c11\u670d\u52a1\u5668\u5730\u5740|\u7f3a\u5c11\u8fdc\u7aef\u9879\u76ee\u6839/);
  const method = new Function("DispatchHandoffGate", "errorMessage", "SshTransportIdentity_1",
    compiled("targetLeaseTableLocal") + compiled("sftpServerOptions") + compiled("sshTransportIdentity")
    + compiled("resolveCodeUploadTargetIdentityLocal") + compiled("acquireCodeUploadTargetLeaseLocal") + compiled("releaseCodeUploadTargetLeaseLocal")
    + "\nreturn { targetLeaseTableLocal, sftpServerOptions, sshTransportIdentity, resolveCodeUploadTargetIdentityLocal, acquireCodeUploadTargetLeaseLocal, releaseCodeUploadTargetLeaseLocal };")(
      Gate, error => String(error), require("../../dist/tunnel/SshTransportIdentity.js"));
  // 不预设租约表字段：走生产侧惰性创建，确认摘出宿主也不会拼接不上。
  const host = { ...method };
  const a = await method.acquireCodeUploadTargetLeaseLocal.call(host, { id: "worker-a", label: "A", host: "Worker.Example", port: 22, remotePath: "/work/proj/" }, "sync-1");
  assert.equal(a.key, "worker.example:22:/work/proj", "键取规范服务器 + 端口 + 实际 root");
  method.releaseCodeUploadTargetLeaseLocal.call(host, a.token);
  // 同键第二个必须等前一个释放，因此这里先释放再取，互斥性质由上一条用例专门覆盖。
  const b = await method.acquireCodeUploadTargetLeaseLocal.call(host, { id: "worker-b", label: "B", host: "worker.example", port: 22, remotePath: "\\work\\proj\\" }, "sync-2");
  assert.equal(a.key, b.key, "不同 Worker ID 但同一服务器与实际 root 必须同键");
  method.releaseCodeUploadTargetLeaseLocal.call(host, b.token);
  const c = await method.acquireCodeUploadTargetLeaseLocal.call(host, { id: "worker-c", label: "C", host: "elsewhere.example", port: 22, remotePath: "/work/proj" }, "sync-3");
  assert.notEqual(a.key, c.key, "不同规范服务器不得同键，否则跳服务器并行被打成串行");
  // 交出已解析身份也必须仍然按该身份取锁，不会退回 Worker ID 或占位键。
  const pre = await method.acquireCodeUploadTargetLeaseLocal.call(host, { id: "worker-pre", label: "P", host: "worker.example", port: 22, remotePath: "/work/proj" },
    "sync-pre", undefined, { key: "worker.example:22:/work/proj" });
  assert.equal(pre.key, a.key, "预解身份与自行解析必须得到同一实际目标键");
  method.releaseCodeUploadTargetLeaseLocal.call(host, pre.token);
  method.releaseCodeUploadTargetLeaseLocal.call(host, c.token);
  const d = await method.acquireCodeUploadTargetLeaseLocal.call(host, { id: "worker-d", label: "D", host: "worker.example", port: 2222, remotePath: "/work/proj" }, "sync-4");
  assert.notEqual(a.key, d.key, "同主机不同端口不是同一个写入目标");
  method.releaseCodeUploadTargetLeaseLocal.call(host, d.token);
  await assert.rejects(() => method.acquireCodeUploadTargetLeaseLocal.call(host, { id: "broken", label: "缺地址", remotePath: "/work/proj" }, "sync-5"),
    /\u7f3a\u5c11\u670d\u52a1\u5668\u5730\u5740/);
  assert.equal(host.codeUploadTargetLeases.held.size, 0, "解析失败不得留下占位租约");
  assert.equal(Gate.releaseTargetLease(host.codeUploadTargetLeases, { key: a.key, ownerId: "ghost" }), false, "无关令牌不得解锁");
});

test("单个目标失败不阻止其他目标跑完，取消留到全部分支收敛后再抛", async () => {
  const watch = recorder();
  const failures = [];
  const cancelled = [];
  class Cancelled extends Error {}
  const gates = { a: deferred(), b: deferred(), c: deferred() };
  gates.c.promise.catch(() => {}); // 避免未处理拒绝告警；真实结局仍由目标内的 await 决定。
  // 与生产契约一致：目标回调吸收错误，外层等全部分支收敛后才抛取消，不把 finally 当成写入已结束。
  const run = mapLimited(["a", "b", "c"], 2, async (id) => {
    watch.record("start-" + id);
    try {
      await gates[id].promise;
      if (id === "b") throw new Cancelled("工作区已切换");
      watch.record("done-" + id);
    } catch (error) {
      if (error instanceof Cancelled) { cancelled.push(error); return; }
      failures.push(id + ":" + error.message);
    }
  });
  await watch.once("start-b");
  gates.a.resolve();
  gates.c.reject(new Error("写入失败"));
  await watch.once("done-a");
  gates.b.resolve();
  await run;
  assert.deepEqual(failures, ["c:写入失败"], "失败只记自己那条，不吞掉其他目标");
  assert.equal(cancelled.length, 1);
  assert.ok(watch.events.includes("done-a"), "A 失败不影响 B/C 各自的结局");
  assert.ok(watch.events.includes("start-b"), "第三目标仍按容量补位跑完");
  assert.equal(watch.events.filter((name) => name.startsWith("start-")).length, 3, "全部已发起分支都被收敛");
});

test("gate 状态惰性创建，只摘出部分类成员的宿主不会因此拼不了", () => {
  // 回归护栏：字段初始化器直接引用 gate 模块会让数十个“摘类成员进 VM 宿主”的用例整体报
  // ReferenceError: DispatchHandoffGate is not defined，必须首次使用时才创建。
  assert.doesNotMatch(srcSource, /private\s+readonly\s+dispatchHandoffGate\s*=\s*DispatchHandoffGate\./);
  assert.doesNotMatch(srcSource, /private\s+readonly\s+codeUploadTargetLeases\s*=\s*DispatchHandoffGate\./);
  assert.match(srcSource, /private gateStateLocal\(\) \{[\s\S]{0,140}DispatchHandoffGate\.createGate\(\)/);
  assert.match(srcSource, /private targetLeaseTableLocal\(\) \{[\s\S]{0,160}DispatchHandoffGate\.createTargetLeaseTable\(\)/);
  assert.match(srcSource, /const rows = this\.codeSyncTargetResults \|\| \(this\.codeSyncTargetResults = \[\]\);/);
});

test("队列指标字段齐全、有界计数且不给宿主新增跨方法依赖", () => {
  const loadSource = sliceMethod(srcSource, "loadDistributedQueue");
  const saveSource = sliceMethod(srcSource, "saveDistributedQueue");
  // 字节数与条数
  for (const [name, text] of [["load", loadSource], ["save", saveSource]]) {
    assert.match(text, /queueBytes: Number\(bytes \|\| 0\)/, name + " 必须记字节数");
    assert.match(text, /clearedJobs: Array\.isArray\(queue\?\.clearedJobs\) \? queue\.clearedJobs\.length : 0/, name + " 必须记 clearedJobs 条数");
    assert.match(text, /plans: Array\.isArray\(queue\?\.plans\) \? queue\.plans\.length : 0/, name + " 必须记 plans 条数");
    assert.match(text, /metrics\.length > 24\) metrics\.splice\(0, metrics\.length - 24\)/, name + " 只留最近 24 条");
    assert.match(text, /last\.repeats = Number\(last\.repeats \|\| 1\) \+ 1/, name + " 同内容轮次只计数不涨条目");
    assert.doesNotMatch(text, /const record = [\s\S]{0,900}JSON\.stringify/, name + " 记录器不得做全量历史深拷贝");
    assert.doesNotMatch(text, /(?<!typeof Buffer === "undefined" \? \w+\.length : )Buffer\.byteLength/, name + " Buffer 必须带可用件保护");
  }
  // 各阶段耗时
  assert.match(loadSource, /readMs, parseMs, cacheCopyMs, cloneMs/);
  assert.match(loadSource, /cacheHit: true/);
  assert.match(saveSource, /sameContent: true, serializeMs/);
  assert.match(saveSource, /writeMs: Date\.now\(\) - writeStartedAt/);
  assert.match(saveSource, /dispatchAdmission: options\.dispatchAdmission === true/);
  // 同内容空转轮不写盘，只记一条；确实写入时才记 writeMs。
  assert.ok(saveSource.indexOf("sameContent: true") < saveSource.indexOf("let publicationConflict = false;"), "同内容判定在写盘之前");
  // 指标经既有状态通道上报，只取有界最近项，不复制队列内容。
  assert.match(srcSource, /diagnostics\.distributedQueueMetrics = \(this\.distributedQueueMetrics \|\| \[\]\)\.slice\(-24\);/);
  // 指标为纯诊断：不给 “摘出类成员进 VM 宿主” 的用例新增跨方法依赖。
  assert.doesNotMatch(srcSource, /this\.recordDistributedQueueMetricLocal|this\.queueShapeLocal/);
});

test("上传写租约包住真实写入，取消在全部目标收敛后才抛出", () => {
  const sync = sliceMethod(srcSource, "syncCodeTargets");
  assert.match(sync, /await mapLimited\(enabledTargets, 2, async \(target, index\) => \{/);
  assert.match(sync, /const lease = await this\.acquireCodeUploadTargetLeaseLocal\?\.\(target, syncId, undefined, \{ key: targetKey \}\)/);
  // 身份登记与未知写入核实都必须排在等锁之前：否则等待同一目标的别名会被提前放行，
  // 或者重试会等自己必须先查询才能释放的那把锁。
  const noteAt = sync.indexOf("this.noteCodeUploadTargetLocal?.(codeUploadHandoff, root, target.id, targetKey);");
  const takeoverAt = sync.indexOf("await this.takeoverCodeUploadTargetLocal?.(target, targetKey, syncId)");
  const identityAt = sync.indexOf("this.resolveCodeUploadTargetIdentityLocal(target).key");
  const acquireAt = sync.indexOf("await this.acquireCodeUploadTargetLeaseLocal?.(");
  assert.ok(identityAt > 0 && identityAt < noteAt, "先解析真实身份，再登记");
  assert.ok(noteAt > 0 && noteAt < acquireAt, "别名目标键必须在等锁之前就登记");
  assert.ok(takeoverAt > 0 && takeoverAt < acquireAt, "取消并接管（含交出旧租约）必须排在等锁之前");
  // 接管靠“先取消上一份传输、再核实静默”，而且只能走现有 simpleSftpApiCall 通道。
  assert.match(srcSource, /用户重新发起同步，取消上一次传输以接管/, "取消理由必须写清楚");
  assert.match(srcSource, /this\.simpleSftpApiCall\("transfers\.cancel", params\)/, "取消只能走现有 SimpleSFTP 通道");
  assert.match(srcSource, /this\.simpleSftpApiCall\("transfers\.list", \{\}\)/, "核实只靠同一个只读投影");
  // 已被未确认写入围栏的目标必须在任何写入之前退出，否则同批等待者会被同一把保留锁吊死。
  const deferredAt = sync.indexOf("if (!lease.token && lease.deferred) {");
  const uploadAt = sync.indexOf("try { return await uploadOneTarget(target, index, lease, leaseState); }");
  assert.ok(deferredAt > acquireAt && deferredAt < uploadAt, "等锁后拿不到令牌时要先退出，不得进入写入");
  assert.match(sync, /未开始写入，需要主动核实后重试/, "退出结局必须写明未开始、需核实");
  assert.match(sync, /if \(leaseState\.retain && lease\.token\) this\.retainCodeUploadTargetLeaseLocal\?\.\(lease\);\n\s*else this\.releaseCodeUploadTargetLeaseLocal\?\.\(lease\.token\);/,
    "写入结果未知的目标必须保留租约，只有已落定的才放回");
  assert.match(sync, /cancelledBranches\.push\(error\);/);
  const throwAt = sync.indexOf("if (cancelledBranches.length) throw cancelledBranches[0];");
  const mapAt = sync.indexOf("await mapLimited(enabledTargets, 2,");
  // finally 里的意图回收必须在“全部分支收敛”之后；前面那个同名调用属于未接管所有权时的提前撤销。
  const finallyAt = sync.lastIndexOf("this.endCodeUploadHandoffLocal?.(codeUploadHandoff?.uploadId);");
  assert.ok(throwAt > mapAt, "取消必须等 mapLimited 收敛");
  assert.ok(finallyAt > throwAt, "交接所有权必须在收敛之后才释放");
  // 本轮的历史记录覆盖决定必须在本轮结束时作废，且不得插到写锁与发送之间。
  const staleClearAt = sync.lastIndexOf("this.codeUploadStaleRounds?.delete(String(staleRoundKey));");
  const vetoAt = sync.indexOf("staleDecision.approved !== true");
  const stalePrecheckAt = sync.indexOf("collectCodeUploadStaleRecordsLocal?.(enabledTargets, root, syncId");
  assert.ok(stalePrecheckAt > 0 && stalePrecheckAt < mapAt, "覆盖确认必须排在 mapLimited 之前，不得与写入交错");
  // A1：接管即将失败时的“当场补问”也必须排在申请写租约之前——批准之前一把锁也拿不到、一个字节也发不出。
  const lateAskAt = sync.indexOf("codeUploadStaleLateConsentLocal?.(syncId");
  const leaseAskAt = sync.indexOf("acquireCodeUploadTargetLeaseLocal?.(target, syncId");
  assert.ok(lateAskAt > 0 && leaseAskAt > 0 && lateAskAt < leaseAskAt, "当场补问必须排在申请写入租约之前");
  assert.ok(vetoAt > 0 && vetoAt < takeoverAt, "未批准时必须在接管与取锁之前退出：连取消也不发，一字节也发不出");
  assert.ok(staleClearAt > finallyAt, "覆盖决定的清理必须排在交接意图回收之后");
  const tailBlock = sync.slice(finallyAt);
  const tailEndAt = tailBlock.indexOf("endCodeUploadHandoffLocal?.(codeUploadHandoff?.uploadId);");
  const tailClearAt = tailBlock.indexOf("this.codeUploadStaleRounds?.delete(String(staleRoundKey));");
  const tailDecAt = tailBlock.indexOf("this.codeSyncInFlight--;");
  assert.ok(tailEndAt >= 0 && tailClearAt > tailEndAt && tailDecAt > tailClearAt,
    "本轮覆盖决定必须在本轮结束作废，并且排在写计数回收之前");
});

// —— 以下为复审 R3/R4 要求：必须穿过真实上传与重试入口，不允许夹具预置状态或手工恢复。
const realHost = require("../_helpers/realCodeUploadHost.js");

// 等一个真实事件发生（不是计时断言）：真实入口里有本机清单的真磁盘 IO，
// 因此这里用 macrotask 让位给事件循环，只限定“不能无限等”，不对任何耗时作断言。
async function waitUntil(predicate, note) {
  for (let tick = 0; tick < 2000 && !predicate(); tick += 1) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(predicate(), note || "真实入口没有走到预期状态");
}

function workerTarget(id, label, hostName, remotePath) {
  return { id, role: "worker", label, host: hostName, user: "me", port: 22, remotePath };
}

test("别名 Worker 在同一实际目标上排队时，先写完的那个也不能提前接新派发", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj"),
    workerTarget("w-b", "Worker B", "ONE.example", "/work/proj/")];
  const seen = [];
  const gates = { "w-a": deferred(), "w-b": deferred() };
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method !== "upload.workspace") return realHost.quiescedTransferState();
    const id = String(params.targetId);
    seen.push("upload:" + id);
    await gates[id].promise;
    return { ok: true, status: "completed" };
  } });
  const project = host.project;
  assert.equal(host.dispatchTargetKeyLocal("w-a"), host.dispatchTargetKeyLocal("w-b"), "别名必须归并到同一实际写目标");
  const run = host.syncCodeTargets(targets, "run", { hashCompare: true });
  await waitUntil(() => seen.includes("upload:w-a"), "A 未进入真实上传");
  assert.equal(host.dispatchHandoffAllowsWorkerLocal(project, "w-a"), false, "A 正在写入时不得接新派发");
  assert.equal(host.dispatchHandoffAllowsWorkerLocal(project, "w-b"), false, "B 还在同一目标租约上排队时不得接新派发");
  gates["w-a"].resolve();
  // B 只有在 A 真的释放写锁之后才可能进入上传，因此此刻正是“A 已完成、B 仍在写同一 root”的窗口。
  await waitUntil(() => seen.includes("upload:w-b"), "B 未能在 A 释放写锁后进入真实上传");
  const rows = host.dispatchHandoffDiagnosticsLocal().workerUploads;
  const rowA = rows.find(row => row.workerId === "w-a");
  const rowB = rows.find(row => row.workerId === "w-b");
  assert.equal(rowA.state, "uploaded");
  assert.equal(rowB.state, "uploading");
  assert.equal(rowA.targetKey, rowB.targetKey, "两条记录必须挂在同一个实际写目标上");
  assert.equal(host.dispatchHandoffAllowsWorkerLocal(project, "w-a"), false,
    "共享同一 root 的 B 写入仍在进行时，A 不得被提前放行");
  gates["w-b"].resolve();
  await run;
  assert.equal(host.dispatchHandoffAllowsWorkerLocal(project, "w-a"), true, "共享目标本轮全部确认完成后才恢复派发");
  assert.equal(host.dispatchHandoffAllowsWorkerLocal(project, "w-b"), true);
});

test("不同实际 root 的 Worker 写完后照常放行，互斥只按真实目标", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj"),
    workerTarget("w-b", "Worker B", "one.example", "/work/other")];
  const seen = [];
  const gates = { "w-a": deferred(), "w-b": deferred() };
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method !== "upload.workspace") return realHost.quiescedTransferState();
    const id = String(params.targetId);
    seen.push("upload:" + id);
    await gates[id].promise;
    return { ok: true, status: "completed" };
  } });
  const project = host.project;
  const run = host.syncCodeTargets(targets, "run", { hashCompare: true });
  await waitUntil(() => seen.includes("upload:w-a"), "A 未进入真实上传");
  gates["w-a"].resolve();
  // 不同 root 不共锁：A 写完即恢复派发，不必等 B，也不被 B 拖住。
  await waitUntil(() => host.dispatchHandoffAllowsWorkerLocal(project, "w-a"), "不同实际目标的 Worker 被误锁");
  assert.equal(host.dispatchHandoffAllowsWorkerLocal(project, "w-b"), false, "B 自己的写入仍在进行");
  gates["w-b"].resolve();
  await run;
});

test("未知写入的恢复穿过生产重试入口：先核实写操作已收敛并释放旧租约，再取锁重放", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const order = [];
  let rounds = 0;
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") { order.push("verify"); return realHost.quiescedTransferState(); }
    const id = String(params.targetId);
    order.push("upload:" + id + ":" + rounds);
    if (rounds === 0) { rounds = 1; throw new host.UiCommandCancelled("用户在传输中取消"); }
    // 真实写入口：能走到这里，说明上一轮未知写入已被核实并交还所有权。
    assert.equal(host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: id }), undefined,
      "重放写入前必须已经确认上一轮写入结束");
    return { ok: true, status: "completed" };
  } });
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), /用户在传输中取消/);
  const pending = host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" });
  assert.ok(pending, "越界后取消必须保留未知写入身份");
  assert.equal(pending.retainedLease, true, "未知写入的目标租约必须保留");
  // 第二轮走同一个生产入口：不能因为自己在等自己保留的那把锁而卡死。
  await host.syncCodeTargets(targets, "run", { hashCompare: true });
  assert.ok(order.lastIndexOf("verify") > order.indexOf("upload:w-a:0"), "恢复查询必须发生在上一轮写入之后");
  assert.ok(order.indexOf("verify") < order.lastIndexOf("upload:w-a:1"), "必须先核实收敛，再取锁写入");
  assert.equal(host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" }), undefined);
  assert.equal(host.codeSyncInFlight, 0);
});

test("取消被拒或取消后仍不静默时一律不接管：不写入，未知写入与保留租约继续不动", async () => {
  const cases = [
    { name: "身份不符", cancel: () => ({ ok: true, cancelled: false, status: "identityMismatch", settled: false }),
      expect: /identityMismatch/ },
    { name: "cancelled=false", cancel: () => ({ ok: true, cancelled: false, status: "cancelling", settled: false }),
      expect: /取消未被接受/ },
    { name: "取消结果不明确", cancel: () => ({ ok: true, cancelled: true, status: "outcomeUnknown", settled: false }),
      expect: /取消结果不明确/ },
    { name: "取消请求抛错", cancel: () => { throw new Error("RPC 通道断开"); }, expect: /取消上一次传输的请求本身失败/ },
    { name: "取消后仍报活跃", cancel: () => ({ ok: true, cancelled: true, status: "cancelling", settled: true }),
      expect: /已请求取消上一次写入但仍未确认落地/ },
  ];
  for (const item of cases) {
    const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
    const order = [];
    let rounds = 0;
    let stale = false;
    const host = realHost.createRealSyncHost({ targets, upload: async (_host, method) => {
      if (method === "transfers.list") { order.push("verify"); return stale ? realHost.busyTransferState({}, [{ operationId: "op-1" }]) : realHost.quiescedTransferState(); }
      if (method === "transfers.cancel") { order.push("cancel"); return item.cancel(); }
      rounds += 1;
      if (rounds === 1) { stale = true; throw new host.UiCommandCancelled("用户在传输中取消"); }
      order.push("write-again");
      return { ok: true, status: "completed" };
    } });
    const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
    await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), /用户在传输中取消/, item.name);
    await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), item.expect, item.name);
    assert.ok(order.includes("cancel"), item.name + "：按用户要求必须先主动取消上一份传输");
    assert.equal(order.includes("write-again"), false, item.name + "：取消不成功就一条字节也不许写");
    const pending = host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" });
    assert.ok(pending && pending.retainedLease, item.name + "：未知写入与保留租约必须原样保留");
    assert.equal(host.codeUploadTargetLeases.held.size, 1, item.name + "：保留的写锁不能被悄悄放掉");
    assert.equal(host.codeSyncInFlight, 0, item.name + "：本批仍要正常收敛");
  }
});

test("传输查询通道不可用时不接管也不写入，未知写入与保留租约继续不动", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const order = [];
  let rounds = 0;
  let stale = false;
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method) => {
    if (method === "transfers.list") {
      order.push("verify");
      if (rounds >= 1) throw new Error("RPC 超时");
      return realHost.quiescedTransferState();
    }
    if (method === "transfers.cancel") { order.push("cancel"); return { ok: true, cancelled: true, status: "cancelling" }; }
    rounds += 1;
    if (rounds === 1) { stale = true; throw new host.UiCommandCancelled("用户在传输中取消"); }
    order.push("write-again");
    return { ok: true, status: "completed" };
  } });
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), /用户在传输中取消/);
  await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), /查询本身失败.*不会盲目覆盖/s);
  assert.equal(order.includes("cancel"), false, "查不到就不能凭猜测取消");
  assert.equal(order.includes("write-again"), false, "查询不可用时一条字节也不许写");
  const pending = host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" });
  assert.ok(pending && pending.retainedLease, "查询失败同样保留未知写入与目标租约");
  assert.equal(host.codeSyncInFlight, 0);
});

test("A 在途失败、B 已在同一目标等锁：B 以未开始需核实结束，未知写入与保留租约都原样留下", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj"),
    workerTarget("w-b", "Worker B", "ONE.example", "/work/proj/")];
  const order = [];
  const cancels = [];
  const aBroken = deferred();
  let stale = false;
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") { order.push("verify"); return stale ? realHost.busyTransferState({}, [{ operationId: "op-1" }]) : realHost.quiescedTransferState(); }
    if (method === "transfers.cancel") { order.push("cancel"); cancels.push(params); return { ok: true, cancelled: true, status: "cancelling", settled: false }; }
    const id = String(params.targetId);
    order.push("upload:" + id);
    // 越过传输边界后才报错：错误无法被解释成“没开始”，而且传输仍算在本目标头上。
    if (id === "w-a") { await aBroken.promise; stale = true; throw new Error("传输中断：连接被重置"); }
    return { ok: true, status: "completed" };
  } });
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  assert.equal(host.resolveCodeUploadTargetIdentityLocal(targets[1]).key, targetKey, "两个别名必须落在同一实际写目标");
  const run = host.syncCodeTargets(targets, "run", { hashCompare: true });
  // 真实顺序：A 已进传输，B 走到真实租约队列里排队（没有任何预置状态）。
  await waitUntil(() => order.includes("upload:w-a"), "A 未进入真实上传");
  await waitUntil(() => (host.codeUploadTargetLeases.waiters.get(targetKey) || []).length === 1, "B 未在真实目标租约上排队");
  assert.equal(host.codeSyncInFlight, 1, "整批仍在进行中");
  // A 越过传输边界后抛错：登记未知写入并保留租约，而 B 已经挂在这把锁上。
  aBroken.resolve();
  // 死锁回归门：只有 B 能结束本次等待，这里才会返回；整批必须正常失败收敛。
  await assert.rejects(run, /代码同步失败/);
  assert.match(String(host.lastCodeSyncState.error || ""), /Worker B.*未开始写入，需要主动核实后重试/,
    "等待者必须以明确的「未开始、需核实」结束");
  assert.equal(order.includes("upload:w-b"), false, "没拿到写锁就一条字节也不许写");
  assert.equal(host.codeSyncInFlight, 0, "整批收敛后必须释放写入计数，下一次重试才进得来");
  assert.equal((host.codeUploadTargetLeases.waiters.get(targetKey) || []).length, 0, "不得留下空等的排队者");
  const pending = host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" });
  assert.ok(pending, "未知写入记录必须保留");
  assert.equal(pending.workerId, "w-a");
  assert.equal(pending.retainedLease, true, "旧租约必须仍被保留");
  assert.equal(host.codeUploadTargetLeases.held.size, 1, "围栏不等于放锁");
  assert.ok(Gate.targetLeaseFence(host.codeUploadTargetLeases, targetKey), "目标仍应处于未知围栏状态");
  // 下一次重试走真实入口，必须真的进到“先取消上一份传输、再核实静默”的接管分支（而不是被 codeSyncInFlight 挡在门外）。
  await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), /已请求取消上一次写入但仍未确认落地/);
  assert.ok(cancels.length >= 1, "重试必须进到主动取消接管，而不是只查不接");
  assert.ok(cancels.every(row => row.transferId === "t-1"), "取消要用刚才那张传输表里的身份，不自己编");
  assert.equal(order.includes("upload:w-b"), false, "取消未落地前仍然一个字也不写");
  assert.equal(order.filter(row => row.startsWith("upload:")).length, 1, "未确认静默前不得重放");
  const stillPending = host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" });
  assert.ok(stillPending && stillPending.retainedLease, "取消尚未落地时，未知写入与保留租约继续不动");
});

test("A 在传输中取消、B 已在同一目标等锁：取消不把等待者吊死，核实收敛后别名才能正常写入", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj"),
    workerTarget("w-b", "Worker B", "one.example", "/work/proj")];
  const order = [];
  const receipts = [];
  const aCancelled = deferred();
  let writes = 0;
  let stale = false;
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") { order.push("verify"); return stale ? realHost.busyTransferState({}, [{ operationId: "op-1" }]) : realHost.quiescedTransferState(); }
    if (method === "transfers.cancel") { order.push("cancel"); stale = false; return { ok: true, cancelled: true, status: "cancelling", settled: false }; }
    const id = String(params.targetId);
    order.push("upload:" + id);
    // 只有第一次 w-a 写入会被取消；取消落地后重试要能真的重放并推进别名。
    if (id === "w-a" && writes === 0) { writes += 1; stale = true; await aCancelled.promise; throw new host.UiCommandCancelled("用户在传输中取消"); }
    writes += 1;
    return { ok: true, status: "completed" };
  } });
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  const run = host.syncCodeTargets(targets, "run", { hashCompare: true });
  await waitUntil(() => order.includes("upload:w-a"), "A 未进入真实上传");
  await waitUntil(() => (host.codeUploadTargetLeases.waiters.get(targetKey) || []).length === 1, "B 未在真实目标租约上排队");
  aCancelled.resolve();
  // 取消按既有契约等全部分支收敛后才抛；B 不结束这里同样不会返回。
  await assert.rejects(run, /用户在传输中取消/);
  assert.equal(order.includes("upload:w-b"), false, "被围栏的目标上不得开始写入");
  assert.equal(host.codeSyncInFlight, 0, "取消收敛后同样要释放写入计数");
  assert.equal((host.codeUploadTargetLeases.waiters.get(targetKey) || []).length, 0);
  const pending = host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" });
  assert.ok(pending && pending.retainedLease, "越界取消同样保留未知写入与目标租约");
  // 真正交出可接管的证据（上一份传输已被取消且本目标静默）后，围栏与保留租约才交接，别名才能正常写入。
  await host.syncCodeTargets(targets, "run", { hashCompare: true, progressReport: text => receipts.push(text) });
  assert.ok(order.indexOf("cancel") > order.indexOf("upload:w-a"), "重试先取消上一份传输");
  assert.ok(order.lastIndexOf("verify") > order.indexOf("cancel"), "取消后还要再查一次确认静默");
  assert.ok(order.includes("upload:w-b"), "接管完成后别名才能写入");
  assert.ok(receipts.some(text => /上一次传输已被取消并接管/.test(text)), "回执要能看出是取消并接管");
  assert.equal(host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" }), undefined);
  assert.equal(host.codeUploadTargetLeases.held.size, 0, "全部确认完成后不留残留锁");
});

test("上一份传输仍挂在本目标上时先取消再接管：取消身份与理由正确，写入只发生在确认静默之后", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const order = [];
  const cancels = [];
  const receipts = [];
  let rounds = 0;
  let stale = false;
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") {
      order.push("verify");
      return stale ? realHost.busyTransferState({}, [{ operationId: "op-1", operationInstanceId: "instance-real-1" }])
        : realHost.quiescedTransferState();
    }
    if (method === "transfers.cancel") {
      order.push("cancel");
      cancels.push(params);
      stale = false;   // 取消已落地：该目标随后确实静默
      return { ok: true, transferId: String(params.transferId || ""), operationId: String(params.operationId || ""),
        cancelled: true, status: "cancelling", settled: false, operationInstanceId: params.operationInstanceId || "" };
    }
    const id = String(params.targetId);
    order.push("upload:" + id + ":" + rounds);
    if (rounds === 0) { rounds = 1; stale = true; throw new host.UiCommandCancelled("用户在传输中取消"); }
    return { ok: true, status: "completed" };
  } });
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), /用户在传输中取消/);
  const pending = host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" });
  assert.ok(pending && pending.retainedLease, "第一轮越界取消必须留下未知写入与保留租约");
  // 第二轮：上一轮传输仍在本目标上 → 先取消、再核实静默，才允许接管写入。
  await host.syncCodeTargets(targets, "run", { hashCompare: true, progressReport: text => receipts.push(text) });
  assert.equal(cancels.length, 1, "只对要接管的那一项发一次取消，不反复取消");
  assert.equal(cancels[0].transferId, "t-1");
  assert.equal(cancels[0].operationId, "op-1");
  assert.equal(cancels[0].operationInstanceId, "instance-real-1", "取消要带台账实例身份守卫，不自己编一个");
  assert.match(String(cancels[0].reason), /用户重新发起同步，取消上一次传输以接管/);
  assert.ok(order.indexOf("cancel") > order.lastIndexOf("upload:w-a:0"), "取消发生在上一轮写入之后");
  assert.ok(order.lastIndexOf("verify") > order.indexOf("cancel"), "取消之后必须再查一次确认静默");
  assert.ok(order.indexOf("upload:w-a:1") > order.lastIndexOf("verify"), "写入只能发生在确认静默之后");
  assert.ok(receipts.some(text => /上一次传输已被取消并接管/.test(text)), "回执要能看出是取消并接管，不只是错误串");
  assert.equal(host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" }), undefined);
  assert.equal(host.codeUploadTargetLeases.held.size, 0, "接管完成后不留残留锁");
  assert.equal(host.codeSyncInFlight, 0);
});

test("目录存在性查询不再被当成写入收敛证据，核实只认写忙投影", async () => {
  const host = realHost.createRealSyncHost({ targets: [workerTarget("w-a", "Worker A", "one.example", "/work/proj")],
    upload: async (_host, method) => {
      if (method === "transfers.list") return { ok: true, relativePath: ".", exists: true, empty: false };
      throw new Error("unexpected api " + method);
    } });
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(host.targets[0]).key;
  const stale = await host.verifyCodeUploadTargetQuiescentLocal(host.targets[0], targetKey);
  assert.equal(stale.quiescent, false, "缺实例身份与忙投影的返回不能当已收敛");
  assert.equal(stale.evidence, "operation-state-incomplete");
  host.simpleSftpApiCall = async () => { throw new Error("RPC 超时"); };
  const failed = await host.verifyCodeUploadTargetQuiescentLocal(host.targets[0], targetKey);
  assert.equal(failed.quiescent, false);
  assert.equal(failed.evidence, "operation-query-failed");
  host.simpleSftpApiCall = async () => realHost.busyTransferState({ host: "one.example", remotePath: "/work/proj/sub" });
  const active = await host.verifyCodeUploadTargetQuiescentLocal(host.targets[0], targetKey);
  assert.equal(active.quiescent, false);
  assert.equal(active.evidence, "operation-active", "同一 root 子路径上的在途传输同样算未收敛");
  assert.equal(active.rows[0].transferId, "t-1", "未收敛时要交出可取消身份");
  host.simpleSftpApiCall = async () => realHost.busyTransferState({ host: "other.example", remotePath: "/work/proj" });
  const busyElsewhere = await host.verifyCodeUploadTargetQuiescentLocal(host.targets[0], targetKey);
  // 用户已授权：本机台账里的传输都是本插件发起的（别的电脑发起的不会出现在这里），
  // 所以归到其他 Worker 也要当作本插件在传任务取消，不能当没看见。
  assert.equal(busyElsewhere.quiescent, false, "其他 Worker 上本插件发起的未结束传输也必须参与静默判定");
  assert.equal(busyElsewhere.evidence, "operation-active");
  assert.equal(busyElsewhere.rows[0].targetScoped, false, "不是本目标的行要如实标成归属其他 Worker");
  assert.match(busyElsewhere.detail, /归属不明或属于其他 Worker/, "明细要交代清楚这些行到底算谁的");
  host.simpleSftpApiCall = async () => realHost.busyTransferState({ host: "", remotePath: "" });
  const unattributable = await host.verifyCodeUploadTargetQuiescentLocal(host.targets[0], targetKey);
  assert.equal(unattributable.quiescent, false, "缺主机或远端路径的传输仍算本目标未收敛");
  assert.equal(unattributable.evidence, "operation-active");
  assert.equal(unattributable.rows[0].transferId, "t-1", "归属不明但接口能寻址，就要拿已有身份去取消");
  assert.equal(unattributable.rows[0].targetScoped, false, "无法精确归因的行不能谎称是本目标的");
  host.simpleSftpApiCall = async () => realHost.quiescedTransferState();
  const idle = await host.verifyCodeUploadTargetQuiescentLocal(host.targets[0], targetKey);
  assert.equal(idle.quiescent, true);
  assert.equal(idle.evidence, "operation-write-quiesced");
});

test("只在台账里、没有活动传输行的未终结操作也要取消：按台账身份取消→再核实静默→才写入", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const order = [];
  const receipts = [];
  const cancels = [];
  let stale = false;
  let writes = 0;
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") { order.push("verify"); return stale ? realHost.ledgerOnlyTransferState() : realHost.quiescedTransferState(); }
    if (method === "transfers.cancel") {
      order.push("cancel"); cancels.push(params); stale = false;
      return { ok: true, operationId: String(params.operationId || ""), cancelled: true, status: "cancelling", settled: false };
    }
    writes += 1;
    order.push("write:" + writes);
    if (writes === 1) { stale = true; throw new host.UiCommandCancelled("用户在传输中取消"); }
    return { ok: true, status: "completed" };
  } });
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), /用户在传输中取消/);
  // 第二轮：活动传输表是空的，但台账里还挂着一项 outcomeUnknown → 不能当作静默。
  await host.syncCodeTargets(targets, "run", { hashCompare: true, progressReport: text => receipts.push(text) });
  assert.equal(cancels.length, 1, "只剩未终结台账也不能当没看见，要按用户要求取消掉");
  assert.equal(cancels[0].operationId, "op-9", "取消要用台账里已有的 operationId");
  assert.equal(cancels[0].operationInstanceId, "instance-real-1", "台账里有实例身份就原样带上");
  assert.equal(cancels[0].transferId, undefined, "台账项没有活动传输行，不能凭空编一个 transferId");
  assert.ok(order.indexOf("cancel") < order.lastIndexOf("verify"), "取消之后必须再查一次确认静默");
  assert.ok(order.lastIndexOf("verify") < order.lastIndexOf("write:2"), "写入只能发生在确认静默之后");
  assert.ok(receipts.some(text => /含其他 Worker 的未完成上传 1 项/.test(text)),
    "回执要写清取消了本插件的在传任务、其中多少属于其他 Worker，不能只报一个数字");
  assert.equal(host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" }), undefined);
  assert.equal(host.codeSyncInFlight, 0);
});

test("既无 transferId 又无 operationId 的未终结项：取消接口无法寻址——本轮先问一次，没批准零取消零写入，批准才覆盖接管", async () => {
  const buildFixture = () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const order = [];
  let stale = false;
  let writes = 0;
  const hostOptions = { targets, upload: async (_host, method) => {
    if (method === "transfers.list") {
      order.push("verify");
      return stale ? realHost.busyTransferState({ id: "", operationId: "", host: "one.example", remotePath: "/work/proj" })
        : realHost.quiescedTransferState();
    }
    if (method === "transfers.cancel") { order.push("cancel"); return { ok: true, cancelled: true, status: "cancelling", settled: false }; }
    writes += 1;
    order.push("write:" + writes);
    if (writes === 1) { stale = true; throw new host.UiCommandCancelled("用户在传输中取消"); }
    return { ok: true, status: "completed" };
  } };
  const host = realHost.createRealSyncHost(hostOptions);
  return { host, hostOptions, targets, order };
  };
  // 一、没点确认（默认 N）：取消接口寻不到身份的记录必须本轮就问（A1），没批准就保持原有明确失败事实。
  const refused = buildFixture();
  const refusedKey = refused.host.resolveCodeUploadTargetIdentityLocal(refused.targets[0]).key;
  await assert.rejects(refused.host.syncCodeTargets(refused.targets, "run", { hashCompare: true }), /用户在传输中取消/);
  const heldAfterFirstRound = refused.host.codeUploadTargetLeases?.held?.size || 0;
  assert.equal(heldAfterFirstRound, 1, "第一轮被取消的写入必须留下保留租约（这正是本轮要保护的东西）");
  await assert.rejects(refused.host.syncCodeTargets(refused.targets, "run", { hashCompare: true }), /无法寻址/s);
  assert.equal(refused.host.modals.length, 1, "取消接口寻不到身份的记录必须当轮就问，不要求用户先失败一轮（A1）");
  assert.equal(refused.host.modals.length, 1, "取消接口寻不到身份 = 本轮就问一下，不要求用户先失败一轮再重试");
  assert.equal(refused.host.modals[0].modal, true, "必须是原生模态框");
  assert.ok(refused.host.modals[0].detail.includes("取消接口无法寻址的未终结记录"), "确认框要说清为什么救不回来");
  assert.ok(refused.host.modals[0].detail.includes("one.example") && refused.host.modals[0].detail.includes("/work/proj"),
    "确认框必须列出本次实际要覆盖的目标与远端 root");
  assert.equal(refused.order.includes("cancel"), false, "两个可寻址身份都没有：这是取消接口的寻址前提，不是保守选择");
  assert.equal(refused.order.includes("write:2"), false, "没批准就一个字也不写");
  assert.equal(refused.host.codeUploadTargetLeases?.held?.size || 0, heldAfterFirstRound,
    "没批准既不能新拿一把写锁，也不能把保留租约悄悄放掉");
  const pending = refused.host.pendingCodeUploadUnknownWriteLocal(refused.host.project, { targetKey: refusedKey, workerId: "w-a" });
  assert.ok(pending && pending.retainedLease, "无法寻址时未知写入与保留租约继续不动");
  assert.equal(refused.host.codeSyncInFlight, 0, "本批仍要正常收敛");
  // 二、明确批准：仍然一个取消也不发（接口本来寻不到），按本轮确认覆盖接管，回执如实记退出未被确认。
  const approved = buildFixture();
  const approvedKey = approved.host.resolveCodeUploadTargetIdentityLocal(approved.targets[0]).key;
  await assert.rejects(approved.host.syncCodeTargets(approved.targets, "run", { hashCompare: true }), /用户在传输中取消/);
  approved.hostOptions.modalAnswer = "完全覆盖并继续";
  await approved.host.syncCodeTargets(approved.targets, "run", { hashCompare: true });
  assert.equal(approved.host.modals.length, 1, "批准之后不再重复打扰");
  assert.equal(approved.order.includes("cancel"), false, "寻不到身份就不发取消");
  assert.ok(approved.order.includes("write:2"), "批准之后才允许覆盖接管写入");
  const taken = approved.host.codeSyncTargetResults.find(row => row.takeover === "stale-overwrite");
  assert.ok(taken, "必须留下“本轮是覆盖接管”的事实");
  assert.equal(taken.staleAuthorizedBy, "user-modal-approval");
  assert.equal(approved.host.pendingCodeUploadUnknownWriteLocal(approved.host.project, { targetKey: approvedKey, workerId: "w-a" }), undefined,
    "真正接管过之后才释放未知写入所有权");
  assert.equal(approved.host.codeUploadTargetLeases.held.size, 0, "接管完成不留残留写锁");
});

test("归属不明但接口能寻址：拿台账已有的 id 取消，确认静默之后才写入", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const order = [];
  const receipts = [];
  const cancels = [];
  let stale = false;
  let writes = 0;
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") { order.push("verify"); return stale ? realHost.busyTransferState({ host: "", remotePath: "" }, [{ operationId: "op-1" }]) : realHost.quiescedTransferState(); }
    if (method === "transfers.cancel") { order.push("cancel"); cancels.push(params); stale = false; return { ok: true, transferId: "t-1", cancelled: true, status: "cancelling", settled: false }; }
    writes += 1;
    order.push("write:" + writes);
    if (writes === 1) { stale = true; throw new host.UiCommandCancelled("用户在传输中取消"); }
    return { ok: true, status: "completed" };
  } });
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), /用户在传输中取消/);
  await host.syncCodeTargets(targets, "run", { hashCompare: true, progressReport: text => receipts.push(text) });
  assert.equal(cancels.length, 1, "归属不明不阻塞取消：用户要求按本插件发起逐项取消");
  assert.equal(cancels[0].transferId, "t-1", "取消要用刚才那张传输表里的 transferId");
  assert.equal(cancels[0].operationId, "op-1");
  assert.equal(cancels[0].operationInstanceId, "instance-real-1");
  assert.ok(order.lastIndexOf("verify") < order.lastIndexOf("write:2"), "写入只能发生在确认静默之后");
  assert.ok(receipts.some(text => /上一次传输已被取消并接管.*含其他 Worker 的未完成上传 1 项/s.test(text)),
    "回执要把“这些行其实不是本目标的”如实写出来");
  assert.equal(host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" }), undefined);
  assert.equal(host.codeSyncInFlight, 0);
});

test("查询在途期间本轮兄弟刚取锁开始上传：它不是旧传输，零取消请求，排队等到锁后照常写入", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj"),
    workerTarget("w-b", "Worker B", "ONE.example", "/work/proj/")];
  const order = [];
  const cancels = [];
  // 准备期静默；真实写入期间再主动复核同一目标，表中反映本轮兄弟刚启动的传输。
  const firstUploadStarted = deferred();
  const releaseFirstUpload = deferred();
  let listCalls = 0;
  let firstUploader = "";
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") {
      listCalls += 1;
      order.push("list:" + listCalls);
      if (!firstUploader) return realHost.quiescedTransferState();
      // 此时兄弟已经取锁并正在上传：这张表里就是本轮自己刚发起的传输。
      return realHost.busyTransferState({ host: "one.example", remotePath: "/work/proj", operationId: "op-sib" },
        [{ operationId: "op-sib" }]);
    }
    if (method === "transfers.cancel") { order.push("cancel"); cancels.push(params); return { ok: true, cancelled: true, status: "cancelling", settled: false }; }
    const id = String(params.targetId);
    order.push("upload:" + id);
    if (!firstUploader) { firstUploader = id; firstUploadStarted.resolve(); await releaseFirstUpload.promise; }
    return { ok: true, status: "completed" };
  } });
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  assert.equal(host.resolveCodeUploadTargetIdentityLocal(targets[1]).key, targetKey, "两个别名必须落在同一实际写目标");
  const run = host.syncCodeTargets(targets, "run", { hashCompare: true });
  await waitUntil(() => order.includes("upload:" + firstUploader), "没有分支进入真实上传");
  // 后发起核实的一方必须能结束接管判断并排到真实租约队列上，而不是取消自己人。
  await waitUntil(() => (host.codeUploadTargetLeases.waiters.get(targetKey) || []).length === 1, "兄弟未在真实目标租约上排队");
  const syncId = host.codeUploadTargetLeases.held.get(targetKey).ownerId;
  const sibling = targets.find(target => target.id !== firstUploader);
  const receipt = await host.takeoverCodeUploadTargetLocal(sibling, targetKey, syncId);
  assert.equal(receipt.takeover, "sibling", "真实写入期间仍保护同轮兄弟，并在目标租约上排队");
  await waitUntil(() => order.includes("list:2"), "第二个接管核实没发生，竞态窗口没跑到");
  assert.equal(cancels.length, 0, "查询期间新开始的本轮兄弟绝不能被取消");
  releaseFirstUpload.resolve();
  await run;
  assert.ok(order.includes("upload:w-a") && order.includes("upload:w-b"), "两个别名都要写完，接管判断不能掉人");
  assert.equal(cancels.length, 0, "整轮下来一张取消请求也不应发出");
  assert.equal(host.codeUploadTargetLeases.held.size, 0, "全部确认完成后不留残留锁");
  assert.equal(host.codeSyncInFlight, 0);
});

// 以下三条针对必修 A 的“真实接口形状”返修：SimpleSFTP 0.2.114 的 transfers.list 里，
// 纯台账项同时带 id 与 operationId（id 就是 operationId）且没有顶层 host/remotePath，
// 当前上传阶段项只有 {id, stage, startedAt}。两者都不得被漏掉，也不得把 id 当 transferId。
test("真实纯台账形状（id 就是 operationId、没有 host/remotePath）不能被漏判：必须取消并复核静默才接管", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const cancels = [];
  let lists = 0;
  let settled = false;
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") { lists += 1; return settled ? realHost.quiescedTransferState() : realHost.ledgerOnlyTransferState(); }
    if (method === "transfers.cancel") {
      cancels.push(params); settled = true;   // 取消已落地：随后确实静默
      return { ok: true, operationId: String(params.operationId || ""), cancelled: true, status: "cancelling", settled: false };
    }
    return { ok: true, status: "completed" };
  } });
  // 先钉住夹具形状：与审核方直接读到的已安装实现一致，否则这条用例证明不了问题。
  const shape = realHost.ledgerOnlyTransferState();
  assert.equal(shape.transfers.length, 0, "复现场景的活动传输表是空的");
  assert.equal(shape.operations[0].id, shape.operations[0].operationId, "纯台账行的 id 就是 operationId");
  assert.equal(shape.operations[0].host, undefined, "纯台账行没有顶层 host");
  assert.equal(shape.operations[0].remotePath, undefined, "纯台账行没有顶层 remotePath");
  assert.equal(shape.operations[0].status, "outcomeUnknown");
  assert.equal(shape.busy.busy, true);
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  const verify = await host.verifyCodeUploadTargetQuiescentLocal(targets[0], targetKey, "sync-real-shape");
  assert.equal(verify.quiescent, false, "上一笔操作还没终结，绠不能判成静默");
  assert.notEqual(verify.evidence, "operation-write-quiesced");
  assert.equal(verify.evidence, "operation-active");
  assert.ok(verify.pendingOperations >= 1, "未终结台账必须计入待终结操作数，不能报 0");
  assert.equal(verify.rows.length, 1, "纯台账项要作为可取消项交出来");
  assert.equal(verify.rows[0].operationId, "op-9", "操作身份按 operationId 交出去");
  assert.equal(verify.rows[0].transferId, "", "台账项的 id 不是 transferId，不能冒充活动传输");
  const takeover = await host.takeoverCodeUploadTargetLocal(targets[0], targetKey, "sync-real-shape");
  assert.notEqual(takeover.takeover, "idle", "未终结台账不能被当成 idle 直接放行接管");
  assert.equal(takeover.takeover, "cancelled", "必须先取消并确认落地");
  assert.equal(cancels.length, 1, "同一 operationId 的多种形状只取消一次");
  assert.equal(cancels[0].operationId, "op-9", "该带 operationId 就带 operationId");
  assert.equal(cancels[0].transferId, undefined, "不能把 operationId 当 transferId 发给取消接口");
  assert.equal(cancels[0].operationInstanceId, "instance-real-1", "台账里有实例身份就原样带上");
  assert.ok(lists >= 2, "取消之后必须再查一次确认落地");
  assert.equal(host.codeSyncInFlight, 0);
});

test("纯台账形状取消被拒或复核后仍未终结：保留未知写入所有权，一个字节也不写（真实 syncCodeTargets 入口）", async () => {
  const cases = [
    { name: "取消被拒", cancel: () => ({ ok: true, cancelled: false, status: "cancelling", settled: false }), expect: /取消未被接受/ },
    { name: "复核后仍未终结", cancel: () => ({ ok: true, cancelled: true, status: "cancelling", settled: false }), expect: /已请求取消上一次写入但仍未确认落地/ },
  ];
  for (const item of cases) {
    const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
    const order = [];
    let rounds = 0;
    let stale = false;
    const host = realHost.createRealSyncHost({ targets, upload: async (_host, method) => {
      if (method === "transfers.list") { order.push("verify"); return stale ? realHost.ledgerOnlyTransferState() : realHost.quiescedTransferState(); }
      if (method === "transfers.cancel") { order.push("cancel"); return item.cancel(); }
      rounds += 1;
      if (rounds === 1) { stale = true; throw new host.UiCommandCancelled("用户在传输中取消"); }
      order.push("write-again");
      return { ok: true, status: "completed" };
    } });
    const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
    await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), /用户在传输中取消/, item.name);
    await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), item.expect, item.name);
    assert.ok(order.includes("cancel"), item.name + "：真实台账形状下也必须先主动取消");
    assert.equal(order.includes("write-again"), false, item.name + "：取消没落地就一个字节也不许写");
    const pending = host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" });
    assert.ok(pending && pending.retainedLease, item.name + "：未知写入与保留租约必须原样保留");
    assert.equal(host.codeUploadTargetLeases.held.size, 1, item.name + "：保留的写锁不能被悄悄放掉");
    assert.equal(host.codeSyncInFlight, 0, item.name + "：本批仍要正常收敛");
  }
});

test("只有当前上传阶段项（{id, stage}，没有 host/path/status）也不算静默：只按 operationId 取消", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const cancels = [];
  let settled = false;
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") return settled ? realHost.quiescedTransferState() : realHost.uploadPhaseOnlyState();
    if (method === "transfers.cancel") {
      cancels.push(params); settled = true;
      return { ok: true, operationId: String(params.operationId || ""), cancelled: true, status: "cancelling", settled: false };
    }
    return { ok: true, status: "completed" };
  } });
  const shape = realHost.uploadPhaseOnlyState();
  assert.equal(shape.transfers.length, 0);
  assert.equal(shape.operations[0].status, undefined, "阶段项本来就没有 status，不能因此被当成已结束");
  assert.equal(shape.operations[0].host, undefined, "阶段项没有顶层 host");
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  const verify = await host.verifyCodeUploadTargetQuiescentLocal(targets[0], targetKey, "sync-phase-only");
  assert.equal(verify.quiescent, false, "缺主机/路径/状态的阶段项同样不能被漏掉");
  assert.equal(verify.evidence, "operation-active");
  assert.equal(verify.rows[0].operationId, "op-stage-7", "阶段项的 id 就是 operationId");
  assert.equal(verify.rows[0].transferId, "", "阶段项没有传输身份，不能编 transferId");
  assert.equal(verify.rows[0].targetScoped, false, "归不到本目标就要如实标出，供回执区分");
  const takeover = await host.takeoverCodeUploadTargetLocal(targets[0], targetKey, "sync-phase-only");
  assert.notEqual(takeover.takeover, "idle", "阶段项在跑就不是 idle");
  assert.equal(takeover.takeover, "cancelled");
  assert.equal(cancels[0].operationId, "op-stage-7");
  assert.equal(cancels[0].transferId, undefined, "operationId 绠不能当 transferId 发出去");
  assert.match(takeover.detail, /含 1 项其他 Worker 的未完成上传或归属不明的传输/, "归属不明的取消要在回执里如实计数");
});

// 必修 A 返修后新增：不能因为“不带主机/路径的操作项”无法按目标归属，就取消本轮刚启动的并行分支。
// 下面三条都是真实 syncCodeTargets + 真实租约，事件顺序由用例控制，不用计时断言。

/** 真实阶段项形状（只有 {id, stage, startedAt}，没有 operationId/host/remotePath/status）。 */
function phaseOnlyState(writerId, startedAt) {
  const state = realHost.quiescedTransferState();
  state.busy.busy = true;
  state.busy.uploadOperationCount = 1;
  state.busy.uploadOperations = [{ operationId: writerId, stage: "acquiring-lease" }];
  state.operations = [{ id: writerId, stage: "acquiring-lease", startedAt: startedAt || new Date().toISOString() }];
  return state;
}

test("不同 root 并行：A 已取锁在写、只返回阶段项时，B 的接管查询不得取消本轮刚启动的上传", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/projA"),
    workerTarget("w-b", "Worker B", "one.example", "/work/projB")];
  const order = [];
  const cancels = [];
  let writing = "";
  let listCalls = 0;
  let phaseReturned = 0;
  let writerStarted = deferred();
  let releaseWriter = deferred();
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") {
      listCalls += 1;
      order.push("list:" + listCalls);
      // 整批准备期静默；写入开始后的主动接管查询才观察本轮阶段项，不让准备期等待未来写入。
      if (!writing) return realHost.quiescedTransferState();
      phaseReturned += 1;
      return phaseOnlyState("op-current-" + writing);
    }
    if (method === "transfers.cancel") { order.push("cancel"); cancels.push(params); return { ok: true, cancelled: true, status: "cancelling", settled: false }; }
    const id = String(params.targetId);
    order.push("upload:" + id);
    if (!writing) { writing = id; writerStarted.resolve(); await releaseWriter.promise; }
    return { ok: true, status: "completed" };
  } });
  const run = host.syncCodeTargets(targets, "run", { hashCompare: true });
  await waitUntil(() => order.includes("upload:" + writing), "没有分支进入真实上传");
  const writerKey = host.resolveCodeUploadTargetIdentityLocal(targets.find(target => target.id === writing)).key;
  const syncId = host.codeUploadTargetLeases.held.get(writerKey).ownerId;
  const other = targets.find(target => target.id !== writing);
  await host.takeoverCodeUploadTargetLocal(other, host.resolveCodeUploadTargetIdentityLocal(other).key, syncId);
  await waitUntil(() => phaseReturned >= 1, "第二个接管查询没落在写入窗口内，竞态窗口未跑到");
  assert.equal(cancels.length, 0, "查询期间本轮刚启动的上传不得被取消");
  releaseWriter.resolve();
  await run;
  assert.ok(order.includes("upload:w-a") && order.includes("upload:w-b"), "两个 root 都要写完，并行不能退化为串行");
  assert.equal(cancels.length, 0, "整轮下来不能发出任何取消（旧传输本来就没有）");
  assert.equal(host.codeUploadTargetLeases.held.size, 0, "全部确认完成后不留残留锁");
  assert.equal(host.codeSyncInFlight, 0);
});

test("写入窗口内的混合查询：旧阶段项照旧取消并核实，本轮兄弟的阶段项零取消并转入排队", async () => {
  const targetA = workerTarget("w-a", "Worker A", "one.example", "/work/projA");
  const targetB = workerTarget("w-b", "Worker B", "one.example", "/work/projB");
  const oldStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const order = [];
  const cancels = [];
  let oldAlive = true;
  let writing = "";
  const releaseWriter = deferred();
  const host = realHost.createRealSyncHost({ targets: [targetA], upload: async (_host, method, params) => {
    if (method === "transfers.list") {
      order.push("list");
      const state = realHost.quiescedTransferState();
      const operations = [];
      // 本轮 A 已越过真实写入边界后，写入引擎只会给出一个不带主机/路径的阶段项；
      // 同一时刻本目标上还挂着一笔明确比本轮更早的旧阶段项（上一轮未终结，台账独立返回）。
      if (writing && oldAlive) operations.push({ id: "op-old", stage: "acquiring-lease", startedAt: oldStartedAt });
      if (writing) operations.push({ id: "op-current-" + writing, stage: "acquiring-lease", startedAt: new Date().toISOString() });
      state.operations = operations;
      state.busy.busy = operations.length > 0;
      state.busy.uploadOperationCount = operations.length;
      return state;
    }
    if (method === "transfers.cancel") {
      order.push("cancel"); cancels.push(params);
      if (String(params.operationId || "") === "op-old") oldAlive = false;
      return { ok: true, operationId: String(params.operationId || ""), cancelled: true, status: "cancelling", settled: false };
    }
    const id = String(params.targetId);
    order.push("upload:" + id);
    writing = id;
    await releaseWriter.promise;
    return { ok: true, status: "completed" };
  } });
  const keyA = host.resolveCodeUploadTargetIdentityLocal(targetA).key;
  const keyB = host.resolveCodeUploadTargetIdentityLocal(targetB).key;
  assert.notEqual(keyA, keyB, "两个分支必须落在不同实际写目标上（并行要求）");
  const run = host.syncCodeTargets([targetA], "run", { hashCompare: true });
  await waitUntil(() => order.includes("upload:w-a"), "本轮 A 没进入真实上传");
  await waitUntil(() => host.codeUploadTargetLeases.held.get(keyA), "本轮 A 没拿到真实写租约");
  assert.deepEqual(cancels.map(row => String(row.operationId || "")), [], "A 自已在写入窗口前没有任何旧项可取消");
  // 本轮 syncId 从真实租约持有者取，不自己编：保护只能靠“同一个 syncId 正在写”这个事实。
  const syncId = String(host.codeUploadTargetLeases.held.get(keyA).ownerId);
  const receipt = await host.takeoverCodeUploadTargetLocal(targetB, keyB, syncId);
  assert.deepEqual(cancels.map(row => String(row.operationId || "")), ["op-old"],
    "旧阶段项照旧取消，本轮刚启动的兄弟零取消（取消范围不因并行而缩小）");
  assert.equal(cancels.every(row => !String(row.operationId || "").startsWith("op-current-")), true,
    "本轮刚启动的兄弟绝不能被取消");
  assert.equal(receipt.takeover, "sibling", "取消完旧项后剩下的就是本轮兄弟，只能排队等锁");
  assert.deepEqual(receipt.cancelled, ["op-old"], "回执要把真正取消的旧项列出来");
  releaseWriter.resolve();
  await run;
  assert.ok(order.includes("upload:w-a"), "本轮 A 自己照常写完");
  assert.equal(host.codeUploadTargetLeases.held.size, 0, "收敛后不留残留锁");
  assert.equal(host.codeSyncInFlight, 0);
});

test("本轮没在写时旧阶段项照旧取消并核实；取消被拒时未知写入、保留租约与围栏继续保留", async () => {
  const oldStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const build = cancelReceipt => {
    const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
    const order = [];
    const cancels = [];
    let oldAlive = false;
    let rounds = 0;
    const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
      if (method === "transfers.list") {
        order.push("verify");
        const state = realHost.quiescedTransferState();
        if (oldAlive) {
          // 与已安装实现一致：纯阶段项只有 {id, stage, startedAt}，没有主机/路径/status。
          state.operations = [{ id: "op-old", stage: "acquiring-lease", startedAt: oldStartedAt }];
          state.busy.busy = true;
          state.busy.uploadOperationCount = 1;
        }
        return state;
      }
      if (method === "transfers.cancel") {
        order.push("cancel"); cancels.push(params);
        if (cancelReceipt.lands) oldAlive = false;
        return cancelReceipt;
      }
      rounds += 1;
      if (rounds === 1) { oldAlive = true; throw new host.UiCommandCancelled("用户在传输中取消"); }
      order.push("write-again");
      return { ok: true, status: "completed" };
    } });
    return { host, targets, order, cancels };
  };
  // 一、本轮没在写入：旧阶段项不得被重新漏判为静默，必须取消→再核实静默→才写入。
  const ok = build({ ok: true, operationId: "op-old", cancelled: true, status: "cancelling", settled: false, lands: true });
  await assert.rejects(ok.host.syncCodeTargets(ok.targets, "run", { hashCompare: true }), /用户在传输中取消/);
  await ok.host.syncCodeTargets(ok.targets, "run", { hashCompare: true });
  assert.equal(ok.cancels.length, 1, "旧阶段项也要按 operationId 取消");
  assert.equal(ok.cancels[0].operationId, "op-old");
  assert.equal(ok.cancels[0].transferId, undefined, "阶段项没有传输身份，不能编 transferId");
  assert.ok(ok.order.lastIndexOf("verify") > ok.order.indexOf("cancel"), "取消之后必须再查一次确认静默");
  assert.ok(ok.order.includes("write-again"), "旧操作确认结束后才能写");
  const okKey = ok.host.resolveCodeUploadTargetIdentityLocal(ok.targets[0]).key;
  assert.equal(ok.host.pendingCodeUploadUnknownWriteLocal(ok.host.project, { targetKey: okKey, workerId: "w-a" }), undefined,
    "已落定就不得遗留伪未知记录");
  // 二、取消被拒：不写一字节，未知写入、保留租约与写入围栏都继续保留。
  const bad = build({ ok: true, operationId: "op-old", cancelled: false, status: "cancelling", settled: false, lands: false });
  await assert.rejects(bad.host.syncCodeTargets(bad.targets, "run", { hashCompare: true }), /用户在传输中取消/);
  const targetKey = bad.host.resolveCodeUploadTargetIdentityLocal(bad.targets[0]).key;
  await assert.rejects(bad.host.syncCodeTargets(bad.targets, "run", { hashCompare: true }), /取消未被接受/);
  assert.equal(bad.order.includes("write-again"), false, "取消没落地就一个字节也不写");
  const pending = bad.host.pendingCodeUploadUnknownWriteLocal(bad.host.project, { targetKey, workerId: "w-a" });
  assert.ok(pending && pending.retainedLease, "未知写入与保留租约必须原样保留");
  assert.equal(bad.host.codeUploadTargetLeases.held.size, 1, "保留的写锁不能被悄悄放掉");
  const fenced = await bad.host.acquireCodeUploadTargetLeaseLocal(bad.targets[0], "another-sync", undefined, { key: targetKey });
  assert.ok(!fenced.token && fenced.deferred, "该写目标仍被未确认写入围栏拦住，新意图不能直接写入");
  assert.equal(bad.host.codeSyncInFlight, 0, "本批仍要正常收敛");
});

// 审核方复现键 mixed-old-not-settled-and-current-sibling：取消接口接受请求但旧传输始终不落地，
// 同时本目标上还挂着本轮兄弟刚启动的阶段项。此时只能按“未落地”明确失败，
// 不能因为“剩下的阻塞都是本轮兄弟”就把复核当作静默放行：不同 root 的新分支不等兄弟，
// 申请的是自己那把锁，旧传输还在写就会开新写入。
test("混合复核：旧传输接受取消但始终不落地的同时还有本轮阶段项时，本轮兄弟零取消、该分支零写入、原有未知记录与保留租约不被清除", async () => {
  const oldStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const build = withRetainedPrelude => {
    const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/projA"),
      workerTarget("w-b", "Worker B", "two.example", "/work/projB")];
    const order = [];
    const cancels = [];
    let writing = "";
    let listCalls = 0;
    let prelude = withRetainedPrelude;
    const releaseWriter = deferred();
    const host = realHost.createRealSyncHost({ targets, upload: async (_host, method, params) => {
      if (method === "transfers.list") {
        listCalls += 1;
        order.push("list");
        const state = realHost.quiescedTransferState();
        // 由真实写入事件引入旧项与本轮阶段项，不再依赖准备期查询次数。
        if (!prelude && writing) {
          const operations = [{ id: "op-old-still-running", operationId: "op-old-still-running",
            status: "uploading", startedAt: oldStartedAt }];
          if (writing) {
            operations.push({ id: "op-current-" + writing, stage: "acquiring-lease",
              startedAt: new Date().toISOString() });
          }
          state.operations = operations;
          state.busy.busy = true;
          state.busy.uploadOperationCount = operations.length;
        }
        return state;
      }
      if (method === "transfers.cancel") {
        order.push("cancel");
        cancels.push(params);
        // 取消被接受但始终不落地：旧项在每一次复核里都还在列表上，绝不自己把它删掉。
        return { ok: true, operationId: String(params.operationId || ""), cancelled: true,
          status: "cancelling", settled: false };
      }
      if (prelude) {
        // 上一轮：越写越后被用户取消 → 两个实际目标都留下未知写入、保留租约与写入围栏。
        throw new host.UiCommandCancelled("用户在传输中取消");
      }
      const id = String(params.targetId);
      order.push("upload:" + id);
      if (!writing) { writing = id; await releaseWriter.promise; }
      return { ok: true, status: "completed" };
    } });
    return {
      host, targets, order, cancels, releaseWriter,
      get listCalls() { return listCalls; },
      keys: targets.map(item => host.resolveCodeUploadTargetIdentityLocal(item).key),
      enterMixedRound() { prelude = false; listCalls = 0; },
    };
  };

  const runCase = async withRetainedPrelude => {
    const fixture = build(withRetainedPrelude);
    assert.notEqual(fixture.keys[0], fixture.keys[1], "两个分支必须落在不同实际写目标上（并行要求）");
    if (withRetainedPrelude) {
      await assert.rejects(fixture.host.syncCodeTargets(fixture.targets, "prelude", { hashCompare: true }),
        /用户在传输中取消/);
      assert.equal(fixture.host.codeUploadTargetLeases.held.size, 2, "两个目标都应留下保留租约");
    }
    fixture.enterMixedRound();
    // A 穿过真实上传入口，B 在 A 的真实写入窗口内调用原生产接管方法。
    // 新整批确认屏障不再允许靠同批 B 的未完成确认来制造 A 先写的窗口。
    const run = fixture.host.syncCodeTargets([fixture.targets[0]], "mixed", { hashCompare: true });
    await waitUntil(() => fixture.order.includes("upload:" + fixture.targets[0].id), "A 没有进入真实上传");
    const failTarget = fixture.targets[1];
    const syncId = fixture.host.codeUploadTargetLeases.held.get(fixture.keys[0]).ownerId;
    const receipt = await fixture.host.takeoverCodeUploadTargetLocal(failTarget, fixture.keys[1], syncId);
    assert.equal(receipt.quiescent, false, "旧传输未落地不得转成静默");
    assert.equal(receipt.takeover, "still-active", "混合复核不能因只剩兄弟阻塞项就转为排队放行");
    assert.match(receipt.detail, /仍未确认落地/);
    const started = fixture.order.filter(row => row.startsWith("upload:"));
    assert.equal(started.length, 1,
      `旧传输接受取消但仍在列表时，混合复核的分支一个字节也不能写（实际事件：${fixture.order.join(" | ")}）`);
    const writerId = started[0].slice("upload:".length);
    assert.notEqual(failTarget.id, writerId);
    assert.ok(failTarget, "必须存在走混合复核路径的那个分支");
    fixture.releaseWriter.resolve();
    await run;
    const uploads = [...new Set(fixture.order.filter(row => row.startsWith("upload:")))];
    assert.equal(uploads.length, 1, "混合复核的分支一个字节也不能写");
    assert.equal(fixture.order.includes("upload:" + failTarget.id), false,
      "旧传输仍在列表时，新分支不能先开新写入");
    assert.deepEqual(fixture.cancels.map(row => String(row.operationId || "")), ["op-old-still-running"],
      "只允许按旧传输自己的 operationId 取消一次");
    assert.equal(fixture.cancels.every(row => !String(row.operationId || "").startsWith("op-current-")), true,
      "本轮兄弟的阶段项零取消");
    assert.equal(fixture.cancels.every(row => row.transferId === undefined), true,
      "旧项没有传输身份就不能编造 transferId");
    assert.ok(fixture.order.lastIndexOf("list") > fixture.order.indexOf("cancel"), "取消之后必须再复核");
    assert.equal(fixture.host.codeSyncInFlight, 0, "本批仍要正常收敛");
    return { fixture, failTarget };
  };

  // 一、没有本地保留租约时（审核方复现的形态）：旧项不落地就只能失败，不能写。
  const bare = await runCase(false);
  assert.equal(bare.fixture.host.codeUploadTargetLeases.held.size, 0, "失败的接管不得留下任何写锁");
  // 二、两个目标本来就带着上一轮未确认写入的保留租约与围栏：混合复核失败不能把它们抹掉。
  const fenced = await runCase(true);
  const failKey = fenced.fixture.host.resolveCodeUploadTargetIdentityLocal(fenced.failTarget).key;
  const pending = fenced.fixture.host.pendingCodeUploadUnknownWriteLocal(fenced.fixture.host.project,
    { targetKey: failKey, workerId: fenced.failTarget.id });
  assert.ok(pending && pending.retainedLease, "未知写入所有权与保留租约必须原样保留");
  assert.equal(fenced.fixture.host.codeUploadTargetLeases.held.size, 1, "只剩那个未确认目标的围栏锁");
  assert.ok(fenced.fixture.host.codeUploadTargetLeases.held.has(failKey), "未确认目标的保留租约不得被释放");
  const retry = await fenced.fixture.host.acquireCodeUploadTargetLeaseLocal(fenced.failTarget, "another-sync",
    undefined, { key: failKey });
  assert.ok(!retry.token && retry.deferred, "该写目标仍被未确认写入围栏拦住，新意图不能直接写入");
  assert.equal(fenced.fixture.host.codeSyncInFlight, 0);
});

// —— Round 9：历史“取消也救不回来”的未知记录不能永远挡住新上传。
// 规格：严格超过 3 小时按用户长期授权直接过期接管；3 小时以内、时间缺失/非法/来自未来，
// 必须先过一次原生模态框，一个框列全本批待覆盖目标；明确批准之后才允许新写租约与发送。
// 下面每个用例都走真实 syncCodeTargets + 真实租约 + 真实未知写入登记，不预置状态、不做计时断言。

const HOUR_MS = 60 * 60 * 1000;

/** 多项未终结台账的真实形状：每项都是 { id: operationId, operationId, ... }，没有顶层 host/remotePath。 */
function staleLedgerState(operations) {
  const state = realHost.quiescedTransferState();
  state.busy.busy = true;
  state.busy.uploadOperationCount = operations.length;
  state.busy.uploadOperations = operations.map(row => ({ operationId: row.operationId, status: row.status }));
  state.operations = operations.map(row => ({ id: row.operationId, operationId: row.operationId,
    operationInstanceId: "instance-real-1", status: row.status, startedAt: new Date().toISOString(),
    recovery: null, childCount: 1, ...row }));
  return state;
}

/**
 * “取消也救不回来”的夹具：台账里留一条 outcomeUnknown 的旧项，对它发取消永远只回一个 outcomeUnknown。
 * `startedAt` 与 `operations` 都由用例在轮次之间直接改，用来区分“已过 3 小时”与“还没到 3 小时”。
 */
function createStaleRound(options = {}) {
  const targets = options.targets || [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const state = { order: [], cancels: [], uploads: [], stale: options.stale !== false,
    startedAt: new Date().toISOString(), operations: [{ operationId: "op-stale-unknown", status: "outcomeUnknown" }],
    failFirstUpload: options.failFirstUpload === true, writeCalls: 0 };
  const hostOptions = { targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") {
      state.order.push("list");
      if (!state.stale) return realHost.quiescedTransferState();
      return staleLedgerState(state.operations.map(row => ({ ...row, startedAt: state.startedAt })));
    }
    if (method === "transfers.cancel") {
      state.order.push("cancel:" + String(params.operationId || params.transferId || ""));
      state.cancels.push(params);
      return { ok: true, cancelled: false, status: "outcomeUnknown", settled: false,
        operationId: String(params.operationId || ""), instanceId: "instance-real-1" };
    }
    state.order.push("upload:" + String(params.targetId));
    state.uploads.push(String(params.targetId));
    state.writeCalls += 1;
    if (state.failFirstUpload && state.writeCalls === 1) { state.stale = true; throw new fixture.host.UiCommandCancelled("用户在传输中取消"); }
    return { ok: true, status: "completed" };
  } };
  const fixture = { targets, state, hostOptions, host: null };
  fixture.host = realHost.createRealSyncHost(hostOptions);
  return fixture;
}

test("超过 3 小时的未知记录：不弹框、按长期授权直接过期接管，回执如实记未确认落地与被忽略记录的本地时间", async () => {
  const fixture = createStaleRound({ failFirstUpload: true, stale: false });
  const host = fixture.host;
  const targetKey = host.resolveCodeUploadTargetIdentityLocal(fixture.targets[0]).key;
  await assert.rejects(host.syncCodeTargets(fixture.targets, "run", { hashCompare: true }), /用户在传输中取消/);
  const left = host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" });
  assert.ok(left && left.retainedLease, "第一轮必须真实留下未知写入与保留租约，不能假干净");
  // 把台账项的创建时间挪到 4 小时前：严格超过 3 小时，按用户长期授权直接过期，不需要点按钮。
  fixture.state.startedAt = new Date(Date.now() - 4 * HOUR_MS).toISOString();
  await host.syncCodeTargets(fixture.targets, "run", { hashCompare: true });
  assert.equal(host.modals.length, 0, "严格超过 3 小时的记录不得再弹框打扰用户");
  assert.deepEqual([...new Set(fixture.state.cancels.map(row => String(row.operationId || "")))], ["op-stale-unknown"],
    "取消范围不回退：仍按台账自带的 operationId 取消，不编造 transferId");
  assert.equal(fixture.state.cancels.every(row => row.transferId === undefined), true, "台账项没有传输身份，一个 transferId 也不能编");
  assert.ok(fixture.state.order.includes("upload:w-a"), "过期记录不能永久挡住新上传");
  const facts = host.facts.join("\n");
  assert.match(facts, /已超过 3 小时/, "回执要写清是哪一类授权");
  assert.match(facts, /退出从未被确认落地/, "过期接管不等于证明旧传输已停止");
  assert.match(facts, /不声称远端目录已干净/);
  const record = host.codeSyncTargetResults.find(row => row.takeover === "stale-overwrite");
  assert.ok(record, "必须留下“本轮是覆盖接管”的事实");
  assert.equal(record.staleAuthorizedBy, "expired-over-3h");
  assert.equal(record.staleIgnored, 1, "回执要如实记下被忽略的条数");
  assert.equal((record.staleIgnoredAts || []).length, 1, "被忽略记录的本地时间必须留下");
  assert.equal(host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey, workerId: "w-a" }), undefined,
    "真正接管过之后才允许释放未知写入所有权");
  assert.equal(host.codeUploadTargetLeases.held.size, 0, "接管完成不留残留写锁");
  assert.equal(host.codeUploadStaleSuspects.size, 0, "已接管的记录必须从提示台账摘掉，下一轮不能再拿它弹框");
  assert.equal(host.codeSyncInFlight, 0);
});

test("还没到 3 小时的未知记录：第一次点击就在本轮弹一个模态框，批准之后同一轮才取新写租约与发送", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/projA"),
    workerTarget("w-b", "Worker B", "two.example", "/work/projB")];
  const fixture = createStaleRound({ targets });
  const host = fixture.host;
  fixture.state.startedAt = new Date(Date.now() - 2 * HOUR_MS).toISOString();
  // A1（本轮返修）：第一次点击就要能问清并继续，绝不允许“必须先失败一轮、再点第二次”。
  fixture.hostOptions.modalAnswer = () => "完全覆盖并继续";
  await host.syncCodeTargets(targets, "run", { hashCompare: true });
  assert.equal(host.modals.length, 1, "第一次遇到就要当轮问一次，且整批只弹一个框");
  assert.deepEqual([...new Set(fixture.state.uploads)].sort(), ["w-a", "w-b"], "批准之后同一轮就要把两个目标都写完");
  const approvedModal = host.modals[0];
  assert.ok(approvedModal.detail.includes("还没到 3 小时"), "正文要说清为什么要问");
  assert.ok(approvedModal.detail.includes("op-stale-unknown"), "清单必须带操作身份");
  assert.ok(approvedModal.detail.includes("one.example") && approvedModal.detail.includes("two.example"),
    "清单必须列出本批全部实际目标主机（面板上原本看不到）");
  assert.ok(approvedModal.detail.includes("/work/projA") && approvedModal.detail.includes("/work/projB"),
    "一个框就要列全本批所有远端 root");
  assert.equal(host.codeSyncInFlight, 0);

  // 单目标形态：弹框那一刻必须一把新写租约也没拿到、一个字节也没发出去（顺序硬证据）。
  const solo = createStaleRound({});
  solo.state.startedAt = new Date(Date.now() - 2 * HOUR_MS).toISOString();
  const heldAtModal = [];
  const uploadsAtModal = [];
  solo.hostOptions.modalAnswer = () => {
    heldAtModal.push(solo.host.codeUploadTargetLeases?.held?.size || 0);
    uploadsAtModal.push(solo.state.uploads.length);
    return "完全覆盖并继续";
  };
  await solo.host.syncCodeTargets(solo.targets, "run", { hashCompare: true });
  assert.deepEqual(heldAtModal, [0], "弹框决定时一把新写租约也不能拿到");
  assert.deepEqual(uploadsAtModal, [0], "弹框决定时一个字节也还没发出去");
  assert.equal(solo.host.modals.length, 1, "单个目标也只弹一个框");
  const modal = host.modals[0];
  assert.equal(modal.message, "存在未完成传输，是否完全覆盖后继续？", "标题按用户确认的文案");
  assert.equal(modal.modal, true, "必须是原生模态框，不是右下角通知");
  assert.deepEqual(modal.buttons, ["完全覆盖并继续", "不覆盖，本轮停止"], "按钮文案与顺序不许改");
  assert.equal(host.codeUploadTargetLeases.held.size, 0, "接管完成不留残留写锁");
});

test("选“不覆盖，本轮停止”或关掉模态框：整批零新租约零发送，原有保护一条不少", async () => {
  const cases = [
    { name: "明确不覆盖", answer: "不覆盖，本轮停止", expect: /用户选择不覆盖/ },
    { name: "关掉模态框", answer: undefined, expect: /用户未确认/ },
  ];
  for (const item of cases) {
    const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/projA"),
      workerTarget("w-b", "Worker B", "two.example", "/work/projB")];
    const fixture = createStaleRound({ targets });
    const host = fixture.host;
    fixture.state.startedAt = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    // A1：第一次点击就要问；这里第一次就把“不覆盖/关掉框”的答案摆好，验证本轮就地停下。
    fixture.hostOptions.modalAnswer = item.answer;
    await assert.rejects(host.syncCodeTargets(targets, "run", { hashCompare: true }), item.expect, item.name);
    assert.equal(host.modals.length, 1, item.name + "：本轮就问一次，不多问也不留到下一轮");
    assert.equal(fixture.state.uploads.length, 0, item.name + "：未批准就一字节也不发");
    assert.equal(host.codeUploadTargetLeases?.held?.size || 0, 0, item.name + "：未批准不得拿任何写锁");
    for (const target of targets) {
      const key = host.resolveCodeUploadTargetIdentityLocal(target).key;
      assert.equal(host.pendingCodeUploadUnknownWriteLocal(host.project, { targetKey: key, workerId: target.id }), undefined,
        item.name + "：本轮本来就没有新写入，也不得凭空造一个");
    }
    assert.equal(host.codeUploadStaleSuspects.size, 2, item.name + "：未批准的记录必须还在那里，下一轮继续问");
    // 拒绝不是永久豁免：下一轮重新问一次，批准后才能接管。
    fixture.hostOptions.modalAnswer = "完全覆盖并继续";
    await host.syncCodeTargets(targets, "run", { hashCompare: true });
    assert.equal(host.modals.length, 2, item.name + "：下一轮必须重新问一次（整批仍然只有一个框），不能记住上次的选择");
    assert.deepEqual([...new Set(fixture.state.uploads)].sort(), ["w-a", "w-b"], item.name + "：批准之后仍能正常接管");
  }
});

test("时间边界与异常时间：3 小时以内或时间缺失/非法/来自未来一律不得自动过期", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const now = Date.now();
  const cases = [
    { name: "差 5 秒到 3 小时", startedAtMs: now - 3 * HOUR_MS + 5000, expired: false },
    { name: "创建时间缺失", startedAtMs: undefined, expired: false },
    { name: "创建时间来自未来", startedAtMs: now + HOUR_MS, expired: false },
    { name: "超过 3 小时一秒", startedAtMs: now - 3 * HOUR_MS - 1000, expired: true },
  ];
  // A1 之后分类只能来自本轮实时投影（内存提示表不再驱动确认框）：这里如实造出四项未终结台账项。
  const operations = cases.map((item, index) => ({
    id: "op-boundary-" + index, operationId: "op-boundary-" + index, operationInstanceId: "instance-real-1",
    status: "outcomeUnknown", childCount: 1,
    ...(item.startedAtMs === undefined ? {} : { startedAt: new Date(item.startedAtMs).toISOString() }),
  }));
  const host = realHost.createRealSyncHost({ targets, upload: async (_host, method) => {
    if (method === "transfers.list") {
      const state = realHost.quiescedTransferState();
      state.busy.busy = true;
      state.busy.uploadOperationCount = operations.length;
      state.busy.uploadOperations = operations.map(row => ({ operationId: row.operationId, status: row.status }));
      state.operations = operations;
      return state;
    }
    return { ok: true, status: "completed" };
  } });
  const summary = await host.collectCodeUploadStaleRecordsLocal(targets, host.project, "sync-boundary");
  assert.equal(summary.expired.length, 1, "只有严格超过 3 小时的那一条可以自动过期");
  assert.equal(summary.needsConsent.length, 3, "3 小时以内与异常时间都必须问用户");
  const byIdentity = new Map(summary.needsConsent.map(row => [row.identity, row]));
  assert.equal(byIdentity.get("op-boundary-0").anomalous, false, "时间正常的不算异常");
  assert.equal(byIdentity.get("op-boundary-1").anomalous, true, "创建时间缺失要标异常");
  assert.equal(byIdentity.get("op-boundary-2").anomalous, true, "创建时间来自未来要标异常，不得当成过期");
  assert.equal(byIdentity.get("op-boundary-3"), undefined, "异常与未到点的一律不得当成已过期");
  assert.equal(summary.expired[0].identity, "op-boundary-3");
  // 边界本身只能是“严格大于”：正好 3 小时不算超过，这条只能钉在生产常量与比较符上。
  assert.match(srcSource, /const CODE_UPLOAD_STALE_OPERATION_AGE_MS = 3 \* 60 \* 60 \* 1000;/);
  assert.match(srcSource, /age > CODE_UPLOAD_STALE_OPERATION_AGE_MS/);
});

test("批准之后发送前重查发现新记录：本轮停下、不弹第二个框，重新确认后列出全部记录才写入", async () => {
  const fixture = createStaleRound({});
  const host = fixture.host;
  fixture.state.startedAt = new Date(Date.now() - 2 * HOUR_MS).toISOString();
  let askedOnce = false;
  fixture.hostOptions.modalAnswer = (modal) => {
    if (!askedOnce) {
      askedOnce = true;
      // 用户批准时清单里只有 op-stale-unknown；之后才冒出一条没列过的未终结记录。
      assert.ok(!modal.detail.includes("op-late-unknown"), "批准时清单里不该有后来才出现的记录");
      fixture.state.operations = [...fixture.state.operations,
        { operationId: "op-late-unknown", status: "outcomeUnknown" }];
    }
    return "完全覆盖并继续";
  };
  await assert.rejects(host.syncCodeTargets(fixture.targets, "run", { hashCompare: true }),
    /还没拿到本轮明确批准（op-late-unknown）|没列出过的未完成记录/);
  assert.equal(host.modals.length, 1, "批准之后本轮绝不再弹第二个模态框");
  assert.equal(fixture.state.uploads.length, 0, "范围变了就停下，一字节也不写");
  // 重新发起：新记录已被记成救不回来的历史项，两条都列出来之后才能覆盖。
  await host.syncCodeTargets(fixture.targets, "run", { hashCompare: true });
  assert.equal(host.modals.length, 2, "下一轮重新问一次");
  assert.ok(host.modals[1].detail.includes("op-late-unknown") && host.modals[1].detail.includes("op-stale-unknown"),
    "重新确认的框必须把两条都列出来");
  assert.ok(fixture.state.uploads.includes("w-a"), "重新确认后必须能正常接管，不能永久卡死");
  assert.equal(host.codeSyncInFlight, 0);
});


test("整批覆盖确认屏障：A 静默、B 年轻未知，等待/拒绝/关闭时所有目标零锁零发送，批准后仍并行上传", async () => {
  for (const answer of ["不覆盖，本轮停止", undefined, "完全覆盖并继续"]) {
    const watch = recorder(), modal = deferred(), finishUploads = deferred();
    const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/projA"),
      workerTarget("w-b", "Worker B", "two.example", "/work/projB")];
    let queriedWorker = "", youngOperationObserved = false;
    const uploads = [];
    const options = { targets, modalAnswer: () => { watch.record("modal"); return modal.promise; },
      upload: async (_host, method, params) => {
        if (method === "transfers.list") {
          const projection = realHost.quiescedTransferState();
          // A 保持静默；首次主动查询 B 时出现年轻未知项，不按内部查询次数推测目标。
          if (queriedWorker === "w-b") youngOperationObserved = true;
          if (youngOperationObserved) projection.operations = [{ id: "op-b-young", operationId: "op-b-young",
            operationInstanceId: "instance-real-1", status: "outcomeUnknown", childCount: 0,
            startedAt: new Date(Date.now() - 60 * 1000).toISOString() }];
          return projection;
        }
        if (method === "transfers.cancel") return { ok: true, cancelled: false, status: "outcomeUnknown" };
        assert.equal(method, "upload.workspace");
        uploads.push(params.targetId); watch.record("upload:" + params.targetId);
        await finishUploads.promise;
        return { ok: true, status: "completed" };
      } };
    const host = realHost.createRealSyncHost(options);
    const query = host.verifyCodeUploadTargetQuiescentLocal.bind(host);
    host.verifyCodeUploadTargetQuiescentLocal = (target, ...args) => { queriedWorker = target.id; return query(target, ...args); };
    const run = host.syncCodeTargets(targets, "run", { hashCompare: true });
    run.catch(() => {});
    try {
      await watch.once("modal");
      assert.equal(host.codeUploadTargetLeases?.held?.size || 0, 0, "确认等待时整批不能取得任何新写租约");
      assert.deepEqual(uploads, [], "A 静默也必须等待 B 的确认，不得先发送");
      modal.resolve(answer);
      if (answer === "完全覆盖并继续") {
        await Promise.all([watch.once("upload:w-a"), watch.once("upload:w-b")]);
        assert.deepEqual(new Set(uploads), new Set(["w-a", "w-b"]), "批准后两个上传都能进入，无需等待另一上传完成");
        finishUploads.resolve();
        await run;
      } else {
        await assert.rejects(run, /未获覆盖确认|用户未确认|用户选择不覆盖/);
        assert.deepEqual(uploads, [], "拒绝或关闭必须保持整批零发送");
        assert.equal(host.codeUploadTargetLeases?.held?.size || 0, 0);
      }
      assert.equal(host.modals.length, 1, "整批只询问一次");
    } finally {
      modal.resolve("不覆盖，本轮停止"); finishUploads.resolve();
      await run.catch(() => {});
    }
  }
});

// —— Round 12 返修补测：审核清单 1~6（全部走真实 syncCodeTargets / 真实生产方法入口，不做计时断言）
// 规格：A1 第一次点击就在本轮问；A2 覆盖判定看“实时仍未完成的全部非兄弟记录”，已接受取消不算退出；
// A3 批准清单一条不漏、批准绑定身份+实例+发起时间+冻结范围、归属不完整就写“归属未知”。

/** 可注入的“未终结台账”夹具：每项只给 operationId / 创建时间 / 台账实例身份，取消结果由 cancelFor 决定。 */
function createLedgerRound(options) {
  const targets = options.targets || [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const operations = options.operations;
  const cancelFor = options.cancelFor || (params => ({ ok: true, operationId: String(params.operationId || ""),
    status: "outcomeUnknown", settled: false, cancelled: false }));
  const state = { order: [], cancels: [], uploads: [] };
  const hostOptions = { targets, upload: async (_host, method, params) => {
    if (method === "transfers.list") {
      state.order.push("list");
      const projection = realHost.quiescedTransferState();
      projection.operations = operations.map(row => ({ id: row.operationId, operationId: row.operationId,
        operationInstanceId: row.instanceId || "instance-real-1", status: row.status || "outcomeUnknown", childCount: 1,
        ...(row.startedAtMs === undefined ? {} : { startedAt: new Date(row.startedAtMs).toISOString() }) }));
      projection.busy.busy = true;
      projection.busy.uploadOperationCount = projection.operations.length;
      projection.busy.uploadOperations = projection.operations.map(row => ({ operationId: row.operationId, status: row.status }));
      return projection;
    }
    if (method === "transfers.cancel") { state.order.push("cancel:" + String(params.operationId || "")); state.cancels.push(params); return cancelFor(params); }
    state.order.push("upload:" + String(params.targetId));
    state.uploads.push(String(params.targetId));
    return { ok: true, status: "completed" };
  } };
  const host = realHost.createRealSyncHost(hostOptions);
  return { host, hostOptions, targets, state, operations };
}

test("超过 3 小时且“取消被接受但始终不落地”：仍按长期授权过期接管，不弹框也不永久卡死", async () => {
  const fixture = createLedgerRound({
    operations: [{ operationId: "op-old-accepted", startedAtMs: Date.now() - 4 * HOUR_MS }],
    cancelFor: params => ({ ok: true, operationId: String(params.operationId || ""), cancelled: true,
      status: "cancelling", settled: false }),
  });
  await fixture.host.syncCodeTargets(fixture.targets, "run", { hashCompare: true });
  assert.equal(fixture.host.modals.length, 0, "严格超过 3 小时的记录按用户长期授权过期，不该弹框打扰");
  assert.deepEqual([...new Set(fixture.state.uploads)], ["w-a"],
    "“取消已被接受”不能当成退出证据，也不能反过来抹掉过期授权：仍要能按长期授权接管");
  const record = fixture.host.codeSyncTargetResults.find(row => row.takeover === "stale-overwrite");
  assert.ok(record, "必须留下覆盖接管事实");
  assert.equal(record.staleAuthorizedBy, "expired-over-3h");
  assert.equal(record.staleIgnored, 1, "被过期忽略的条数要如实记进回执");
  assert.match(fixture.host.facts.join("\n"), /退出从未被确认落地/, "过期接管不等于证明旧传输已停止");
  assert.equal(fixture.host.codeUploadTargetLeases.held.size, 0, "接管完成不留残留写锁");
});

test("年轻项“取消被接受但仍存在”＋过期项“取消被拒”：年轻项没批准就零写入，批准之后才继续", async () => {
  const build = () => createLedgerRound({
    operations: [{ operationId: "op-young-accepted", startedAtMs: Date.now() - 60 * 1000 },
      { operationId: "op-old-refused", startedAtMs: Date.now() - 4 * HOUR_MS }],
    cancelFor: params => String(params.operationId || "") === "op-young-accepted"
      ? { ok: true, operationId: "op-young-accepted", cancelled: true, status: "cancelling", settled: false }
      : { ok: true, operationId: "op-old-refused", cancelled: false, status: "outcomeUnknown", settled: false },
  });
  // 一、没批准：年轻项仍在实时投影里，绝不能被“取消已接受”的回执掩盖成可覆盖（审核方标为阻断级的场景）。
  const refused = build();
  await assert.rejects(refused.host.syncCodeTargets(refused.targets, "run", { hashCompare: true }), /取消未被接受/);
  assert.equal(refused.host.modals.length, 1, "本轮就要问一次，不要求用户先失败一轮");
  assert.ok(refused.host.modals[0].detail.includes("op-young-accepted"),
    "已接受取消但仍存在的年轻项必须进批准清单，不得被取消回执排除（A2）");
  assert.equal(refused.state.uploads.length, 0, "年轻项没拿到批准就一个字节也不写");
  assert.equal(refused.host.codeUploadTargetLeases?.held?.size || 0, 0, "没批准不得拿任何写锁");
  // 二、明确批准：年轻项按本轮确认覆盖、过期项按长期授权过期，两项各自满足凭据之后才写入。
  const approved = build();
  approved.hostOptions.modalAnswer = "完全覆盖并继续";
  await approved.host.syncCodeTargets(approved.targets, "run", { hashCompare: true });
  assert.deepEqual([...new Set(approved.state.uploads)], ["w-a"], "批准之后才能接管写入");
  assert.equal(approved.host.modals.length, 1, "批准之后本轮不再弹框");
  const record = approved.host.codeSyncTargetResults.find(row => row.takeover === "stale-overwrite");
  assert.ok(record && record.staleIgnoredAts.length === 1, "过期那一条按长期授权忽略，年轻那一条必须来自本轮确认");
});

test("13 条待覆盖记录：同一个模态框一条不漏全部列出，禁止用省略号代替批准项", async () => {
  const operations = Array.from({ length: 13 }, (_unused, index) => ({
    operationId: "op-many-" + index, startedAtMs: Date.now() - 2 * HOUR_MS }));
  const fixture = createLedgerRound({ operations });
  await assert.rejects(fixture.host.syncCodeTargets(fixture.targets, "run", { hashCompare: true }), /取消未被接受/);
  assert.equal(fixture.host.modals.length, 1, "整批只弹一个框");
  const detail = fixture.host.modals[0].detail;
  for (let index = 0; index < 13; index++)
    assert.ok(detail.includes("操作身份 op-many-" + index), `第 ${index} 条必须出现在批准清单里`);
  assert.equal((detail.match(/操作身份 op-many-/g) || []).length, 13, "清单条目数必须与待覆盖条数一致");
  assert.equal(/略|省略|…|etc\./.test(detail), false, "批准清单不允许用省略号或“其余 N 条略”代替");
  assert.match(srcSource, /for \(const record of summary\.needsConsent\) lines\.push\(describe\(record\)\);/);
  assert.equal(/needsConsent[^)]{0,30}\.slice\(/.test(srcSource), false, "批准清单不得再被 slice 截断");
  assert.equal(fixture.state.uploads.length, 0, "没批准就一字节也不写");
});

test("同一 operationId 换实例或换发起时间就是另一份操作：旧批准无效、零写入；清单范围变了也必须停下", async () => {
  const bindAt = Date.now() - 2 * HOUR_MS;
  const fixture = createLedgerRound({ operations: [{ operationId: "op-bind", startedAtMs: bindAt, instanceId: "instance-real-1" }] });
  const host = fixture.host;
  const key = host.resolveCodeUploadTargetIdentityLocal(fixture.targets[0]).key;
  const summary = await host.collectCodeUploadStaleRecordsLocal(fixture.targets, host.project, "sync-bind");
  host.recordCodeUploadStaleDecisionLocal("sync-bind", summary, { approved: true, modalShown: true },
    { targetKeys: summary.targetKeys, fingerprint: "fp-round-1" });
  const epoch = { targetKey: key, fingerprint: "fp-round-1" };
  const same = [{ operationId: "op-bind", operationInstanceId: "instance-real-1", startedAtMs: bindAt }];
  assert.equal(host.codeUploadStaleOverwriteLocal("sync-bind", key, same, epoch).covered, true,
    "同一身份+同一实例+同一发起时间：本轮确认过就可以覆盖");
  assert.equal(host.codeUploadStaleOverwriteLocal("sync-bind", key,
    [{ ...same[0], operationInstanceId: "instance-another-7" }], epoch).covered, false,
    "同一个 operationId 换成别的台账实例身份就是另一份操作，旧批准必须无效");
  assert.equal(host.codeUploadStaleOverwriteLocal("sync-bind", key,
    [{ ...same[0], startedAtMs: Date.now() - 90 * 60 * 1000 }], epoch).covered, false,
    "同一个 operationId 换成别的发起时间也是另一份操作，旧批准必须无效");
  const scopeShift = host.codeUploadStaleOverwriteLocal("sync-bind", key, same, { targetKey: key, fingerprint: "fp-round-2" });
  assert.equal(scopeShift.covered, false, "冻结的清单指纹变了（勾选范围变了）必须停下重新确认");
  assert.equal(scopeShift.scopeChanged, true, "范围变化要如实标出来，不能伪装成普通失败");
  // 端到端：批准之后同一身份换了实例，本轮也必须零写入。
  const e2e = createLedgerRound({ operations: [{ operationId: "op-bind2", startedAtMs: bindAt, instanceId: "instance-real-1" }] });
  e2e.hostOptions.modalAnswer = () => { e2e.operations[0].instanceId = "instance-another-7"; return "完全覆盖并继续"; };
  await assert.rejects(e2e.host.syncCodeTargets(e2e.targets, "run", { hashCompare: true }), /还没拿到本轮明确批准/);
  assert.equal(e2e.state.uploads.length, 0, "批准之后换了实例就停下，一字节也不写");
  assert.equal(e2e.host.modals.length, 1, "同一轮不再弹第二个框");
});

test("旧记录归属不完整：确认框明确写“归属未知”，本次实际覆盖目标另列，不冒充旧传输的已知归属", async () => {
  const fixture = createLedgerRound({ operations: [{ operationId: "op-no-owner", startedAtMs: Date.now() - 2 * HOUR_MS }] });
  await assert.rejects(fixture.host.syncCodeTargets(fixture.targets, "run", { hashCompare: true }), /取消未被接受/);
  const detail = fixture.host.modals[0].detail;
  const line = String((detail.split("\n").find(row => row.includes("op-no-owner")) || ""));
  assert.ok(line.length > 0, "清单里必须有这条记录");
  assert.ok(line.includes("旧记录归属未知"), "台账项不带主机/路径时必须写明归属未知");
  assert.equal(line.includes("one.example") || line.includes("/work/proj"), false, "不得把本次目标写成分配给旧记录的已知归属");
  assert.ok(detail.includes("本次实际要覆盖的目标") && detail.includes("one.example") && detail.includes("/work/proj"),
    "本次实际要覆盖的目标必须另列，用户才知道会覆盖到哪里");
  assert.equal(fixture.state.uploads.length, 0);
});

test("本机未知写入所有权不参与覆盖批准集合，但必须在确认框里如实列出，并随批准后的接管一起处理", async () => {
  const targets = [workerTarget("w-a", "Worker A", "one.example", "/work/proj")];
  const build = () => {
    const order = [];
    let stale = false;
    let writes = 0;
    const hostOptions = { targets, upload: async (_host, method) => {
      if (method === "transfers.list") {
        order.push("verify");
        return stale ? realHost.busyTransferState({ id: "", operationId: "", host: "one.example", remotePath: "/work/proj" })
          : realHost.quiescedTransferState();
      }
      if (method === "transfers.cancel") { order.push("cancel"); return { ok: true, cancelled: true, status: "cancelling", settled: false }; }
      writes += 1;
      order.push("write:" + writes);
      if (writes === 1) { stale = true; throw new host2Error(); }
      return { ok: true, status: "completed" };
    } };
    const host = realHost.createRealSyncHost(hostOptions);
    function host2Error() { return new host.UiCommandCancelled("用户在传输中取消"); }
    return { host, hostOptions, order };
  };
  const fixture = build();
  const targetKey = fixture.host.resolveCodeUploadTargetIdentityLocal(targets[0]).key;
  await assert.rejects(fixture.host.syncCodeTargets(targets, "run", { hashCompare: true }), /用户在传输中取消/);
  const owned = fixture.host.pendingCodeUploadUnknownWriteLocal(fixture.host.project, { targetKey, workerId: "w-a" });
  assert.ok(owned && owned.retainedLease, "第一轮必须真的留下未知写入所有权与保留租约");
  await assert.rejects(fixture.host.syncCodeTargets(targets, "run", { hashCompare: true }), /用户未确认/);
  const detail = fixture.host.modals[0].detail;
  assert.match(detail, /本机在下列目标上还记着/, "本机未知写入所有权必须在确认框里如实列出");
  assert.ok(detail.includes("保留租约 仍在"), "保留租约仍在要写清，用户才知道批准会顺带接管它");
  // 直接走生产入口复核批准集合的构成：本机未知写入所有权单列展示，不进待覆盖批准集合。
  const summary = await fixture.host.collectCodeUploadStaleRecordsLocal(targets, fixture.host.project, "sync-local-ownership");
  const bindings = [String((summary.needsConsent[0] || {}).identity || '')];
  assert.equal(summary.unknownWriteTargets.length, 1, "本机未知写入所有权必须单列在确认框的独立段落里");
  assert.equal(summary.needsConsent.length, 1, "待覆盖批准集合只有那条传输记录：本机所有权没有可靠创建时间，参与过期判定会把长期授权变成永远要点确认");
  assert.equal(summary.needsConsent.some(row => String(row.identity || '').includes('保留租约')), false,
    "保留租约不是传输记录，不得变成第二个批准项");
  assert.equal(bindings.length, 1, `批准集合只绑那一条传输记录：本机未知写入所有权没有可靠创建时间，不参与覆盖批准（实际 ${JSON.stringify(bindings)}）`);
  assert.equal(bindings[0].startsWith("anonymous:"), true, "绑的就是那条寻不到身份的传输记录");
  assert.equal(fixture.order.includes("write:2"), false, "没批准就一字节也不写");
  // 批准之后：本机所有权与保留租约随真实接管一并释放，不留在表上。
  const takenOver = build();
  await assert.rejects(takenOver.host.syncCodeTargets(targets, "run", { hashCompare: true }), /用户在传输中取消/);
  takenOver.hostOptions.modalAnswer = "完全覆盖并继续";
  await takenOver.host.syncCodeTargets(targets, "run", { hashCompare: true });
  assert.equal(takenOver.host.pendingCodeUploadUnknownWriteLocal(takenOver.host.project, { targetKey, workerId: "w-a" }), undefined,
    "真正接管过之后才释放本机未知写入所有权");
  assert.equal(takenOver.host.codeUploadTargetLeases?.held?.size || 0, 0, "接管完成不留残留写锁");
});
