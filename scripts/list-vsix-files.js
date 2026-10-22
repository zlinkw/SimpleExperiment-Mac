"use strict";
// The lockfile-pinned VSCE CLI's `ls` action delegates to this same function.
// Load its package reader directly so a read-only inventory does not initialize
// publishing and cloud authentication modules on the Windows shared filesystem.
require("@vscode/vsce/out/package").listFiles({ dependencies: false }).then(files => {
  process.stdout.write(JSON.stringify(files));
}, error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
