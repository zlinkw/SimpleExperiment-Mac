# Panel render ACK and backpressure TODO

Baseline: `master` at `1353c3b0` (`0.5.207`). The two user-dirty runtime `.pyc` files remain protected and must stay unstaged.

Scope: explicit Webview render ACKs, one-outstanding full-state backpressure, accurate session/historical diagnostics, bounded render-performance telemetry, execution sub-render caching, deterministic pressure/recovery tests, and one patch release after all checks. Do not change scheduler/Agent behavior or deploy/restart Workers.

## Work

- [x] Add and test a pure `PanelStateFlowControl` state machine for document generations, visibility, posted/delivered/rendered stages, one outstanding render, latest-wins dirty state, and bootstrap rules; pure suite passes (9 tests, including a 10-minute virtual load).
- [x] Integrate explicit `webviewStateRendered` ACKs in the Webview and Host; retain heartbeat rendered values only as fallback evidence.
- [x] Enforce hidden suppression and render-level backpressure in Host state posting; expose bounded traffic, payload, ACK latency, and outstanding-state diagnostics.
- [x] Separate current Extension Host session failure from historical lifecycle failures; move `sectionSlow` to a bounded performance ring.
- [x] Split execution rendering into independent Plan-list, operation, and task-action keys without unrelated recomputation.
- [x] Limit automatic recovery to one per Extension Host session and expose recovery-loop counters.
- [x] Add protocol, lifecycle, execution rendering, and 10-minute-equivalent pressure tests, including renderer freeze recovery.
- [x] Run requested focused tests serially, project gates, build, Webview `vm.Script` checks, and package verification.
- [x] On document replacement, invalidate stale state-post callbacks and retry timers so the new document can bootstrap independently.
- [x] After validation, increment patch version once to `0.5.208`, package/install once, verify installed extension and `simpleex` entry; leave live panel acceptance to post-reload user session.
- [x] Inspect scoped diff, commit only batch files, push ordinary fast-forward to `origin/master`, fetch, and verify `HEAD == origin/master`; code commit `f82659a0` is on `origin/master`.

## Current evidence

- [x] Read `AGENTS.md`, `docs/project-constraints.md`, request attachment, and `git status`.
- [x] Confirmed working tree has only the two protected user-dirty `.pyc` files before this TODO.
- [x] Package verification passed; installed `simple-local.simple-experiment@0.5.208`; the `simpleex.cmd` -> `dist/cli.js` entry resolved. Live panel acceptance remains pending a user reload.
- [x] Scoped code commit `f82659a0` pushed to `origin/master`; the two protected `.pyc` files remain dirty and unstaged.
- [x] Source tests: 9 flow-control, 13 state-progress, 10 render-health, 9 lifecycle-diagnostics, 11 lifetime-recovery, 4 unknown-health, 8 message-dispatch, 1 stale-document, 7 bootstrap, 3 section-boundary, and 1 Webview-script test passed serially.
- [x] Build/typecheck and explicit generated `PanelHtml.js` `vm.Script` gate passed; post-build long-session integration passed (2 tests).
- [x] Ten-minute virtual stress (800 KiB payload, 5 mutations/s, 2 hidden minutes): 2,400 full states total, 300/min visible and 0 hidden; 196,608,000 bytes per simulated minute / 245,760,000 per visible minute; maximum outstanding 1; 2,398 render ACKs, mean latency 154.7 ms, max 300 ms; eight simulated 300 ms execution renders; zero simulated recovery.
- [ ] Live 5-minute visible / hidden-panel acceptance requires the user to reload the installed extension and cannot be claimed from static tests.
