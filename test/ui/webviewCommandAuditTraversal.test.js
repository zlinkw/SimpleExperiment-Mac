const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = panel.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function button(command, options = {}) {
  return {
    dataset: { command },
    disabled: Boolean(options.disabled),
    getAttribute(name) { return name === "title" ? (options.title || "") : ""; },
  };
}

function trackedButtons(rows) {
  let iterations = 0;
  return {
    rows: {
      [Symbol.iterator]() {
        iterations += 1;
        return rows[Symbol.iterator]();
      },
    },
    iterations: () => iterations,
  };
}

test("Webview command audit derives button facts in one traversal with cached help", () => {
  let helpCalls = 0;
  const sandbox = {
    webviewHandledCommands: new Set(["known", "handledNoHelp"]),
    commandHelp(command) {
      helpCalls += 1;
      return command === "known" ? "Known command" : "";
    },
  };
  vm.createContext(sandbox);
  const source = extractFunction("webviewCommandButtonFacts");
  assert.doesNotMatch(source, /buttons\.(?:map|filter|some)\(/);
  vm.runInContext(`${source}\nthis.audit = webviewCommandButtonFacts;`, sandbox);
  const buttons = trackedButtons([
    button("known"),
    button("missing", { disabled: true }),
    button("missing"),
    button("handledNoHelp", { title: "Visible title" }),
    button("", { disabled: true }),
  ]);
  const facts = sandbox.audit(buttons.rows);

  assert.equal(buttons.iterations(), 1);
  assert.equal(helpCalls, 4);
  assert.deepEqual(Array.from(facts.commands), ["handledNoHelp", "known", "missing"]);
  assert.deepEqual(Array.from(facts.missingHandler), ["missing"]);
  assert.deepEqual(Array.from(facts.missingHelp), ["handledNoHelp", "missing"]);
  assert.equal(facts.withoutTooltip, 3);
  assert.deepEqual(Array.from(facts.disabledWithoutReason), ["missing", "unknown"]);
});

test("Webview DOM audit consumes shared button facts and preserves adjacent audits", () => {
  const source = extractFunction("webviewDomCommandAudit");
  assert.match(source, /const facts = webviewCommandButtonFacts\(buttons\)/);
  assert.doesNotMatch(source, /buttons\.(?:map|filter|some)\(/);
  assert.match(source, /auditButtonPayloadWarnings\(buttons\)/);
  assert.match(source, /buttonSurfaceAudit\(buttons\)/);
  assert.match(source, /uniqueText\(facts\.disabledWithoutReason\)\.slice\(0, 12\)/);
});
