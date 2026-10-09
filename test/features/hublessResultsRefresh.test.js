const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension/legacy.ts");
function method(name) {
  const start = new RegExp(`^\\s*(?:async\\s+)?${name}\\(`, "m").exec(source)?.index;
  assert.notEqual(start, undefined);
  const open = source.indexOf(") {", start) + 2;
  assert.ok(open > start + 1);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const sandbox = {
  stringField: (value, key) => String(value?.[key] || ""),
  compactResultsSummaryForWebview: (value) => value,
  hasCapability: (capabilities) => Boolean(capabilities?.includes("endpoints.resultsSummary")),
};
vm.createContext(sandbox);
const selectedClass = `class Subject {
  ${method("apiResultsList")}
  ${method("hasResultsSummaryEndpointCapability")}
}
this.Subject = Subject;`;
vm.runInContext(ts.transpileModule(selectedClass, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);

test("results.list fetches the requested Plan from all Workers even when another Plan is selected", async () => {
  const subject = new sandbox.Subject();
  subject.planFileInput = "plans/selected.yaml";
  const calls = [];
  subject.client = { getResultsSummary: async (plan, options) => {
    calls.push({ plan, options });
    return { planFile: plan, results: [{ workerId: "nwpu2" }, { workerId: "nwpu3" }] };
  } };
  subject.filterResultsSummaryForPlan = (summary) => summary;
  const result = await subject.apiResultsList({ planFile: "plans/history.yaml" });
  assert.equal(calls[0].plan, "plans/history.yaml");
  assert.equal(calls[0].options.userInitiated, true);
  assert.equal(result.results.length, 2);
});

test("one reachable Worker can supply a partial hubless results summary", () => {
  const subject = new sandbox.Subject();
  subject.projectTopologyAssessment = () => ({ hubAllowed: false });
  subject.enabledWorkerConfigs = () => [{ id: "nwpu2" }, { id: "nwpu5" }];
  subject.lastWorkerProbes = {
    nwpu2: { capabilities: ["endpoints.resultsSummary"] },
    nwpu5: { capabilities: [] },
  };
  assert.equal(subject.hasResultsSummaryEndpointCapability(), true);
});
