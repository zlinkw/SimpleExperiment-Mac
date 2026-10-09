const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const ts = require("typescript");
require("../_helpers/registerTsRequire");

function loadSourceRenderer() {
  const sourcePath = path.resolve(__dirname, "../../src/ui/PanelHtml.legacy.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(code, sourcePath);
  return loaded.exports.renderPanelHtml;
}

const renderPanelHtml = loadSourceRenderer();

function extractScript(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const main = scripts.find((script) => script.includes('addEventListener("message"'));
  assert.ok(main, "main panel script tag missing");
  return main;
}

function renderStampedPanelHtml() {
  return renderPanelHtml().replace("<html lang=", '<html data-panel-document-generation="doc-17" lang=');
}

function fakeBrowser(options = {}) {
  let now = 1_000_000;
  let nextTimerId = 0;
  let webviewState = options.initialState || {};
  const timers = new Map();
  const frames = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const sent = [];
  const api = {
    postMessage(message) { sent.push(message); },
    getState() { return webviewState; },
    setState(value) { webviewState = value; },
  };
  const elements = new Map();
  const addListener = (registry, type, callback) => {
    const entries = registry.get(type) || new Set();
    entries.add(callback);
    registry.set(type, entries);
  };
  const element = (id) => {
    if (elements.has(id)) return elements.get(id);
    const attributes = new Map();
    const classes = new Set();
    let innerHTML = "";
    let innerHTMLWrites = 0;
    let classToggleCalls = 0;
    let classToggleCallbackUsed = false;
    const item = {
      id, isConnected: true, hidden: false, textContent: "", value: "", checked: false,
      get innerHTML() { return innerHTML; },
      set innerHTML(value) { const next = String(value ?? ""); if (next !== innerHTML) innerHTMLWrites += 1; innerHTML = next; },
      dataset: {}, style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } }, children: [], classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          classToggleCalls += 1;
          if (!classToggleCallbackUsed && typeof options.onClassToggle === "function") {
            classToggleCallbackUsed = true;
            options.onClassToggle(id);
          }
          if (options.renderThrows && id === "projectOnboardingNotice") throw new Error("fake render failure");
          return force === undefined ? (classes.has(name) ? classes.delete(name) : classes.add(name)) : (force ? classes.add(name) : classes.delete(name));
        },
      },
      addEventListener(type, callback) { addListener(this.listeners || (this.listeners = new Map()), type, callback); },
      removeEventListener(type, callback) { this.listeners?.get(type)?.delete(callback); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) || null; },
      hasAttribute(name) { return attributes.has(name); },
      removeAttribute(name) { attributes.delete(name); },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      replaceChildren(...children) { this.children = children; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      closest() { return null; }, matches(selector) { return selector.includes('data-command="selectExperiment"') && this.dataset.command === "selectExperiment"; },
      getClientRects() { return id === "mainColumn" ? [{}] : []; }, getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
      focus() {}, click() {}, scrollIntoView() {}, remove() {},
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }, contains() { return false; },
      get options() { return []; }, get selectedOptions() { return []; },
      get classToggleCalls() { return classToggleCalls; },
      get innerHTMLWrites() { return innerHTMLWrites; },
    };
    if (options.failResults && id === "resultSummary") {
      let html = "";
      Object.defineProperty(item, "innerHTML", { configurable: true, get: () => html, set: (value) => { throw new Error("results renderer fixture failure"); } });
    }
    elements.set(id, item);
    return item;
  };
  const documentElement = element("documentElement");
  documentElement.getAttribute = (name) => name === "data-panel-document-generation" ? (options.documentGeneration || "doc-17") : null;
  const document = {
    hidden: !!options.hidden, documentElement, body: element("body"),
    activeElement: options.fastPath ? { dataset: { configInput: "hub" } } : null,
    getElementById: (id) => options.missingRoots?.has(id) ? null : element(id),
    createElement: (tag) => element("created-" + tag + "-" + (++nextTimerId)),
    querySelector(selector) { return options.failResults && selector === '[data-section="results"]' ? element("results-section") : null; }, querySelectorAll(selector) {
      if (selector === "[data-config-input][data-key]" && options.selectConfigInputs) return [...elements.values()].filter((item) => item.dataset.configInput && item.dataset.key);
      if (selector === 'input[type="checkbox"][data-command="selectExperiment"]' && options.taskCheckboxes) return options.taskCheckboxes;
      return [];
    },
    addEventListener(type, callback) { addListener(documentListeners, type, callback); },
    removeEventListener(type, callback) { documentListeners.get(type)?.delete(callback); },
  };
  const window = {
    innerWidth: 1000, innerHeight: 800,
    __simplePanelVsCodeApi: api,
    addEventListener(type, callback) { addListener(windowListeners, type, callback); },
    removeEventListener(type, callback) { windowListeners.get(type)?.delete(callback); },
    setTimeout(callback, delay) { const id = ++nextTimerId; timers.set(id, { callback, at: now + delay, interval: 0 }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const setTimeoutFake = (callback, delay) => window.setTimeout(callback, delay);
  const clearTimeoutFake = (id) => window.clearTimeout(id);
  const setIntervalFake = (callback, delay) => { const id = ++nextTimerId; timers.set(id, { callback, at: now + delay, interval: delay }); return id; };
  const clearIntervalFake = (id) => timers.delete(id);
  const advance = (amount) => {
    const end = now + amount;
    let executions = 0;
    for (;;) {
      const due = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      assert.ok(++executions < 10000, "fake timer loop exceeded bound");
      const [id, item] = due;
      now = item.at;
      if (item.interval) item.at += item.interval;
      else timers.delete(id);
      item.callback();
    }
    now = end;
  };
  class FakeDate extends Date { static now() { return now; } }
  const context = {
    document, window, Date: FakeDate, console: { log() {}, warn() {}, error() {} },
    setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
    setInterval: setIntervalFake, clearInterval: clearIntervalFake,
    requestAnimationFrame(callback) { const id = ++nextTimerId; frames.set(id, () => { frames.delete(id); callback(); }); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { clipboard: { writeText: async () => undefined } },
    acquireVsCodeApi: () => api,
  };
  return {
    context, document, documentListeners, windowListeners, elements, element, frames, timers, sent, advance,
    setHidden(hidden) {
      document.hidden = Boolean(hidden);
      for (const listener of documentListeners.get("visibilitychange") || []) listener();
    },
    get webviewState() { return webviewState; },
  };
}

test("a retained rendered script reports a stalled state frame during a one-hour live heartbeat session", () => {
  const browser = fakeBrowser();
  const script = extractScript(renderStampedPanelHtml());
  assert.doesNotThrow(() => new vm.Script(script, { filename: "panel-render-health.js" }));
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  const messageHandler = browser.windowListeners.get("message")?.values().next().value;
  assert.equal(typeof messageHandler, "function", "webview message listener installed");

  const send = (data) => messageHandler({ data });
  const initialFrameCount = browser.frames.size;
  const listenerCount = [...browser.documentListeners.values()].reduce((sum, entries) => sum + entries.size, 0)
    + [...browser.windowListeners.values()].reduce((sum, entries) => sum + entries.size, 0);
  const timerCount = browser.timers.size;
  send({ type: "state", seq: 1, state: { generation: 1, plans: [], recentPlans: [] } });
  send({ type: "panelHeartbeat", heartbeatId: 0 });
  for (let generation = 2; generation <= 121; generation++) {
    send({ type: "state", seq: generation, state: { generation, plans: [], recentPlans: [] } });
    browser.advance(30_000);
    send({ type: "panelHeartbeat", heartbeatId: generation });
  }
  assert.ok(browser.frames.size <= initialFrameCount + 1, "the render queue holds one latched frame");

  const acknowledgements = browser.sent.filter((message) => message.command === "webviewHeartbeatAck");
  assert.equal(acknowledgements.length, 121);
  assert.equal(acknowledgements.at(-1).documentGeneration, "doc-17");
  assert.equal(acknowledgements.at(-1).lastReceivedStateSeq, 121);
  assert.equal(acknowledgements.at(-1).lastRenderedStateSeq, 0);
  assert.equal(acknowledgements[0].renderHealth.status, "unknown");
  assert.equal(acknowledgements[0].renderHealth.reason, "state-render-pending");
  assert.equal(acknowledgements.at(-1).renderHealth.status, "unhealthy");
  assert.equal(acknowledgements.at(-1).renderHealth.reason, "state-render-frame-stalled");
  assert.ok(browser.frames.size <= initialFrameCount + 1, "stalled animation frame does not accumulate callbacks");
  assert.equal([...browser.documentListeners.values()].reduce((sum, entries) => sum + entries.size, 0)
    + [...browser.windowListeners.values()].reduce((sum, entries) => sum + entries.size, 0), listenerCount);
  assert.ok(browser.timers.size <= timerCount + 1, "one-hour run does not retain extra timers");
});

test("a retained rendered script detects one hour of RAF starvation without new state messages", () => {
  const browser = fakeBrowser({ fastPath: true });
  const script = extractScript(renderStampedPanelHtml());
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  const onMessage = browser.windowListeners.get("message")?.values().next().value;
  const initialFrameCount = browser.frames.size;
  const listenerCount = [...browser.documentListeners.values()].reduce((sum, entries) => sum + entries.size, 0)
    + [...browser.windowListeners.values()].reduce((sum, entries) => sum + entries.size, 0);
  const timerCount = browser.timers.size;

  onMessage({ data: { type: "state", seq: 1, state: { plans: [], recentPlans: [] } } });
  [...browser.frames.values()].at(-1)();
  onMessage({ data: { type: "panelHeartbeat", heartbeatId: 0 } });
  const firstProbe = [...browser.frames.keys()].at(-1);
  browser.frames.get(firstProbe)();
  onMessage({ data: { type: "panelHeartbeat", heartbeatId: 1 } });
  assert.equal(browser.sent.at(-1).renderHealth.status, "ok");
  assert.equal(browser.sent.at(-1).renderHealth.reason, "render-completed");
  assert.equal(browser.sent.at(-1).lastReceivedStateSeq, 1);
  assert.equal(browser.sent.at(-1).lastRenderedStateSeq, 1);

  for (let heartbeatId = 2; heartbeatId <= 121; heartbeatId++) {
    browser.advance(30_000);
    onMessage({ data: { type: "panelHeartbeat", heartbeatId } });
  }
  const acknowledgements = browser.sent.filter((message) => message.command === "webviewHeartbeatAck");
  assert.equal(acknowledgements.length, 122);
  assert.equal(acknowledgements.at(-1).renderHealth.status, "unhealthy");
  assert.equal(acknowledgements.at(-1).renderHealth.reason, "animation-frame-probe-stalled");
  assert.ok(browser.frames.size <= initialFrameCount + 1, "only one health probe can remain queued");
  assert.equal([...browser.documentListeners.values()].reduce((sum, entries) => sum + entries.size, 0)
    + [...browser.windowListeners.values()].reduce((sum, entries) => sum + entries.size, 0), listenerCount);
  assert.ok(browser.timers.size <= timerCount + 1, "hourly heartbeat probes do not retain timers");
});

test("missing roots and a caught render failure are reported by actual heartbeat handling", () => {
  const script = extractScript(renderStampedPanelHtml());
  for (const [options, expected] of [
    [{ missingRoots: new Set(["mainColumn"]) }, "required-render-root-missing"],
    [{ hidden: true }, "document-hidden"],
  ]) {
    const browser = fakeBrowser(options);
    vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
    const onMessage = browser.windowListeners.get("message")?.values().next().value;
    onMessage({ data: { type: "panelHeartbeat", heartbeatId: 1 } });
    assert.equal(browser.sent.at(-1).renderHealth.reason, expected);
    assert.notEqual(browser.sent.at(-1).renderHealth.status, "ok");
  }

  const browser = fakeBrowser({ renderThrows: true });
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  const onMessage = browser.windowListeners.get("message")?.values().next().value;
  onMessage({ data: { type: "state", seq: 1, state: { plans: [], recentPlans: [] } } });
  const pendingFrame = [...browser.frames.values()].at(-1);
  assert.equal(typeof pendingFrame, "function");
  pendingFrame();
  onMessage({ data: { type: "panelHeartbeat", heartbeatId: 2 } });
  assert.equal(browser.sent.at(-1).renderHealth.status, "unhealthy");
  assert.match(browser.sent.at(-1).renderHealth.reason, /^render-failed:/);
});

test("hidden state updates do not park RAF; visibility return renders only the latest sequence", () => {
  const browser = fakeBrowser({ hidden: true, fastPath: true });
  const script = extractScript(renderStampedPanelHtml());
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  const onMessage = browser.windowListeners.get("message")?.values().next().value;
  assert.equal(typeof onMessage, "function");

  for (let seq = 1; seq <= 100; seq += 1)
    onMessage({ data: { type: "state", seq, state: { generation: seq, plans: [], recentPlans: [] } } });

  assert.equal(browser.frames.size, 0, "hidden document must not retain a render frame");
  assert.equal(browser.element("projectOnboardingNotice").classToggleCalls, 0, "hidden updates must not render");
  assert.equal(browser.sent.findLast((message) => message.command === "webviewVisibility")?.hidden, true);

  browser.setHidden(false);
  assert.equal(browser.sent.findLast((message) => message.command === "webviewVisibility")?.hidden, false);
  assert.ok(browser.frames.size >= 1, "visible return may queue health and lightweight polling work, but not render stale state");
  [...browser.frames.values()].forEach((frame) => frame());
  assert.equal(browser.element("projectOnboardingNotice").classToggleCalls, 0, "visibility health probe must not render stale hidden state");
  assert.equal(browser.sent.filter((message) => message.command === "webviewStateRendered").length, 0);
  onMessage({ data: { type: "state", seq: 101, state: { generation: 101, plans: [], recentPlans: [] } } });
  const frames = [...browser.frames.values()];
  assert.ok(frames.length >= 1, "visible transition schedules a render");
  frames.forEach((frame) => frame());
  assert.equal(browser.element("projectOnboardingNotice").classToggleCalls, 1, "one render consumes the latest state");

  onMessage({ data: { type: "panelHeartbeat", heartbeatId: 200 } });
  assert.equal(browser.sent.at(-1).lastReceivedStateSeq, 101);
  assert.equal(browser.sent.at(-1).lastRenderedStateSeq, 101);
  assert.deepEqual(browser.sent.filter((message) => message.command === "webviewStateRendered").map((message) => message.seq), [101]);
});

test("a completed rendered update reports healthy DOM state", () => {
  const browser = fakeBrowser({ fastPath: true });
  const script = extractScript(renderStampedPanelHtml());
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  const onMessage = browser.windowListeners.get("message")?.values().next().value;
  onMessage({ data: { type: "state", seq: 1, state: { plans: [], recentPlans: [] } } });
  [...browser.frames.values()].at(-1)();
  onMessage({ data: { type: "panelHeartbeat", heartbeatId: 3 } });
  const probe = [...browser.frames.keys()].at(-1);
  browser.frames.get(probe)();
  onMessage({ data: { type: "panelHeartbeat", heartbeatId: 4 } });
  assert.equal(browser.sent.at(-1).renderHealth.status, "ok");
  assert.equal(browser.sent.at(-1).renderHealth.reason, "render-completed");
});

test("coalesced state messages render and explicitly ACK only the latest sequence", () => {
  const browser = fakeBrowser({ fastPath: true });
  const script = extractScript(renderStampedPanelHtml());
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  const onMessage = browser.windowListeners.get("message")?.values().next().value;
  for (const seq of [1, 2, 3]) onMessage({ data: { type: "state", seq, state: { plans: [], recentPlans: [], generation: seq } } });
  assert.ok(browser.frames.size <= 2, "coalesced states retain a bounded frame queue");
  [...browser.frames.values()].at(-1)();
  const rendered = browser.sent.filter((message) => message.command === "webviewStateRendered");
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].documentGeneration, "doc-17");
  assert.equal(rendered[0].seq, 3);
  assert.equal(typeof rendered[0].renderDurationMs, "number");
  assert.equal(rendered[0].documentHidden, false);
  assert.equal(browser.element("projectOnboardingNotice").classToggleCalls, 1);
});

test("a state arriving during render is ACKed on the next frame, never by the current frame", () => {
  let onMessage;
  let injected = false;
  const browser = fakeBrowser({ fastPath: true, onClassToggle() {
    if (injected) return;
    injected = true;
    onMessage({ data: { type: "state", seq: 2, state: { plans: [], recentPlans: [], generation: 2 } } });
  } });
  const script = extractScript(renderStampedPanelHtml());
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  onMessage = browser.windowListeners.get("message")?.values().next().value;
  onMessage({ data: { type: "state", seq: 1, state: { plans: [], recentPlans: [], generation: 1 } } });

  [...browser.frames.values()][0]();
  let acks = browser.sent.filter((message) => message.command === "webviewStateRendered");
  assert.deepEqual(acks.map((message) => message.seq), [1]);
  assert.equal(browser.frames.size, 1, "the newer state is retained for a subsequent animation frame");

  [...browser.frames.values()][0]();
  acks = browser.sent.filter((message) => message.command === "webviewStateRendered");
  assert.deepEqual(acks.map((message) => message.seq), [1, 2]);
});

test("a full-state render exception never emits a rendered ACK", () => {
  const browser = fakeBrowser({ renderThrows: true });
  const script = extractScript(renderStampedPanelHtml());
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  const onMessage = browser.windowListeners.get("message")?.values().next().value;
  onMessage({ data: { type: "state", seq: 1, state: { plans: [], recentPlans: [] } } });
  [...browser.frames.values()].at(-1)();
  assert.equal(browser.sent.filter((message) => message.command === "webviewStateRendered").length, 0);
  assert.equal(browser.sent.filter((message) => message.command === "webviewRenderError").length, 1);
});

test("execution sub-render keys patch operation progress without rebuilding unrelated execution DOM", () => {
  const browser = fakeBrowser();
  const script = extractScript(renderStampedPanelHtml());
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  const onMessage = browser.windowListeners.get("message")?.values().next().value;
  const base = {
    plans: [], recentPlans: [], schedulerStates: {}, distributedPlans: [], deferredPlans: [],
    selection: { selectedPlanId: "experiments/plans/a.yaml", selectedTaskUiKeys: [] },
    uiLayout: { collapsed: { gpu: true } },
    capabilities: {}, workerTelemetry: {}, gpu: {},
    operations: { a: { id: "a", type: "run-plan", planFile: "experiments/plans/a.yaml", status: "running", progress: 10, updatedAt: "2026-01-01T00:00:01Z" } },
  };
  onMessage({ data: { type: "state", seq: 1, state: base } });
  [...browser.frames.values()].at(-1)();
  const initial = ["executionPlanList", "operationList", "taskBatchActions"].map((id) => browser.element(id).innerHTMLWrites);

  const operationProgress = { ...base, operations: { a: { ...base.operations.a, progress: 45, updatedAt: "2026-01-01T00:00:02Z" } } };
  onMessage({ data: { type: "state", seq: 2, state: operationProgress } });
  [...browser.frames.values()].at(-1)();
  assert.equal(browser.element("executionPlanList").innerHTMLWrites, initial[0], "operation progress must not rebuild Plan cards");
  assert.equal(browser.element("operationList").innerHTMLWrites, initial[1], "operation progress uses row patches instead of replacing the list HTML");
  assert.equal(browser.element("taskBatchActions").innerHTMLWrites, initial[2], "operation progress must not rebuild task controls");

  const beforeGpu = ["executionPlanList", "operationList", "taskBatchActions"].map((id) => browser.element(id).innerHTMLWrites);
  const gpuOnly = { ...operationProgress, gpu: { refreshedAt: "2026-01-01T00:00:03Z", workers: [1] }, workerTelemetry: { refreshedAt: "2026-01-01T00:00:03Z" } };
  onMessage({ data: { type: "state", seq: 3, state: gpuOnly } });
  [...browser.frames.values()].at(-1)();
  assert.deepEqual(["executionPlanList", "operationList", "taskBatchActions"].map((id) => browser.element(id).innerHTMLWrites), beforeGpu);
});

test("offscreen result sections stay dirty through five updates per second and render the latest state once", () => {
  const browser = fakeBrowser();
  const main = browser.element("mainColumn");
  const resultsCard = browser.element("results-section-fixture");
  let resultsTop = 1200;
  main.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 1000, width: 1000, height: 800 });
  main.querySelector = (selector) => selector === '[data-section="results"]' ? resultsCard : null;
  resultsCard.getBoundingClientRect = () => ({ top: resultsTop, bottom: resultsTop + 300, left: 0, right: 1000, width: 1000, height: 300 });
  browser.document.querySelector = (selector) => selector === '[data-section="results"]' ? resultsCard : null;
  const script = extractScript(renderStampedPanelHtml());
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  const onMessage = browser.windowListeners.get("message")?.values().next().value;
  const renderFrames = () => {
    let iterations = 0;
    while (browser.frames.size) {
      assert.ok(++iterations < 20, "visible section rendering must stay frame-bounded");
      [...browser.frames.values()].forEach((frame) => frame());
    }
  };
  for (let seq = 1; seq <= 5; seq += 1) {
    onMessage({ data: { type: "state", seq, state: {
      plans: [], recentPlans: [],
      sectionRevisions: { results: seq },
      sectionPayloads: { results: { status: "loaded" } },
      resultsSummary: { lastParsedAt: "LATEST_RESULT_UPDATE_" + seq },
      resultOutputConfig: { catalog: { datasets: [{ datasetId: "dataset-" + seq, name: "LATEST_DATASET_" + seq }] }, tables: [] },
      experimentTraces: [],
    } } });
    renderFrames();
  }
  assert.equal(browser.element("resultSummary").innerHTMLWrites, 0, "offscreen sections skip view-model and DOM work during state updates");
  resultsTop = 100;
  for (const listener of main.listeners?.get("scroll") || []) listener();
  renderFrames();
  const resultSummary = browser.element("resultSummary");
  assert.equal(resultSummary.innerHTMLWrites, 1, "scroll entry renders only the latest dirty state once");
  assert.match(resultSummary.innerHTML, /LATEST_RESULT_UPDATE_5/);
  assert.ok(browser.sent.findLast((message) => message.command === "webviewSectionInterest")?.interest.visibleSections.includes("results"));
});

test("operation and task progress updates patch stable rows in place", () => {
  const browser = fakeBrowser();
  const main = browser.element("mainColumn");
  const executionCard = browser.element("execution-section-fixture");
  main.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 1000, width: 1000, height: 800 });
  main.querySelector = (selector) => selector === '[data-section="execution"]' ? executionCard : null;
  executionCard.getBoundingClientRect = () => ({ top: 10, bottom: 700, left: 0, right: 1000, width: 1000, height: 690 });
  browser.document.querySelector = (selector) => selector === '[data-section="execution"]' ? executionCard : null;
  const leaf = (text, attributes = {}) => {
    const attrs = new Map(Object.entries(attributes));
    const classes = new Set();
    return {
      textContent: text || "", hidden: false, style: {},
      getAttribute(name) { return attrs.get(name) || null; },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      classList: {
        add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); },
      },
      hasClass(name) { return classes.has(name); },
    };
  };
  const operationStatus = leaf("运行中");
  operationStatus.classList.add("status-running");
  const operationText = leaf("运行中");
  const operationMessage = leaf("live 1");
  const operationProgress = leaf("进度 epoch 1");
  const operationTime = leaf("");
  const operationCard = {
    getAttribute(name) { return name === "data-operation-render-key" ? "operation-a" : null; },
    querySelector(selector) {
      return {
        "[data-operation-message]": operationMessage,
        "[data-operation-progress]": operationProgress,
        "[data-operation-status-label]": operationStatus,
        "[data-operation-status-text]": operationText,
        "[data-operation-status-loading]": leaf(""),
        "[data-operation-time]": operationTime,
      }[selector] || null;
    },
  };
  const taskStatus = leaf("运行中");
  const taskProgress = leaf("epoch 1");
  const taskProgressPill = leaf("");
  const taskTime = leaf("");
  const taskCard = {
    getAttribute(name) { return name === "data-task-render-key" ? "task:run-a" : null; },
    querySelector(selector) {
      return {
        "[data-task-status-label]": taskStatus,
        "[data-task-time]": taskTime,
        "[data-task-progress-value]": taskProgress,
        "[data-task-progress]": taskProgressPill,
      }[selector] || null;
    },
  };
  let operationPatchVisits = 0;
  let taskPatchVisits = 0;
  browser.element("operationList").querySelectorAll = (selector) => { if (selector === "[data-operation-render-key]") operationPatchVisits += 1; return selector === "[data-operation-render-key]" ? [operationCard] : []; };
  browser.element("executionPlanList").querySelectorAll = (selector) => { if (selector === "[data-task-render-key]") taskPatchVisits += 1; return selector === "[data-task-render-key]" ? [taskCard] : []; };
  const script = extractScript(renderStampedPanelHtml());
  vm.runInNewContext(script, browser.context, { filename: "panel-render-health.js" });
  const onMessage = browser.windowListeners.get("message")?.values().next().value;
  const renderFrames = () => [...browser.frames.values()].forEach((frame) => frame());
  const base = {
    plans: [], recentPlans: [], distributedPlans: [], deferredPlans: [],
    sectionPayloads: { execution: { status: "loaded" } },
    selection: { selectedPlanId: "experiments/plans/a.yaml", selectedTaskUiKeys: [] },
    operations: { "operation-a": { id: "operation-a", type: "run-plan", planFile: "experiments/plans/a.yaml", status: "running", progress: "epoch 1", message: "live 1", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" } },
    schedulerStates: [{ id: "run-a", runKey: "run-a", experimentId: "exp-a", experimentName: "Task A", planFile: "experiments/plans/a.yaml", status: "running", progress: "epoch 1", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }],
  };
  onMessage({ data: { type: "state", seq: 1, state: base } });
  renderFrames();
  assert.ok(browser.sent.filter((message) => message.command === "webviewSectionTelemetry").some((message) => message.samples.some((sample) => sample.section === "execution" && !sample.skipped)), "visible execution section should render in the fixture");
  const initialOperationWrites = browser.element("operationList").innerHTMLWrites;
  const initialTaskWrites = browser.element("executionPlanList").innerHTMLWrites;
  const latest = {
    ...base,
    operations: { "operation-a": { ...base.operations["operation-a"], progress: "epoch 3", message: "live 3", updatedAt: "2026-01-01T00:00:03Z" } },
    schedulerStates: [{ ...base.schedulerStates[0], progress: "epoch 3", updatedAt: "2026-01-01T00:00:03Z" }],
  };
  onMessage({ data: { type: "state", seq: 2, state: latest } });
  renderFrames();
  assert.ok(operationPatchVisits >= 2, "stable operation rows were visited by the in-place patcher");
  assert.ok(taskPatchVisits >= 2, "stable task rows were visited by the in-place patcher");
  assert.equal(browser.element("operationList").innerHTMLWrites, initialOperationWrites);
  assert.equal(browser.element("executionPlanList").innerHTMLWrites, initialTaskWrites);
  assert.equal(operationProgress.textContent, "进度 epoch 3");
  assert.equal(operationMessage.textContent, "live 3");
  assert.equal(operationText.textContent, "执行中");
  assert.equal(taskProgress.textContent, "epoch 3");

  const statusTransition = { ...latest, operations: { "operation-a": { ...latest.operations["operation-a"], status: "queued" } } };
  onMessage({ data: { type: "state", seq: 3, state: statusTransition } });
  renderFrames();
  assert.equal(browser.element("operationList").innerHTMLWrites, initialOperationWrites, "same live action topology keeps the operation row in place");
  assert.equal(operationText.textContent, "排队");
  assert.equal(operationStatus.hasClass("status-running"), false);
  assert.equal(operationStatus.hasClass("status-queued"), true);
});

test("transient config drafts survive a generated document replacement through VS Code webview state", () => {
  const script = extractScript(renderStampedPanelHtml());
  const firstOptions = { taskCheckboxes: [] };
  const first = fakeBrowser(firstOptions);
  vm.runInNewContext(script, first.context, { filename: "panel-render-health.js" });
  const draft = first.element("config-draft");
  draft.dataset = { configInput: "hub", key: "host" };
  draft.value = "draft-host.example";
  draft.selectionStart = 5;
  draft.selectionEnd = 5;
  first.document.activeElement = draft;
  const selectedTask = first.element("selected-task");
  selectedTask.dataset = { command: "selectExperiment", workerId: "worker-a", taskUiKey: "task-a", actionKey: "run-a", planFile: "experiments/plans/a.yaml" };
  selectedTask.checked = true;
  firstOptions.taskCheckboxes.push(selectedTask);
  for (const listener of first.documentListeners.get("input") || []) listener({ target: draft });
  const toggle = first.element("config-toggle");
  toggle.dataset = { configInput: "hub", key: "enabled" };
  toggle.type = "checkbox";
  toggle.checked = true;
  for (const listener of first.documentListeners.get("input") || []) listener({ target: toggle });
  assert.equal(first.webviewState.transientPanelState.configDrafts.hub.host, "draft-host.example");
  assert.equal(first.webviewState.transientPanelState.activeInput.selectionStart, 5);
  assert.equal(first.webviewState.transientPanelState.selectedTaskTargets[0].workerId, "worker-a");

  const secondOptions = { initialState: first.webviewState, fastPath: true, selectConfigInputs: true, taskCheckboxes: [] };
  const second = fakeBrowser(secondOptions);
  const restored = second.element("restored-config-draft");
  restored.dataset = { configInput: "hub", key: "host" };
  const restoredTask = second.element("restored-task");
  const restoredToggle = second.element("restored-config-toggle");
  restoredToggle.dataset = toggle.dataset;
  restoredToggle.type = "checkbox";
  restoredToggle.checked = false;
  restoredTask.dataset = selectedTask.dataset;
  restoredTask.checked = false;
  secondOptions.taskCheckboxes.push(restoredTask);
  vm.runInNewContext(script, second.context, { filename: "panel-render-health.js" });
  const onMessage = second.windowListeners.get("message")?.values().next().value;
  onMessage({ data: { type: "state", seq: 1, state: { plans: [], recentPlans: [] } } });
  [...second.frames.values()].at(-1)();
  assert.equal(restored.value, "draft-host.example");
  assert.equal(restored.selectionStart, 5);
  assert.equal(restoredTask.checked, true);
  assert.equal(restoredToggle.checked, true);
});
