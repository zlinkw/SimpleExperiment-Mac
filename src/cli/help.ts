export const SIMPLE_HELP = `Usage: simpleex <domain> <action> [options]

Agent-facing local CLI for SimpleExperiment. Aggregates existing scheduler, worker, result, tunnel, and artifact data.

Domains:
  project      status | prepare | bootstrap | bootstrap-operation
  experiment   list | summary | active | overview | health | tree | status | monitor | diagnose | inspect | config | results | batch | run | stop | resume | retry (pause unsupported)
  plan         list | validate <planFile> [--workspace ABS] | filter --file filter.json | cleanup | matrix | build
  result       list | show | export | parse | paper-table
  log          show | tail
  metric       list | show | leaderboard
  compare      <id> <id>
  config       list | get | set | reset (set: --value JSON/text or --file value.json; --scope global|workspace|workspaceFolder; writes require --confirm)
  state        snapshot | list | get | set | reset (set: --value JSON/text or --file value.json; writes require --confirm)
  flow         get | update --file flow.json ({step,completed?,blocked?,appliedAt?})
  tmux         list --worker ID | capture <window> --worker ID
  panel        diagnostics
  gpu          status | history
  resource     available
  server       list | test-all [--file options.json] ({refresh?:boolean})
  artifact     list | download | inspect
  task         dispatch | analyze | preflight start|status|cancel
  draft        list | candidates | validate | promotion-preview | review | reject | cleanup
  agents       lifecycle inspect|ensure|stop|restart|migrate (A-side; B's lives under: simpleex sftp agents lifecycle)
  actions      list | describe <kebab-name> | <kebab-name> --file params.json [--confirm] (live named actions)
  sftp         SimpleSFTP domains (status | capabilities | server | config | target | sync | remote | transfers | confirmations)

Other commands:
  simpleex doctor

Mac identity (macOS build only): this extension installs the CLI as simpleex-mac (extension id
simple-local.simple-experiment-mac, discovery file SimpleExperimentMac-api.json, env
SIMPLE_EXPERIMENT_MAC_API_FILE). Every simpleex ... example below is typed as simpleex-mac ... on
macOS: the two names are the same CLI, and plain simpleex is the Windows install name.
Global options:
  --json           strict JSON on stdout
  --compact-json   JSON without raw logs and bulky fields
  --help           show this help

Agent workflows:
  list running experiments:
    simpleex experiment list --type worker_run --status running --json
  diagnose a failure:
    simpleex experiment diagnose <id> --json
  stop through the scheduler:
    simpleex experiment stop <id> --json
  compare two results:
    simpleex compare <id1> <id2> --json
  paper results:
    simpleex experiment results <id> --json

Examples:
  simpleex --help
  simpleex project status
  simpleex experiment tree --json
  simpleex experiment monitor <id> --json
  simpleex log tail <id> --lines 100 --json
  simpleex metric show <id> --json
  simpleex resource available --json
  simpleex experiment run experiments/plans/baseline.yaml --check --dry-run --json
  simpleex artifact inspect <id> --json
`;

export function domainHelp(domain: string): string {
  const rows: Record<string, string> = {
    config: "Usage: simpleex config list|get|set|reset [key] [--value JSON/text | --file value.json] [--scope global|workspace|workspaceFolder] [--confirm] [--json]",
    state: "Usage: simpleex state snapshot|list|get|set|reset [key] [--value JSON/text | --file value.json] [--confirm] [--json]; writable keys are declared by state list.",
    flow: "Usage: simpleex flow get | update --file flow.json [--json]; fields: step, completed?, blocked?, appliedAt?. completed and blocked cannot both be true.",
    tmux: "Usage: simpleex tmux list --worker ID | capture <explicit-window> --worker ID [--json]; targets use the configured worker endpoint.",
    panel: "Usage: simpleex panel diagnostics [--json]",
    task: `Usage: simpleex task dispatch --workflow ID --jobs 0,1 --worker ID --gpu 0|auto --confirm [--stop-running] [--json]
       simpleex task dispatch --remaining (--workflow ID | --all) --confirm [--json]
       simpleex task analyze --workflow ID --index 0 [--json]
       simpleex task analyze --worker ID --command COMMAND_ID --output JOB_OUTPUT_DIR [--json]
       simpleex task preflight start --worker ID --command ID [--environment-only] [--completed-output-verify] [--json]
       simpleex task preflight status|cancel --worker ID --operation-id formal-preflight-… [--json]
            (backend contract legacy.ts:14314-14362: start needs workerId+commandId, strict booleans forwarded only when given; status/cancel require --operation-id matching ^formal-preflight-[a-zA-Z0-9-]+$; the backend defines no confirmation factors here and none are invented; protocol gates like completedOutputPreflight/executionShellPreflight are answered by the live worker as WORKER_PROTOCOL_INCOMPATIBLE)`,
    project: `Usage:
  simpleex project status [--json]
  simpleex project prepare [--workspace <abs>] [--mode worker_pool] [--server-ids a,b] [--workers workerTunnels.json] [--plan-file <plan>] [--plan-id <id>] [--skip-xshell] [--skip-runtime] [--no-apply-topology] [--start-sessions] [--auto-test] [--legacy-migration-digests digests.json] [--confirm] [--json]
  simpleex project bootstrap [same parameters minus --start-sessions/--auto-test/--no-apply-topology] [--no-start-sessions] [--no-auto-test] [--confirm] [--json]
  simpleex project bootstrap-operation --operation-id <id> [--json]
       confirm is the only confirmation factor the backend defines (requires:["confirm"]): without --confirm the full server preview (missing + preview + echoed params) prints and exits 2 — nothing is written. These entries mutate real infrastructure when confirmed (Xshell sessions, SimpleSFTP profiles, agent runtime deploy, session start): the CLI never auto-fills --confirm and never replays a refused or started call. Hub retirement red line: --hub, hub modes and hub in serverIds are refused locally (HUB_REMOVED, zero RPC) — the CLI offers no Hub configuration path; the backend's legacy-parameter compatibility is untouched. --no-apply-topology is prepare-only (legacy.ts:2317); bootstrap's background run forces applyTopology (:2850) and refuses the opt-out locally. Paired switches (--start-sessions vs --no-start-sessions, --auto-test vs --no-auto-test) and wrong-action switches are input conflicts refused with zero API — intent is never silently ignored.
       bootstrap-operation exit 0 means the QUERY succeeded, NOT that the bootstrap succeeded: read operation.status — pending/running are not failures, and a failed operation echoes status:"failed" with its full error; the CLI never re-submits bootstrap.`,
    draft: `Usage:
  simpleex draft list [--force] [--json]                                        (drafts.list; --force refreshes)
  simpleex draft candidates [--force] [--json]                                  (drafts.cleanupCandidates — the exact paths cleanup accepts)
  simpleex draft validate <draftPlanPath> [--json]                              (drafts.validate; project-relative draft path; a full ok:false report still prints in full JSON but exits BUSINESS 3)
  simpleex draft promotion-preview <draftPlanPath> [--json]                     (drafts.promotionPreview; server refuses unless debug_completed/ready_for_review with a successful debug run)
  simpleex draft review <draftPlanPath> [--reviewed-by <name>] [--json]         (drafts.review; reviewedBy default "local-user" belongs to the backend, never auto-sent)
  simpleex draft reject <draftPlanPath> [--reviewed-by <name>] [--json]         (drafts.reject)
  simpleex draft cleanup --paths paths.json [--confirmed-paths-file confirmed.json] [--confirm] [--path-confirmed] [--json]
       moving drafts into clean_dir requires all three factors: confirm + pathConfirmed + confirmedPaths (the absolute target paths echoed by the preview; any candidate drift invalidates the echo — re-fetch candidates, never replay)
       drafts.promote is retired (DRAFT_PROMOTION_RETIRED): the CLI refuses it with zero RPC and never revives promotion.`,
    agents: `Usage:
  simpleex agents lifecycle inspect --server-ids a,b [--json]                                        (A-side agents.lifecycle; zero-write, no confirmation factors)
  simpleex agents lifecycle ensure|stop|restart --server-ids a,b --confirm [--json]                  (backend requires ["confirm"]; without it the full target/tmux preview prints at exit 2 and nothing changes)
  simpleex agents lifecycle migrate --server-ids a,b --migration-digests digests.json --confirm [--json]   (requires confirm + per-target migrationDigests {serverId: 64-hex} equal to the preview digests; the 2001 preview echoes them — never auto-filled, never replayed)
       This is A's contract (params are exactly {action, serverIds, confirm?, migrationDigests?}): directories, tmux sessions, tokens, ports and the runtime manifest stay host-side setupConfig state — the CLI never sends or invents them. B's sftp agents lifecycle (server-file based, --project-dir/--install-dir/…) is a different command under simpleex sftp and is unaffected. Missing --server-ids (AGENT_TARGET_REQUIRED) and unknown actions (AGENT_ACTION_INVALID) are refused locally with zero RPC. Confirmed mutations touch real remote agents.`,
    actions: `Usage:
  simpleex actions list [--json]
  simpleex actions describe <kebab-name> [--json]
  simpleex actions <kebab-name> [--file parameters.json] [--confirm] [--path-confirmed] [--second-confirmation] [--json]
       Named commands are derived from live catalog command names: checkPluginUpdates becomes check-plugin-updates. The handler validates explicit JSON parameters; confirm/command fields cannot be hidden in the file. Destructive cleanup redirects to the protected plan/draft cleanup commands; retired Hub/promotion actions refuse. All actions except a small read-only set require an explicit --confirm, and additional backend factors remain mandatory. Responses report submissions as submissions, never completed work.
       LIVE catalog from the connected extension host (actions.list): rows {command, safe, confirm, action} + count (the real total for the CURRENT host — saved baselines such as 174 are documentation, never acceptance constants). The list is read-only; named action execution uses the existing backend invoke method after live identity, catalog and confirmation checks. The removed raw API/invoke public entry remains unavailable.
       This help text is STATIC; treat actions list as the authority on what the current host accepts. If the host does not declare actions.list the command fails with -32601 (exit 3) and no local table is substituted. Run work through the named commands (simpleex <domain> --help); a started background operation is only ever reported as started, never as executed.`,
    experiment: `Usage:
  simpleex experiment list [--status <status>] [--type workflow|worker_run] [--limit <n>] [--json]
  simpleex experiment tree [--json]
  simpleex experiment overview [--json] [--full]
  simpleex experiment health [--json]
  simpleex experiment status <id> [--json] [--full]
  simpleex experiment monitor <id> [--json] [--watch]
  simpleex experiment diagnose <id> [--json]
  simpleex experiment inspect <id> [--json] [--full]
  simpleex experiment config <id> [--json]
  simpleex experiment results <id> [--json]
  simpleex experiment batch <plan> [--json]
  simpleex experiment run <plan> [--check] [--dry-run] [--operation <原提交ID>] [--json]
  simpleex experiment stop <id> [--json]
  simpleex experiment pause <id> [--json]
  simpleex experiment resume <id> [--from <stage>] [--json]
  simpleex experiment retry <id> [--from <stage>] [--json]`,
    plan: `Usage:
  simpleex plan list [--json]
  simpleex plan validate <file> [--json]
  simpleex plan matrix <file> [--json]
  simpleex plan build [--suite S] [--base config.yaml] [--seeds 1,2]
  simpleex plan cleanup list [--json]
  simpleex plan cleanup preview --plan-file <plan> [--action move|delete|isolate] [--verified-only] [--continuation-of <operationId>] [--job job.json] [--confirmed-paths] [--exact-paths exactPaths.json] [--reuse-token <token>] [--json]
  simpleex plan cleanup confirm --token T --digest D --phase <n> --targets exactTargets.json [--confirm] [--json]
  simpleex plan cleanup execute|resume|status|cancel|restore --operation-id <id> [--json]
  simpleex plan cleanup continue --operation-id <id> [--verified-only] [--json]   |   recheck --node-id <id> [--json]
       confirmations live in the confirm phases only (delete confirms twice, others once): the exactTargets file must echo the preview rows as ["nodeId:absolutePath", …] in preview order, filtered to disposition==action (digest is order-sensitive); execute/resume carry only the operation id — no confirm factor exists there and none is auto-filled. PREVIEW_EXPIRED/OPERATION_SUPERSEDED/CLEANUP_TARGET_CHANGED answer as business refusals; a completed operation returns idempotently and a started move is only settled, never re-issued.`,
    result: `Usage:
  simpleex result list [--experiment <id>] [--json]
  simpleex result show <id> [--json]
  simpleex result export <id> [--format csv|json] [--out <file>] [--json]
  simpleex result parse --file <f> [--preset <id>] [--json]
  simpleex result paper-table --file <registry.json> [--metrics AUC,accuracy] [--format markdown|csv|latex]`,
    log: `Usage:
  simpleex log show <id> [--json]
  simpleex log tail <id> [--lines <n>] [--json]`,
    metric: `Usage:
  simpleex metric list [--json]
  simpleex metric show <experiment> [--json]
  simpleex metric leaderboard --file <metrics> [--primary <metric>]`,
    compare: `Usage: simpleex compare <id1> <id2> [--json]`,
    gpu: `Usage: simpleex gpu status [--json]`,
    resource: `Usage: simpleex resource available [--json]`,
    server: `Usage: simpleex server list [--json]`,
    artifact: `Usage:
  simpleex artifact list <experiment_id> [--json]
  simpleex artifact download <id> [--out <path>] [--json]
  simpleex artifact inspect <id> [--json]`,
    sftp: `Usage:
  simpleex sftp status [--json]
  simpleex sftp capabilities [--json]
  simpleex sftp server list [--json]
  simpleex sftp server activate <id> --confirm [--json]
  simpleex sftp server delete <id> --confirm [--json]
  simpleex sftp server save --file server.json --confirm [--set-active] [--json]
  simpleex sftp server import-ssh --confirm [--json]
  simpleex sftp server config-path [--json]
  simpleex sftp config list [--json]
  simpleex sftp config get <key> [--json]
  simpleex sftp config set <key> --value <value|JSON> --confirm [--json]
  simpleex sftp config reset <key> --confirm [--json]
  simpleex sftp target show [--path <local path>] [--json]
  simpleex sftp target update --path <local path> --file patch.json --confirm --path-confirmed [--json]
  simpleex sftp sync inventory --file source.json [--path <rel>] [--no-recursive] [--metadata-only] [--paths scope.json] [--json]
  simpleex sftp sync stats --file source.json --paths paths.json [--json]      (1..128 relative paths, no full-project scan)
  simpleex sftp sync tree --file source.json [--path <rel>] [--json]
  simpleex sftp sync tree-state --file source.json [--path <rel>] [--json]
  simpleex sftp sync plan-logs --file source.json --state-path <rel _state.json> --plan-file <plan> [--json]
  simpleex sftp sync delete --file target.json --path <rel> [--json]                    (zero-execution preview: server returns absolutePath + required factors)
  simpleex sftp sync delete --file target.json --path <rel> --confirmed-absolute <abs from the preview> --confirm --path-confirmed --second-confirmation [--json]
  simpleex sftp sync from-remote --path <local path> [--file server.json] [--remote-path <r>] --confirm --path-confirmed [--json]
  simpleex sftp sync download-paths --path <local path> --file server.json --paths paths.json --confirm --path-confirmed [--json]
  simpleex sftp sync download-mapped --path <local path> --file server.json --entries entries.json [--memory-only] [--metrics-only] [--overwrite] [--max-file-bytes N] [--max-batch-bytes N] [--compression auto|gzip|none] --confirm --path-confirmed [--json]
  simpleex sftp sync server-to-server --file source.json --destination dest.json --path <rel> [--directory] [--manual-retain] [--compression auto|gzip|zstd|none] [--single-stream] --confirm --path-confirmed [--json]   (--delete-only refused: backend gates that delete with only confirm+pathConfirmed; permanent deletes go through sftp sync delete with all four factors)
  simpleex sftp sync server-batch --file source.json --destination dest.json --paths paths.json [--compression auto|gzip|zstd|none] [--single-stream] --confirm --path-confirmed [--json]
  simpleex sftp sync fpsync --file source.json --destination dest.json (--directory --path <rel> | --paths paths.json) [--manual-retain] [--compression auto|gzip|zstd|none] [--single-stream] --confirm --path-confirmed [--json]
  simpleex sftp upload workspace --path <local path> [--file server.json] [--manifest manifest.json] --confirm --path-confirmed [--json]
  simpleex sftp upload files --base <local base> (--files files.json and/or --manifest manifest.json) [--file server.json] --confirm --path-confirmed [--json]
  simpleex sftp project create --remote-path <remote dir> [--path <local path>] [--file server.json] --confirm --path-confirmed [--json]
  simpleex sftp handoff mark-ready --path <local path> [--file server.json] --confirm --path-confirmed [--json]
  simpleex sftp scope configure --path <local path> [--file server.json] [--remote-path <r>] [--paths paths.json] [--extensions .csv,.json] [--max-file-size-mb N] --confirm --path-confirmed [--json]
  simpleex sftp cleanup inspect --file node.json --target target.json [--manifest-only] [--presence-only] [--allow-missing] [--observe-executors] [--json]
  simpleex sftp cleanup observe-batch --file node.json --observation-id ID --targets targets.json [--read-concurrency 1|2] [--root-identity identity.json] [--json]      (1..5000 targets; read-only; targets may carry backendToken/backendIndex/isolationRelativePath — forwarded verbatim)
  simpleex sftp cleanup preview --file node.json --action move|delete|restore|isolate --targets targets.json [--confirmed-paths] [--observation-mode managed_tmux] [--tmux-session-prefix P] [--json]   (backend-verified read-only: no journal, no remote write; issues a 30-minute preview token + digest; confirmed-paths = permanent-delete batch, max 5000)
  simpleex sftp cleanup confirm --token T --digest D --phase 1|2 --targets absolutePaths.json --confirm [--json]   (exact digest + exact absolute path echo; delete confirms twice; any path drift invalidates the preview — re-preview, never replay)
  simpleex sftp cleanup execute --token T --digest D --index N [--json]      (protected journaled path; engine requires both confirmations for deletes and re-checks every entry identity; uncertain receipts resolve via verify, never a blind resend)
  simpleex sftp cleanup status --token T [--json]  |  cleanup check|verify --token T --index N [--json]  |  cleanup settle --token T --digest D --index N [--json]
  simpleex sftp agents lifecycle inspect|ensure|stop|restart|migrate --project-dir <abs> --install-dir <abs> --worker-id ID --port <1-65535> [--state-dir <abs>] [--worker-state-dir <abs>] [--host H] [--conda-env E] [--session-prefix P] [--tmux-session <…-agent>] [--tmux-window W] [--file server.json] [--agent-token T] [--confirm --path-confirmed] [--json]
       ensure|restart additionally require --expected-version V --files hashes.json (64-hex sha256 for cluster_agent.py and cluster_scheduler.py); migrate requires --migration-digest <64 hex>; inspect is zero-write and needs no confirmations
  simpleex sftp remote list-dirs --remote-path <dir> [--file server.json] [--path <local path>] --confirm --path-confirmed [--json]
  simpleex sftp transfers list [--json]
  simpleex sftp transfers reconcile --operation-id <id> [--operation-instance-id <id>] [--retry-method <m>] [--retry-params file] [--request-key <k>] [--json]
  simpleex sftp transfers cancel (--transfer-id <id> | --operation-id <id>) [--reason <text>] [--operation-instance-id <id>] [--json]
Multi-window targeting: --instance <pid:startedAt> (or SIMPLE_CLI_INSTANCE_ID, CLI flag wins) verifies the current discovery target against the pin and refuses before the RPC on mismatch; to address a different window/profile point SIMPLE_*_API_FILE at its discovery — a pin alone never switches targets.
Confirmation-required actions without --confirm print the server preview and change nothing.`,
    doctor: `Usage: simpleex doctor [--json] [--plugin experiment|sftp|both]
       [--instance <pid:startedAt> with --plugin <one>] [--instance-experiment <id>] [--instance-sftp <id>]
Checks the selected plugin discovery files (default both), live capabilities, and instance identity (pid:startedAt must match capabilities.instanceId).
A pin only verifies the discovery target the command already uses; it cannot discover or switch to another window/profile — point SIMPLE_*_API_FILE at a discovery file to target a different instance.`,
  };
  return rows[domain] || SIMPLE_HELP;
}
