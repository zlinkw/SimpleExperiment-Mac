const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { renderPanelHtml } = require("../dist/ui/PanelHtml.js");

const PREVIEW_THEME = `
  :root {
    --vscode-font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
    --vscode-font-size: 13px;
    --vscode-foreground: #d4d4d4;
    --vscode-descriptionForeground: #a9a9a9;
    --vscode-editor-background: #1e1e1e;
    --vscode-sideBar-background: #181818;
    --vscode-sideBar-foreground: #cccccc;
    --vscode-panel-border: #3c3c3c;
    --vscode-widget-border: #454545;
    --vscode-focusBorder: #007fd4;
    --vscode-textLink-foreground: #4daafc;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-input-background: #313131;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #555555;
    --vscode-editorWidget-background: #252526;
    --vscode-editorHoverWidget-background: #252526;
    --vscode-editorHoverWidget-foreground: #d4d4d4;
    --vscode-editorWarning-foreground: #cca700;
    --vscode-errorForeground: #f48771;
  }
`;

function buildPreviewState() {
  const startEpoch = 1_783_820_800;
  const serverSpecs = [
    ["hub-179", "NVIDIA RTX 4090", 18, 6_440, 24_564],
    ["worker-221", "NVIDIA RTX 3090", 67, 18_920, 24_576],
    ["worker-245", "NVIDIA RTX 4090", 42, 11_860, 24_564],
    ["worker-308", "NVIDIA A6000", 83, 39_200, 49_140],
  ];
  const gpu = {};
  const series = [];

  serverSpecs.forEach(([serverId, model, baseUtil, baseMemory, totalMemory], serverIndex) => {
    gpu[serverId] = {
      status: serverIndex === 2 ? "stale" : "online",
      updatedAt: "2026-07-23T10:40:00+08:00",
      gpus: Array.from({ length: 2 }, (_, gpuIndex) => ({
        index: gpuIndex,
        id: `${serverId}-gpu-${gpuIndex}`,
        name: model,
        memoryUsedMb: Math.min(totalMemory, baseMemory + gpuIndex * 2_100),
        memoryTotalMb: totalMemory,
        utilizationPercent: Math.min(99, baseUtil + gpuIndex * 11),
        temperature: 48 + serverIndex * 6 + gpuIndex * 4,
        processCount: serverIndex === 0 && gpuIndex === 0 ? 0 : 1,
        runKey: serverIndex === 0 && gpuIndex === 0 ? "-" : `trial-${serverIndex + 1}-${gpuIndex + 1}`,
      })),
    };

    for (let gpuIndex = 0; gpuIndex < 2; gpuIndex += 1) {
      series.push({
        serverId,
        gpuId: String(gpuIndex),
        rawPointCount: 25,
        points: Array.from({ length: 25 }, (_, pointIndex) => {
          const wave = Math.sin((pointIndex + serverIndex * 2 + gpuIndex) / 3) * 18;
          const util = Math.max(2, Math.min(98, Math.round(baseUtil + gpuIndex * 8 + wave)));
          const memoryUtil = Math.max(5, Math.min(96, Math.round((baseMemory / totalMemory) * 100 + gpuIndex * 7 + wave / 3)));
          return {
            timestamp: new Date((startEpoch + pointIndex * 10_800) * 1000).toISOString(),
            bucketEpoch: startEpoch + pointIndex * 10_800,
            gpuUtilPercent: util,
            memoryUsedMb: Math.round((memoryUtil / 100) * totalMemory),
            memoryTotalMb: totalMemory,
            memoryUtilPercent: memoryUtil,
            gapBefore: pointIndex === 13 && serverIndex === 2,
          };
        }),
      });
    }
  });

  return {
    projectName: "MiniMultiModal",
    connection: { status: "connected" },
    gpu,
    gpuOwnerConfig: { currentUser: "simple" },
    gpuHistory: {
      status: "ready",
      query: {},
      fetchedAt: "2026-07-23T10:40:05+08:00",
      data: {
        schemaVersion: 1,
        bucketSeconds: 300,
        retentionHours: 72,
        updatedAt: "2026-07-23T10:40:00+08:00",
        series,
      },
    },
  };
}

function renderPreviewHtml() {
  const stateJson = JSON.stringify(buildPreviewState()).replace(/</g, "\\u003c");
  const vscodeStub = `api = {
      postMessage(message) { window.__simpleExperimentPreviewMessages.push(message); },
      getState() { return null; },
      setState() {}
    };`;
  let html = renderPanelHtml();
  const apiBootstrap = "api = acquireVsCodeApi();\n        window.__simplePanelVsCodeApi = api;";
  if (!html.includes(apiBootstrap)) {
    throw new Error("Panel HTML no longer contains the expected VS Code API bootstrap");
  }
  html = html.replace(apiBootstrap, `${vscodeStub}\n        window.__simplePanelVsCodeApi = api;`);
  html = html.replace("</head>", `<style data-preview-theme>${PREVIEW_THEME}</style></head>`);
  html = html.replace("</body>", `<script data-preview-bootstrap>
    window.__simpleExperimentPreviewMessages = [];
    window.addEventListener("load", () => {
      window.postMessage({ type: "state", state: ${stateJson} }, "*");
      window.setTimeout(() => {
        const overview = document.querySelector('details[data-gpu-history-scope="overview"]');
        if (overview) overview.open = true;
        const firstCard = document.querySelector('details[data-gpu-history-scope="gpu"]');
        if (firstCard) firstCard.open = true;
        window.dispatchEvent(new Event("resize"));
      }, 120);
    });
  </script></body>`);
  return html;
}

function writePreview(outputPath) {
  const resolved = path.resolve(outputPath || path.join(os.tmpdir(), `simple-experiment-gpu-history-preview-${Date.now()}.html`));
  fs.writeFileSync(resolved, renderPreviewHtml(), { encoding: "utf8", flag: "wx" });
  return resolved;
}

if (require.main === module) {
  process.stdout.write(`${writePreview(process.argv[2])}\n`);
}

module.exports = { buildPreviewState, renderPreviewHtml, writePreview };
