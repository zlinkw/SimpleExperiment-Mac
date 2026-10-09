"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { renderPanelHtml } = require("../dist/ui/PanelHtml");

const themes = {
  light: { background: "#ffffff", foreground: "#333333", muted: "#616161", input: "#ffffff", border: "#757575", info: "#005a9e", success: "#187128", warning: "#795e00", danger: "#a1260d", mine: "#6b2eb4" },
  dark: { background: "#1e1e1e", foreground: "#cccccc", muted: "#a9a9a9", input: "#313131", border: "#757575", info: "#4daafc", success: "#89d185", warning: "#cca700", danger: "#f48771", mine: "#c586c0" },
  hc: { background: "#000000", foreground: "#ffffff", muted: "#ffffff", input: "#000000", border: "#ffffff", info: "#6fc3df", success: "#89d185", warning: "#ffff00", danger: "#ff8888", mine: "#e4a6ff" },
};

function renderThemePreview(theme = "dark") {
  const colors = themes[theme];
  if (!colors) throw new Error("Unknown preview theme");
  const variables = {
    "editor-background": colors.background, "sideBar-background": colors.background,
    "editor-foreground": colors.foreground, foreground: colors.foreground, descriptionForeground: colors.muted,
    "input-background": colors.input, "input-foreground": colors.foreground, "input-border": colors.border,
    "panel-border": colors.border, "contrastBorder": theme === "hc" ? colors.border : "transparent",
    "focusBorder": colors.info, "textLink-foreground": colors.info, "notificationsInfoIcon-foreground": colors.info,
    "testing-iconPassed": colors.success, "editorWarning-foreground": colors.warning, errorForeground: colors.danger,
    "charts-purple": colors.mine, "button-background": "#0070b0", "button-foreground": "#ffffff",
    "button-secondaryForeground": colors.foreground, "button-secondaryBackground": colors.input,
    "list-hoverBackground": colors.input, "textCodeBlock-background": colors.input,
    "font-family": '"Segoe UI", "Microsoft YaHei UI", sans-serif',
  };
  let html = renderPanelHtml();
  const nonce = /<script nonce="([^"]+)"/.exec(html)[1];
  const bootstrap = "api = acquireVsCodeApi();\n        window.__simplePanelVsCodeApi = api;";
  if (!html.includes(bootstrap)) throw new Error("Unexpected panel bootstrap");
  html = html.replace(bootstrap, "api = { postMessage() {}, getState() { return null; }, setState() {} }; window.__simplePanelVsCodeApi = api;");
  html = html.replace("</head>", `<style>:root {${Object.entries(variables).map(([key, value]) => `--vscode-${key}:${value};`).join("")}}</style></head>`);
  html = html.replace("<body>", `<body class="vscode-${theme === "hc" ? "high-contrast" : theme}">`);
  const state = { projectName: "Mac 中文项目", connection: { status: "disconnected" }, pluginUpdate: { status: "up_to_date", message: "当前已是最新版本", experiment: { label: "SimpleExperiment Mac", currentVersion: "0.5.267", latestVersion: "0.5.267" }, sftp: { label: "SimpleSFTP Mac", currentVersion: "0.2.65", latestVersion: "0.2.65" } } };
  html = html.replace("</body>", `<script nonce="${nonce}">
    window.addEventListener('load', () => {
      window.postMessage({type:'state', seq:1, state:${JSON.stringify(state)}}, '*');
      setTimeout(() => {
        document.querySelector('[data-section-target="settings"]').click();
        const probes = document.createElement('div');
        probes.style.cssText='position:absolute;top:-10000px;';
        probes.innerHTML='<div class="projectRuleEditor">规则编辑</div><div class="workbenchInspector">详情</div><span class="inspectorStatus good">正常</span><span class="inspectorStatus warn">注意</span><span class="inspectorStatus error">失败</span><span class="inspectorStatus mine">重点</span><span class="gpuDenseStatus is-free">空闲</span><span class="gpuDenseStatus is-occupied">占用</span><span class="gpuDenseStatus is-mine">我的 GPU</span><span class="gpuDenseStatus mem-danger">显存异常</span><button class="secondary">检查更新</button><button class="danger-filled">危险操作</button><span class="muted">说明</span><span class="legendItem">图例</span>';
        document.body.append(probes);
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
        const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data);};
        const over=(front,back)=>front.slice(0,3).map((n,i)=>n*front[3]/255+back[i]*(1-front[3]/255));
        const background=node=>{const layers=[];for(let item=node;item;item=item.parentElement)layers.unshift(rgba(getComputedStyle(item).backgroundColor));return layers.reduce((back,front)=>over(front,back),[255,255,255]);};
        const luminance=rgb=>rgb.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:Math.pow((n+.055)/1.055,2.4);}).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);
        const inspect=node=>{const style=getComputedStyle(node),bg=background(node),fg=over(rgba(style.color),bg),a=luminance(fg),b=luminance(bg);return {color:style.color,background:style.backgroundColor,effectiveBackground:bg,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};};
        const samples={body:inspect(document.body),settings:inspect(document.querySelector('[data-section="settings"]')),input:inspect(document.querySelector('input:not([type="checkbox"])'))};
        for(const node of probes.children)samples[node.className]=inspect(node);
        const report=document.createElement('pre');report.id='theme-report';report.hidden=true;report.textContent=JSON.stringify({samples,error:document.getElementById('renderError').textContent,update:document.getElementById('pluginUpdateSettings').textContent,bootstrapHidden:document.getElementById('panelBootstrapStatus').hidden});document.body.append(report);
      }, 250);
    });
  </script></body>`);
  return html;
}

function writeThemePreview(theme = "dark") {
  const directory = path.join(os.tmpdir(), `simple-mac-theme-${crypto.randomUUID()}`);
  fs.mkdirSync(directory);
  const file = path.join(directory, "preview.html");
  fs.writeFileSync(file, renderThemePreview(theme), { encoding: "utf8", flag: "wx" });
  return file;
}
if (require.main === module) process.stdout.write(writeThemePreview(process.argv[2]) + "\n");
module.exports = { themes, renderThemePreview, writeThemePreview };
