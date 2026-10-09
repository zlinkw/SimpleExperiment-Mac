export const SIMPLE_HELP = `Usage: simpleex <domain> <action> [options]

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
  simpleex api <method> [--json <params.json>]
  simpleex self-check
  simpleex run --name <name> [--seed <seed>] -- <command> [args...]

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
    project: `Usage: simpleex project status [--json]`,
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
  simpleex experiment run <plan> [--seed <seed>] [--check] [--dry-run] [--json]
  simpleex experiment stop <id> [--json]
  simpleex experiment pause <id> [--json]
  simpleex experiment resume <id> [--from <stage>] [--json]
  simpleex experiment retry <id> [--from <stage>] [--json]`,
    plan: `Usage:
  simpleex plan list [--json]
  simpleex plan validate <file> [--json]
  simpleex plan matrix <file> [--json]`,
    result: `Usage:
  simpleex result list [--experiment <id>] [--json]
  simpleex result show <id> [--json]
  simpleex result export <id> [--format csv|json] [--out <file>] [--json]`,
    log: `Usage:
  simpleex log show <id> [--json]
  simpleex log tail <id> [--lines <n>] [--json]`,
    metric: `Usage:
  simpleex metric list [--json]
  simpleex metric show <experiment> [--json]`,
    compare: `Usage: simpleex compare <id1> <id2> [--json]`,
    gpu: `Usage: simpleex gpu status [--json]`,
    resource: `Usage: simpleex resource available [--json]`,
    server: `Usage: simpleex server list [--json]`,
    artifact: `Usage:
  simpleex artifact list <experiment_id> [--json]
  simpleex artifact download <id> [--out <path>] [--json]
  simpleex artifact inspect <id> [--json]`,
  };
  return rows[domain] || SIMPLE_HELP;
}
