#!/usr/bin/env node
/** CLI entry; legacy commands remain available through cli.legacy.ts. */
export * from "./cli.legacy";
import { main } from "./cli.legacy";
import { emitCliFailure, isSimpleCommand, runSimpleCli } from "./cli/index";

if (require.main === module) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const run = isSimpleCommand(argv) ? runSimpleCli(argv) : main(argv);
  run
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.exitCode = emitCliFailure(error, json || argv.includes("--compact-json"), argv.includes("--compact-json"));
    });
}
