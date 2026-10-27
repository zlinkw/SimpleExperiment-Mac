#!/usr/bin/env node
/** Single-entry CLI; the legacy dispatcher is revoked from the public surface (kernels stay importable in cli.legacy.ts). */
export * from "./cli.legacy";
import { emitCliFailure, runSimpleCli } from "./cli/index";

if (require.main === module) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const run = runSimpleCli(argv);
  run
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.exitCode = emitCliFailure(error, json || argv.includes("--compact-json"), argv.includes("--compact-json"));
    });
}
