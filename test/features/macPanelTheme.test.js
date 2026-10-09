const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { writeThemePreview } = require("../../scripts/render-panel-theme-preview");

test("actual panel respects light, dark and high contrast foreground/background pairs", () => {
  const browser = process.env.SIMPLE_MAC_THEME_BROWSER || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(file => fs.existsSync(file));
  assert.ok(browser, "Set SIMPLE_MAC_THEME_BROWSER to a local Chromium executable");
  for (const theme of ["light", "dark", "hc"]) {
    const file = writeThemePreview(theme);
    const result = spawnSync(browser, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + path.join(path.dirname(file), "browser"), "--virtual-time-budget=800", "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const content = /<pre id="theme-report" hidden="">([^<]+)<\/pre>/.exec(result.stdout);
    assert.ok(content, `${theme} report missing`);
    const report = JSON.parse(content[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.equal(report.error, "");
    assert.ok(report.update.includes("GitHub preview Release"));
    for (const [name, sample] of Object.entries(report.samples)) assert.ok(sample.contrast >= 4.5, `${theme} ${name} contrast ${sample.contrast}: ${sample.color} / ${sample.background}`);
    if (theme !== "light") assert.ok(Math.max(...report.samples.body.effectiveBackground) < 80, `${theme} must not retain the light page background`);
  }
});
