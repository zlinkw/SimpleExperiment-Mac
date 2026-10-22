const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
function writePythonFixture(script, prefix = "isolated-runtime-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(directory, "fixture.py"); fs.writeFileSync(file, script, "utf8"); return file;
}
function isolatePythonRuntime(script, alias) {
  const pattern = /^spec = importlib\.util\.spec_from_file_location\([^\n]*?, ([^\n]+)\)\n[\s\S]*?^spec\.loader\.exec_module\((\w+)\)/m;
  const block = pattern.exec(script);
  if (!block || block[2] !== alias) throw Error("Expected one explicit runtime loader");
  const roots = [...new Set([...script.matchAll(new RegExp("\\b" + alias + "\\.(\\w+)", "g"))].map(match => match[1]))];
  const header = `import sys
sys.path.insert(0, ${JSON.stringify(__dirname)})
from extractRuntimeFunctions import extract_runtime_functions
${alias} = extract_runtime_functions(${block[1]}, ${JSON.stringify(roots)})
${alias}.__file__ = str(${block[1]})`;
  const isolated = script.replace(pattern, header);
  if (/spec\.loader\.exec_module/.test(isolated)) throw Error("Whole runtime loading remains");
  return isolated;
}
function isolatePythonGlobals(runtime, roots, script) {
  const bodyFile = writePythonFixture(script, "isolated-runtime-body-");
  return `import sys
sys.path.insert(0, ${JSON.stringify(__dirname)})
from extractRuntimeFunctions import extract_runtime_functions
_runtime = extract_runtime_functions(${JSON.stringify(runtime)}, ${JSON.stringify(roots)})
_runtime.__file__ = ${JSON.stringify(runtime)}
exec(compile(open(${JSON.stringify(bodyFile)}, encoding="utf8").read(), ${JSON.stringify(bodyFile)}, "exec"), vars(_runtime))
`;
}
module.exports = { writePythonFixture, isolatePythonRuntime, isolatePythonGlobals };
