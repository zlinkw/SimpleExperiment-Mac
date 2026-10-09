# Testing

Commands:

- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run test:scenarios`
- `npm run build`
- `npm run package`
- `npm run smoke`
- `npm run acceptance`
- `npm run check:static`

## 禁止阻塞测试（P0）

### P0 — 禁止会挂起的测试进程

生产代码 `dist/runtime/cluster_scheduler.py` 与 `src/clusterSchedulerRuntime.legacy.ts` 的 `wait_for_plan_queue()` 在前序 Plan 未完成时执行 `while True`，并调用全局 `time.sleep(5)`。只替换 `scheduler.time.sleep` 不能打断它。

编写或修改会启动 Python 的 `node:test` 时：

- 禁止用 `python -c` 执行长脚本；写入临时 `.py` 后运行，测试结束删除。
- 禁止 import 或 exec 完整 `cluster_agent.py`、`cluster_scheduler.py`。只提取被测函数及其 import。
- 调用 `wait_for_plan_queue` 前，前序 Plan 必须已经完成；不得进入 sleep 循环。
- `spawnSync` 必须设置 `timeout <= 10000`、`windowsHide: true`，并断言 `status === 0`。
- Windows 上 `os.kill(pid, 0)` 对存活进程也会抛错，进程存活判断必须可注入测试替身。

运行测试时：

- 先单独运行目标测试文件，禁止一开始执行 `npm test` 或 `node --test test/**/*.test.js`。
- 同一时间只允许一个 node/python 测试进程，禁止并行工具调用。
- 使用 `node --test --test-force-exit --test-timeout 20000 <单个文件>`。
- 20 秒未退出即停止，不重试，不修改生产代码来“修测试”。

Scenario tests use `src/testing/FakeClusterRuntime.ts` and `src/testing/ScenarioRunner.ts`.

Final fake/mock acceptance:

- `npm run acceptance` runs build, typecheck, lint, unit tests, scenario tests, JS syntax checks, CLI status, package, database dependency check, documentation check, and scenario coverage check.
- It writes reports under `simple_cluster/reports/acceptance/`.
- It does not require real SSH servers. Use `docs/manual-acceptance-checklist.md` for optional real cluster checks.

Static check (`scripts/check-static.js`, via `npm run check:static`):

- Reuses `PlanValidator.validatePlan` (Plan structure), a three-channel
  output-interface heuristic (`run_wrapper` / `collect_outputs|write_metrics_summary` /
  TensorBoard `SummaryWriter`, per `src/clusterSchedulerRuntime.legacy.ts:742-789`),
  and path safety via `isSafeRemotePath` + `safeRemoteProjectChild`.
- Scans plan files (`experiments/plans/**/*.yaml`, `plan*.yaml`) plus
  `experiments/simple_project.yaml` under `--project <dir>` (default: repo root).
- Prints `overall=passed|failed` with per-finding fixes; exits non-zero on errors
  (or on warnings with `--fail-on-warning`); `--json` emits the machine report.
- Plan 校验一律走 `npm run check:static`（禁直调 `validatePlan` 单函数）；
  `suite/mode/seeds/cases/base_config` 按 `mode` 缺命令走 G1 critical。
- 报告落盘：`failed` 自动写 `simple_cluster/check_reports/check-static-latest.md`，
  `passed` 仅 `--write-md` / `--report-md`（别名，等价）写；`--json` 报告含
  `reportWritten`（落盘成功 `true`，写失败/未写 `false`）。
- Finding 口径（60 注册 id：`CHECK_STATIC_ID_SRC` 53 检查位 + 7 legacy
  裸 id 锚点；旧 47 种文档口径/旧 51 口径已过期）：
  `result_schema` 已按 summary/case 拆分为 4 个独立 id
  （`result_schema_summary_missing_columns|_bad_value`、
  `result_schema_case_missing_columns|_bad_value`），避免同 file+id
  去重混淆；绘图五文件共用 `plotting_contract_missing_file`，MD 中
  `[DUP]` 仅为同 file+id 去重标记（五缺项各独立，key 见 message）。
- `ID_SRC` 行号动态提取优先（构造位 `id: "<id>"` > `=== "<id>"`
  判定位 > 首个含引号 id 的行），静态表仅兜底、允许 ± 漂移（以动态
  提取为准）；兜底锚 `scripts/check-static.js:1322`（随 `writeFileSync`
  行移动重锚），未注册 id 直接抛错；新增 id 须同步静态表
  `CHECK_STATIC_ID_SRC` + `refTemplateFor`；`GOOD_PLAN_REF` 未注册模板
  直接抛错（fail-loud，不静默回退、不再断言 GOOD 回退）。
- K6 去重双键（`scripts/check-static.js:1272-1316` 全段 45 行，
  其中明细渲染 `1273-1316` 计 44 行；静态表 `1032-1093` 计 62 行）：
  全局键 `key = file::severity::refId::message[0:120]`
  （`seenGlobal: Set`，`1288-1290` 行，首现全量、之后 `isDup`）与
  同文件键 `fk = file::refId`（`seenFileId: Map` 计数 `n`，
  `1291-1293` 行，同 file+id 首个 `n=1`、之后 `n>1`）；标记
  `mark = isDup || n > 1 ? "[DUP]" : "[NEW]"`（`1294` 行）。
  `[DUP]` 块仍保留文件/severity/message/suggestion 全量字段
  + 参考模板源码块以便定位（`1295-1312` 行）；`isDup` 块追加
  `- 去重: [DUP] …` 行（`1304` 行），`plotting_contract_missing_file`
  五缺项各追加独立说明行、定位以各块 message 中的 key 为准
  （`1305-1308` 行）。静态表拆分：`1032-1093` 静态表本体 62 行
  （60 条目：53 检查位 + 7 legacy 裸 id，含 1 行 legacy 注释；
  `1094` 行 `};` 不计，`1095-1096` 注册表注释+`Set` 另计）；
  渲染拆分：`1272` 首行明细注释 + `1273-1316` 明细渲染 44 行
  （`FENCE`/`all`/`seenGlobal`/`seenFileId`/`findings明细`/`forEach`
  全量，`1314-1316` 收尾 3 行计入）。行号以
  `python -c "lines=open('scripts/check-static.js',encoding='utf-8').read().splitlines()"`
  实测为准（`1032-1093=62`、`1273-1316=44`、`1272-1316=45`），
  随源码移动重锚；门禁与 P0 一致：`npm run build`
  （含 `node -c dist/extension.js && node -c dist/ui/PanelHtml.js`）
  + `npm run check:static` 双重校验。

Scenarios live under `scenarios/` and cover:

- run plan success
- worker offline during run
- Agent restart recovery
- stream journal gap
- delete sync race
- runtime upgrade rollback
