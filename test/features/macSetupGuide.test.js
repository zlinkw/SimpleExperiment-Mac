const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("Mac configuration button opens the bundled Mac guide without saved-session onboarding", async () => {
  const root = path.resolve(__dirname, "../..");
  const source = fs.readFileSync(path.join(root,"dist/extension/legacy.js"),"utf8");
  const start=source.indexOf("async openSetupGuide()"), end=source.indexOf("async openPanel()",start);
  assert.ok(start>=0&&end>start);
  for(const failPreview of [false,true]) {
    const calls=[];
    const vscode={Uri:{file:file=>file},ViewColumn:{Active:1},commands:{executeCommand:async(command,uri)=>{calls.push([command,uri]);if(failPreview)throw Error("preview unavailable");}},
      workspace:{openTextDocument:async uri=>({uri})},window:{showTextDocument:async document=>calls.push(["fallback",document.uri]),showInformationMessage:async()=>{throw Error("legacy wizard must not run");}}};
    const sandbox={vscode,path};vm.createContext(sandbox);
    const provider=vm.runInContext("({"+source.slice(start,end)+"})",sandbox);
    provider.context={extensionPath:root,extension:{packageJSON:{name:"simple-experiment-mac"}}};
    await provider.openSetupGuide();
    assert.equal(calls[0][1],path.join(root,"docs/simple-experiment-setup.md"));
    assert.equal(calls.length,failPreview?2:1);
  }
  const guide=fs.readFileSync(path.join(root,"docs/simple-experiment-setup.md"),"utf8");
  for(const text of ["Apple Silicon","⇧⌘P","Termius","Mac preview","Application Support","单 Worker","多 Worker","Hub/Worker"])assert.ok(guide.includes(text),text);
  assert.doesNotMatch(guide,/Windows \+ VS Code|安装最新版 `simple-local\.simple-sftp`|配置 Xshell 本地隧道并保存/);
  for (const text of ["首尾空格", "不当作空格解码", "区分大小写", "非空非法行会拒绝保存", "只读目录浏览", "完整绝对路径"])
    assert.ok(guide.includes(text), text);
});
