# Panel Payload and Render Optimization

Scope: measure serialized full-state cost; add generation-scoped section interest and explicit not-loaded projections; defer offscreen work; use bounded section revisions; update stable execution rows in place; record bounded render timing. Preserve render ACK/backpressure, existing execution render keys, scheduler semantics, durable queue, and all result/history data.

## TODO

- [x] Add exact serialized top-level field attribution, latest top eight summary, and one-minute byte total to host-only diagnostics.
- [x] Add generation-scoped Webview section interest and latest-state projections for result catalog/tables/traces, GPU history, and execution history; retain light summaries and active/current-Plan evidence.
- [x] Defer offscreen section model/signature/DOM work, mark it dirty, and render only latest state on viewport entry or explicit navigation/interaction.
- [x] Add bounded host section revisions and short-circuit unchanged sections before Webview model/signature work.
- [x] Patch execution operation/task progress DOM for unchanged row identities; preserve existing bounded list rendering.
- [x] Record the latest 32 section samples with signature/model/DOM/total time and skipped reason as telemetry only.
- [x] Add focused projection, attribution, revision, offscreen/latest-only, and progress-patching regressions; rerun existing Panel flow/progress/render/lifetime tests serially.
- [x] Build, run Webview `vm.Script`, package once after a single patch bump, install once, verify installed version/entry, then stop panel operations pending user reload (`0.5.209`; `simpleex --help` resolves).
- [ ] Capture comparable live before/after payload bytes, top fields, bytes/min, section times, and render ACK latency; do not claim live improvement without both samples.
- [x] Inspect and push only this batch to `origin/master`; exclude both user-dirty `.pyc` files and leave them as workspace changes.

## Baseline from current source

- `PanelStateFlowControl`, explicit `webviewStateRendered`, one-unrendered-state backpressure, and execution Plan/operation/task render keys already exist and are protected.
- `buildState()` currently includes result catalog/tables, GPU history snapshot, scheduler rows, distributed job history, experiment traces, and operation history in full state.
- `flushStatePost()` already records total serialized payload bytes and one-minute full-state bytes; it has no top-level attribution.
- `renderVisibleSections()` visits every expanded resource section; `renderSectionIfVisible()` computes the section model/signature before any viewport check.
- `sectionSlow` diagnostics are bounded to 32 slow-render rows; per-stage timings and skipped section samples are absent.
- Live baseline unavailable at task start: SimpleExperiment/SimpleSFTP discovery files and listeners are absent, so live diagnostics cannot be queried until the extension host is reloaded. No fixture/simulation numbers will be presented as live measurements.

## Validation record

- Passed individually with the required Node timeout: `panelStateProjection.test.js` (3), `panelProgressDom.test.js` (2), `panelStateFlowControl.test.js` (10), `panelStateProgress.test.js` (13), `panelRenderHealth.test.js` (12), `panelLifetimeRecovery.test.js` (11), and `panelWebviewScriptHealth.test.js` (1).
- Pre-release `npm run build` passed. The required `node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"` gate passed.
- The 5 updates/second simulation retained one outstanding full state and coalesced the pending changes. The offscreen test withheld results rendering for five updates, then rendered the latest state once on viewport entry. Stable operation/task progress patches changed rows in place without changing their list HTML write count.
- `npm run package` passed at `0.5.209` (331 files, 2.02 MB); `npm run install:latest` installed `simple-local.simple-experiment@0.5.209`. `simpleex --help` resolved to the installed CLI. Panel operations stopped after installation, pending user window reload.
- Code batch committed as `10512154` and pushed to `origin/master`; post-push `HEAD` matched `origin/master`. The two dirty `.pyc` files remained unstaged.
- Live before/after payload and ACK measurements are still unavailable: SimpleExperiment/SimpleSFTP discovery files are absent, and the required post-install Webview sample must wait until the user reloads the window. No live improvement percentage is claimed.

## 0.5.209 Compatibility Closeout

- [x] Keep legacy `webviewRenderError` `performanceWarning` messages on bounded performance telemetry only; do not mutate failure, lifecycle, or action-error state.
- [x] Align lifecycle diagnostics tests with `recordPanelSectionTelemetry` and verify historical `sectionSlow` filtering, generation fencing, ring bound, and per-stage fields.
- [x] Align message dispatch mocks and verify rendered ACK, current/stale telemetry, stale section interest, and legacy performance-warning behavior.
- [x] Extend stale-document guard coverage to section interest and telemetry messages.
- [x] Run all requested tests serially, then build and run the Webview `vm.Script` gate without changing the 0.5.209 version.
- [x] Commit and push only the closeout files; leave both dirty `.pyc` files unstaged (`e18eea79`, post-push `HEAD` matched `origin/master`).
- [x] Record live `panel.diagnostics` as unverified because API discovery and a usable Extension Host are unavailable; make no runtime-data claims.

Compatibility closeout validation: `panelLifecycleDiagnostics.test.js` 9/9, `panelMessageDispatch.test.js` 8/8, `panelStaleDocumentHandshake.test.js` 1/1, `panelStateProjection.test.js` 3/3, `panelProgressDom.test.js` 2/2, `panelRenderHealth.test.js` 12/12, `panelStateFlowControl.test.js` 10/10, `panelStateProgress.test.js` 13/13, and `panelLifetimeRecovery.test.js` 11/11 passed individually in sequence. `npm run build` and the required Webview `vm.Script` gate passed; package version stayed `0.5.209`. Live `panel.diagnostics` remains unverified because SimpleExperiment API discovery is unavailable.

## 0.5.210 Plan Selector Summary Recovery

- [x] Capture existing selector status rules and compute bounded per-Plan summaries from unprojected state before execution projection.
- [x] Keep `planStatusSummaries` in every projected state without restoring historical execution rows.
- [x] Prefer trusted summaries in selector status and preserve current revision/latest attempt/distributed/history precedence semantics.
- [x] Add projection and selector regressions for completed, partial, failed, running, revision, retry, distributed priority, summary size, and payload delta.
- [x] Run relevant tests serially, then build and run the Webview `vm.Script` gate.
- [x] Bump package/runtime to `0.5.210` and package the final extension output.
- [x] Install `0.5.210` once, verify the installed version and `simpleex` CLI, then stop SimpleExperiment panel/API calls.
- [x] Capture pre-release live `0.5.209` Plan discovery and retained diagnostics payload baseline; distinguish the hidden-page sample from execution status.
- [ ] After the user runs **Developer: Reload Window**, validate dropdown statuses and collect fresh visible-page payload bytes.
- [x] Commit and push only this task as `c0d940f9`; leave both dirty `.pyc` files unstaged.

Implementation validation: selector 11/11; projection 5/5; Panel flow control 10/10; state progress 13/13; state-post timeout 2/2; render health 12/12; lifetime recovery 11/11; progress DOM 2/2; Webview script health 1/1. All ran one file at a time. `npm run typecheck`, `npm run build`, the required Webview `vm.Script` gate, and `npm run package` passed at `0.5.210`. Fixture payload stayed below 20 KB after projection from a state over 100 KB; summary added under 4 KB. These are synthetic bounds, not MultiModal live measurements.

The pre-release MultiModal snapshot was running `0.5.209`. Its most recent recorded full-state sample was `260,160` bytes at `2026-10-01T15:57:21.471Z`, with 14 ms latest ACK latency and 47 ms recent maximum; `fullStateBytesLastMinute` was 0 and the document was hidden, so this is a retained sample rather than a fresh visible-page measurement. Largest fields were `diagnostics` 56,274 bytes (21.6%), `detectedProject` 44,559 (17.1%), `plans` 41,889 (16.1%), `agentSessions` 32,870 (12.6%), and `operations` 26,380 (10.1%). `plans.list` confirmed `ebmc`, `corim`, `dpl`, `drf`, and `cpsc` exist, but their `ready` value is plan readiness, not execution status; the selector's actual status after this change remains unverified. `npm run install:latest` installed `0.5.210`, and the installed extension inventory plus `simpleex --help` were verified. The last live Extension Host diagnosis before install reported `0.5.209`; no SimpleExperiment API/panel calls were made after installation. The user must run **Developer: Reload Window** before we check the dropdown values and collect a fresh visible-page `payloadBytes` sample.
