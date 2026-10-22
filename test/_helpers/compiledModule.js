const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// A leaf module runs with its own platform context; the test process is unchanged.
function compiledModule(filename, platform, overrides = {}) {
  const subject = { exports: {} }, localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: subject, exports: subject.exports, process: { ...process, platform },
    Buffer, TextDecoder, AbortController, AbortSignal, URL, URLSearchParams, console, setTimeout, clearTimeout,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
  }, { filename });
  return subject.exports;
}

module.exports = { compiledModule };
