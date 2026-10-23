const assert = require("node:assert/strict");

const test = require("node:test");

const vm = require("node:vm");

const fs = require("node:fs");

const path = require("node:path");

const Module = require("node:module");

const ts = require("typescript");

const { readSource } = require("../_helpers/sourceReader");

require("../_helpers/registerTsRequire");

function methodAt(text,offset){
 const ast=ts.createSourceFile("host.js",text,ts.ScriptTarget.Latest,true);let found;
 function visit(n){if(ts.isMethodDeclaration(n)&&n.getStart(ast)===offset)found=n.getText(ast);else ts.forEachChild(n,visit);}visit(ast);
 assert.ok(found,"complete method at "+offset);return found;
}


const source = readSource("src/extension.ts");

const compiledSource = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

function loadSourceModule(relativePath) {
  const filename = path.resolve(__dirname, "../..", relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(output, filename);
  return loaded.exports;
}

const start = source.indexOf("async resumePersistedDistributedQueue() {");

const end = source.indexOf("async deferDistributedPlan(", start);

assert.ok(start >= 0 && end > start);

const method = source.slice(start, end).replace("async resumePersistedDistributedQueue()", "async function resumePersistedDistributedQueue()");

const sandbox = { ...require('../_helpers/nativeHostScope'), workspaceRoot: () => "C:/project", Object };

vm.createContext(sandbox);

vm.runInContext(method + "\nthis.resume = resumePersistedDistributedQueue;", sandbox);


function loadTickQueue() {
  const compiled = compiledSource;
  const start = compiled.indexOf("async tickDistributedQueueCore(");
  const end = compiled.indexOf("async syncDistributedJobArtifacts(", start);
  assert.ok(start >= 0 && end > start);
  const context = { ...require('../_helpers/nativeHostScope'),
    workspaceRoot: () => "C:/project", DistributedPlanQueue: loadSourceModule("src/features/DistributedPlanQueue.ts"),
    GpuJobOwnership: require("../../dist/features/GpuJobOwnership.js"),
    DistributedSchedulingPolicy: require("../../dist/features/DistributedSchedulingPolicy.js"),
    mapLimited: async (items, _limit, fn) => Promise.all(items.map(fn)),
    Object, Set, Map, Date, JSON, setInterval, clearInterval, errorMessage: String,
    actionErrorSuggestion: (message) => String(message || ""),
  };
  vm.createContext(context);
  vm.runInContext(methodAt(compiled, start).replace(/async tickDistributedQueueCore\(([^)]*)\) \{/, "async function tickQueue($1) { this.readWorkerTaskSnapshotBatch ||= async ids => Promise.all(ids.map(id => this.readWorkerTaskSnapshot(id))); this.queuePlanArtifactSyncStatusCheck ||= () => undefined;")
    + "\nthis.tickQueue = tickQueue;", context);
  return context;
}
module.exports={assert,test,vm,fs,path,Module,ts,readSource,methodAt,source,compiledSource,loadSourceModule,start,end,method,sandbox,loadTickQueue};
