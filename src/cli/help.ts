export const SIMPLE_HELP = `Usage: simpleex-mac <domain> <action> [options]

Agent-facing local CLI for SimpleExperiment. Aggregates existing scheduler, worker, result, tunnel, and artifact data.

Domains:
  project      status
  experiment   list | summary | active | overview | health | tree | status | monitor | diagnose | inspect | config | results | batch | run | stop | pause | resume | retry
  plan         list | validate | matrix
  result       list | show | export
  log          show | tail
  metric       list | show
  compare      <id> <id>
  gpu          status
  resource     available
  server       list
  artifact     list | download | inspect

Other commands:
  simpleex-mac api <method> [--json <params.json>]
  simpleex-mac self-check
  simpleex-mac run --name <name> [--seed <seed>] -- <command> [args...]
    Legacy manual local recorder. Official experiments use experiment run with a saved Plan.

Global options:
  --json           strict JSON on stdout
  --compact-json   JSON without raw logs and bulky fields
  --help           show this help

Agent workflows:
  list running experiments:
    simpleex-mac experiment list --type worker_run --status running --json
  diagnose a failure:
    simpleex-mac experiment diagnose <id> --json
  stop through the scheduler:
    simpleex-mac experiment stop <id> --json
  compare two results:
    simpleex-mac compare <id1> <id2> --json
  paper results:
    simpleex-mac experiment results <id> --json

Examples:
  simpleex-mac --help
  simpleex-mac project status
  simpleex-mac experiment tree --json
  simpleex-mac experiment monitor <id> --json
  simpleex-mac log tail <id> --lines 100 --json
  simpleex-mac metric show <id> --json
  simpleex-mac resource available --json
  simpleex-mac experiment run experiments/plans/baseline.yaml --check --dry-run --json

Plan runs use the current VS Code workspace and live workflow preflight.
The initial workflow.run receipt requests a VS Code confirmation; it is not remote submission evidence.
Inspect the returned operationId through operations.list. Offline previews report local_only.
  simpleex-mac artifact inspect <id> --json
`;

export function domainHelp(domain: string): string {
  const rows: Record<string, string> = {
    project: `Usage: simpleex-mac project status [--json]`,
    experiment: `Usage:
  simpleex-mac experiment list [--status <status>] [--type workflow|worker_run] [--limit <n>] [--json]
  simpleex-mac experiment tree [--json]
  simpleex-mac experiment overview [--json] [--full]
  simpleex-mac experiment health [--json]
  simpleex-mac experiment status <id> [--json] [--full]
  simpleex-mac experiment monitor <id> [--json] [--watch]
  simpleex-mac experiment diagnose <id> [--json]
  simpleex-mac experiment inspect <id> [--json] [--full]
  simpleex-mac experiment config <id> [--json]
  simpleex-mac experiment results <id> [--json]
  simpleex-mac experiment batch <plan> [--json]
  simpleex-mac experiment run <plan> [--seed <seed>] [--check] [--dry-run] [--json]
  simpleex-mac experiment stop <id> [--json]
  simpleex-mac experiment pause <id> [--json]
  simpleex-mac experiment resume <id> [--from <stage>] [--json]
  simpleex-mac experiment retry <id> [--from <stage>] [--json]`,
    plan: `Usage:
  simpleex-mac plan list [--json]
  simpleex-mac plan validate <file> [--json]
  simpleex-mac plan matrix <file> [--json]`,
    result: `Usage:
  simpleex-mac result list [--experiment <id>] [--json]
  simpleex-mac result show <id> [--json]
  simpleex-mac result export <id> [--format csv|json] [--out <file>] [--json]`,
    log: `Usage:
  simpleex-mac log show <id> [--json]
  simpleex-mac log tail <id> [--lines <n>] [--json]`,
    metric: `Usage:
  simpleex-mac metric list [--json]
  simpleex-mac metric show <experiment> [--json]`,
    compare: `Usage: simpleex-mac compare <id1> <id2> [--json]`,
    gpu: `Usage: simpleex-mac gpu status [--json]`,
    resource: `Usage: simpleex-mac resource available [--json]`,
    server: `Usage: simpleex-mac server list [--json]`,
    artifact: `Usage:
  simpleex-mac artifact list <experiment_id> [--json]
  simpleex-mac artifact download <id> [--out <path>] [--json]
  simpleex-mac artifact inspect <id> [--json]`,
  };
  return rows[domain] || SIMPLE_HELP;
}
