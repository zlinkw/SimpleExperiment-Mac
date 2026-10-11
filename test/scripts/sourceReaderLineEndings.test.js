const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const helper = path.resolve(__dirname, "../_helpers/sourceReader.js");
const code = fs.readFileSync(helper, "utf8");

function reader(files) {
  const sandbox = {
    __dirname: path.dirname(helper), module: { exports: {} },
    require(name) {
      if (name === "node:path") return path;
      assert.equal(name, "node:fs");
      return { readFileSync(file, encoding) {
        assert.equal(encoding, "utf8");
        const value = files[path.basename(file)];
        if (value === undefined) throw new Error("missing fixture");
        return value;
      } };
    },
  };
  vm.runInNewContext(code, sandbox, { filename: helper });
  return sandbox.module.exports.readSource;
}

test("source reader gives identical declarations from LF and CRLF checkouts", () => {
  const lf = 'const 字段 = "中文\\n";\nconst next = 1;\n';
  for (const name of ["other.ts", "src/extension.ts"]) {
    const leaf = name === "src/extension.ts" ? "legacy.ts" : "other.ts";
    assert.equal(reader({ [leaf]: lf })(name), lf);
    assert.equal(reader({ [leaf]: lf.replace(/\n/g, "\r\n") })(name), lf);
  }
});

test("missing and empty legacy implementations normalize facade fallback", () => {
  for (const legacy of [undefined, ""]) {
    const read = reader({ "legacy.ts": legacy, "extension.ts": "export {};\r\n" });
    assert.equal(read("src/extension.ts"), "export {};\n");
  }
});
