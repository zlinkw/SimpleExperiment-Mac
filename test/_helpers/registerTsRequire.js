const fs = require("node:fs");
const Module = require("node:module");
const ts = require("typescript");

if (!Module._extensions[".ts"]) {
  Module._extensions[".ts"] = (loaded, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: filename,
    }).outputText;
    loaded._compile(code, filename);
  };
}
