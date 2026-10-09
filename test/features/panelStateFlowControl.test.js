const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../../src/features/PanelStateFlowControl.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(code, { exports: loaded.exports, module: loaded, Date, Math, Number });
const flow = loaded.exports;
const progressSource = fs.readFileSync(path.join(__dirname, "../../src/features/PanelStateProgress.ts"), "utf8");
const progressCode = ts.transpileModule(progressSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const progressLoaded = { exports: {} };
vm.runInNewContext(progressCode, { exports: progressLoaded.exports, module: progressLoaded, Number, Math });
const progress = progressLoaded.exports;

function post(state, seq, now, immediate = false, bootstrap = false) {
  const decision = flow.requestPanelStateFlowPost(state, immediate, bootstrap);
  return decision.shouldPost
    ? flow.markPanelStateFlowPosted(decision.state, seq, now)
    : decision.state;
}

function deliver(state, seq) {
  return flow.markPanelStateFlowDelivered(state, seq);
}

function render(state, generation, seq, now) {
  return flow.acknowledgePanelStateRendered(state, generation, seq, now);
}

test("one full state stays outstanding while one hundred mutations coalesce to latest", () => {
  let state = flow.createPanelStateFlowControlState(1, true);
  state = post(state, 1, 10, true, true);
  state = deliver(state, 1);
  let posts = 1;
  for (let index = 0; index < 100; index += 1) {
    const decision = flow.requestPanelStateFlowPost(state);
    state = decision.state;
    if (decision.shouldPost) posts += 1;
    else assert.equal(decision.reason, "awaiting-render");
  }
  assert.equal(posts, 1);
  assert.equal(state.pendingDirty, true);
  assert.equal(state.outstandingRenderSeq, 1);

  const ack = render(state, 1, 1, 40);
  state = ack.state;
  assert.equal(ack.shouldFlushPending, true);
  const latest = flow.requestPanelStateFlowPost(state);
  assert.equal(latest.shouldPost, true);
  state = flow.markPanelStateFlowPosted(latest.state, 2, 41);
  assert.equal(state.postedSeq, 2);
  assert.equal(state.pendingDirty, false);
  assert.equal(state.outstandingRenderSeq, 2);
});

test("five business state updates per second still retain at most one unrendered full state", () => {
  let state = flow.createPanelStateFlowControlState(12, true);
  state = post(state, 40, 0, true, true);
  state = deliver(state, 40);
  let posts = 1;
  for (let update = 1; update <= 25; update += 1) {
    const decision = flow.requestPanelStateFlowPost(state);
    state = decision.state;
    if (decision.shouldPost) posts += 1;
    else assert.equal(decision.reason, "awaiting-render");
    assert.equal(state.outstandingRenderSeq, 40);
    assert.ok(posts <= 1);
  }
  assert.equal(state.pendingDirty, true);
  const rendered = render(state, 12, 40, 5_000);
  assert.equal(rendered.shouldFlushPending, true);
  const latest = flow.requestPanelStateFlowPost(rendered.state);
  assert.equal(latest.shouldPost, true);
  state = flow.markPanelStateFlowPosted(latest.state, 41, 5_001);
  assert.equal(state.outstandingRenderSeq, 41);
  assert.equal(state.pendingDirty, false);
});

test("an older render ACK cannot clear a newer outstanding full state", () => {
  let state = flow.createPanelStateFlowControlState(4, true);
  state = post(state, 1, 10, true, true);
  state = deliver(state, 1);
  state = render(state, 4, 1, 20).state;
  state = post(state, 2, 25);
  state = deliver(state, 2);
  const older = render(state, 4, 1, 30);
  assert.equal(older.accepted, false);
  assert.equal(older.state.outstandingRenderSeq, 2);
  assert.equal(older.state.renderedSeq, 1);
});

test("render ACK from another document generation cannot mutate current flow", () => {
  let state = flow.createPanelStateFlowControlState(5, true);
  state = post(state, 8, 10, true, true);
  const before = state;
  const oldDocument = render(state, 4, 8, 20);
  assert.equal(oldDocument.accepted, false);
  assert.equal(oldDocument.state, before);
  assert.equal(oldDocument.state.outstandingRenderSeq, 8);
});

test("new document clears per-document delivery progress while global seq remains caller-owned", () => {
  let globalSequence = 991;
  let state = flow.createPanelStateFlowControlState(1, true);
  state = post(state, globalSequence, 10, true, true);
  state = deliver(state, globalSequence);
  state = render(state, 1, globalSequence, 20).state;
  state = flow.beginPanelStateDocument(state, 2, true);
  assert.equal(state.documentGeneration, 2);
  assert.equal(state.postedSeq, 0);
  assert.equal(state.deliveredSeq, 0);
  assert.equal(state.renderedSeq, 0);
  assert.equal(state.outstandingRenderSeq, null);
  assert.equal(state.pendingDirty, false);
  globalSequence += 1;
  const firstPost = flow.requestPanelStateFlowPost(state, true, true);
  assert.equal(firstPost.shouldPost, true);
  state = flow.markPanelStateFlowPosted(firstPost.state, globalSequence, 21);
  assert.equal(state.postedSeq, 992);
});

test("one thousand hidden mutations create no posts and visibility sends only latest state", () => {
  let state = flow.createPanelStateFlowControlState(8, true);
  state = post(state, 1, 10, true, true);
  state = deliver(state, 1);
  state = flow.setPanelStateFlowVisibility(state, false);
  assert.equal(state.outstandingRenderSeq, null, "hidden transition retires an unrendered document state");
  let posts = 0;
  for (let index = 0; index < 1000; index += 1) {
    const decision = flow.requestPanelStateFlowPost(state, index === 999);
    state = decision.state;
    if (decision.shouldPost) posts += 1;
    assert.equal(decision.reason, "hidden");
  }
  assert.equal(posts, 0);
  assert.equal(state.pendingDirty, true);
  state = flow.setPanelStateFlowVisibility(state, true);
  const visible = flow.requestPanelStateFlowPost(state);
  assert.equal(visible.shouldPost, true);
  state = flow.markPanelStateFlowPosted(visible.state, 2, 100);
  posts += 1;
  assert.equal(posts, 1);
  assert.equal(state.outstandingRenderSeq, 2);
});

test("ordinary forced updates cannot bypass render backpressure", () => {
  let state = flow.createPanelStateFlowControlState(3, true);
  state = post(state, 1, 10, true, true);
  const forced = flow.requestPanelStateFlowPost(state, true);
  assert.equal(forced.shouldPost, false);
  assert.equal(forced.immediate, true);
  assert.equal(forced.reason, "awaiting-render");
  assert.equal(forced.state.pendingDirty, true);
});

test("bootstrap force sends the first state immediately", () => {
  let state = flow.createPanelStateFlowControlState(7, true);
  const bootstrap = flow.requestPanelStateFlowPost(state, true, true);
  assert.equal(bootstrap.shouldPost, true);
  assert.equal(bootstrap.immediate, true);
  state = flow.markPanelStateFlowPosted(bootstrap.state, 1, 50);
  assert.equal(state.outstandingRenderSeq, 1);
});

test("a render ACK does not masquerade as postMessage Promise delivery", () => {
  let state = flow.createPanelStateFlowControlState(12, true);
  state = post(state, 1, 10, true, true);
  assert.equal(state.deliveredSeq, 0);
  const ack = render(state, 12, 1, 15);
  state = ack.state;
  assert.equal(state.renderedSeq, 1);
  assert.equal(state.deliveredSeq, 0, "only Promise resolve true advances deliveredSeq");
  state = deliver(state, 1);
  assert.equal(state.deliveredSeq, 1);
});

test("ten-minute latest-wins pressure simulation stays bounded through hidden interval", () => {
  let state = flow.createPanelStateFlowControlState(11, true);
  let globalSequence = 0;
  let fullPosts = 0;
  let fullBytes = 0;
  let hiddenFullPosts = 0;
  let maxOutstanding = 0;
  let maxPending = 0;
  let mutationSequence = 0;
  let lastPostedMutationSequence = 0;
  let visibleResumePostMutationSequence = 0;
  let renderAckCount = 0;
  let renderAckLatencyTotalMs = 0;
  let renderAckLatencyMaxMs = 0;
  let previousHeartbeatRenderedSeq;
  let stalledHeartbeatAcks = 0;
  const recoveryReasons = [];
  let slowExecutionRenderCount = 0;
  let renderDueAt = null;
  let now = 0;
  const hiddenFrom = 240_000;
  const hiddenUntil = 360_000;
  let visible = true;
  const renderDuration = (seq) => 5 + ((seq * 73) % 296);

  for (now = 0; now <= 600_000; now += 5) {
    const nextVisible = !(now >= hiddenFrom && now < hiddenUntil);
    if (visible !== nextVisible) {
      visible = nextVisible;
      state = flow.setPanelStateFlowVisibility(state, visible);
      if (visible && state.outstandingRenderSeq !== null && renderDueAt === null) renderDueAt = now + renderDuration(state.outstandingRenderSeq);
    }

    if (now % 200 === 0) {
      mutationSequence += 1;
      const decision = flow.requestPanelStateFlowPost(state);
      state = decision.state;
      if (decision.shouldPost) {
        if (!visible) hiddenFullPosts += 1;
        globalSequence += 1;
        state = flow.markPanelStateFlowPosted(state, globalSequence, now);
        state = deliver(state, globalSequence);
        fullPosts += 1;
        fullBytes += 800 * 1024;
        lastPostedMutationSequence = mutationSequence;
        if (now >= hiddenUntil && visibleResumePostMutationSequence === 0) visibleResumePostMutationSequence = mutationSequence;
        maxOutstanding = Math.max(maxOutstanding, state.outstandingRenderSeq === null ? 0 : 1);
        renderDueAt = visible ? now + renderDuration(globalSequence) : null;
        if (renderDuration(globalSequence) === 300) slowExecutionRenderCount += 1;
      }
    }

    maxPending = Math.max(maxPending, state.pendingDirty ? 1 : 0);
    if (visible && state.outstandingRenderSeq !== null && renderDueAt !== null && now >= renderDueAt) {
      const renderedSeq = state.outstandingRenderSeq;
      const ack = render(state, 11, renderedSeq, now);
      state = ack.state;
      if (ack.renderAckLatencyMs !== null) {
        renderAckCount += 1;
        renderAckLatencyTotalMs += ack.renderAckLatencyMs;
        renderAckLatencyMaxMs = Math.max(renderAckLatencyMaxMs, ack.renderAckLatencyMs);
      }
      renderDueAt = null;
      if (state.pendingDirty && visible) {
        const decision = flow.requestPanelStateFlowPost(state);
        state = decision.state;
        if (decision.shouldPost) {
          if (!visible) hiddenFullPosts += 1;
          globalSequence += 1;
          state = flow.markPanelStateFlowPosted(state, globalSequence, now);
          state = deliver(state, globalSequence);
          fullPosts += 1;
          fullBytes += 800 * 1024;
          lastPostedMutationSequence = mutationSequence;
          if (now >= hiddenUntil && visibleResumePostMutationSequence === 0) visibleResumePostMutationSequence = mutationSequence;
          maxOutstanding = Math.max(maxOutstanding, state.outstandingRenderSeq === null ? 0 : 1);
          renderDueAt = now + renderDuration(globalSequence);
          if (renderDuration(globalSequence) === 300) slowExecutionRenderCount += 1;
        }
      }
    }

    if (now > 0 && now % 30_000 === 0) {
      if (!visible) {
        previousHeartbeatRenderedSeq = undefined;
        stalledHeartbeatAcks = 0;
      } else {
        const heartbeat = progress.observeStateRenderProgress(
          state.postedSeq,
          state.renderedSeq,
          previousHeartbeatRenderedSeq,
          stalledHeartbeatAcks,
          3,
        );
        previousHeartbeatRenderedSeq = heartbeat.previousObservedRenderedSeq;
        stalledHeartbeatAcks = heartbeat.consecutiveStalledAcks;
        if (heartbeat.unhealthy) recoveryReasons.push("state-render-sequence-stalled");
      }
    }
  }

  assert.ok(fullPosts > 1);
  assert.equal(fullBytes, fullPosts * 800 * 1024);
  assert.equal(hiddenFullPosts, 0, "hidden intervals emit no full-state posts");
  assert.equal(maxOutstanding, 1);
  assert.equal(maxPending, 1);
  assert.equal(state.postedSeq, globalSequence);
  assert.ok(lastPostedMutationSequence <= mutationSequence);
  assert.ok(mutationSequence - lastPostedMutationSequence <= 1, "at most the latest mutation remains pending, never a replay queue");
  assert.equal(state.pendingDirty, true, "the final mutation may wait behind one outstanding full state");
  assert.ok(visibleResumePostMutationSequence > 1200, "visibility return posts after the two-minute hidden interval");
  assert.ok(slowExecutionRenderCount > 0, "simulation includes 300 ms execution-section render samples");
  assert.ok(renderAckCount > 0);
  assert.ok(renderAckLatencyTotalMs / renderAckCount >= 5);
  assert.ok(renderAckLatencyMaxMs <= 300);
  assert.deepEqual(recoveryReasons, [], "healthy visible progress and hidden intervals do not recover");
  assert.ok(state.renderedSeq <= state.postedSeq);
  assert.ok(fullPosts < 3000, "coalescing avoids replaying all 5 Hz mutations");
  assert.equal(flow.panelStateFlowControlSnapshot(state, now - 5).outstandingRenderSeq, state.outstandingRenderSeq);
});
