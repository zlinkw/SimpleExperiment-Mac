const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('real assigned tmux Agent starts, reuses and restarts without pidfd/PID signals or closing sibling/GPU windows',()=>{
  const fixture=path.join(__dirname,'agentLifecycle.fixture.py');
  const mounted=fixture.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,d)=>'/mnt/'+d.toLowerCase());
  const vendor=vendorRepoRoot(),vendorMounted=vendor.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,d)=>'/mnt/'+d.toLowerCase());
  const proc=spawnSync(process.platform==='win32'?'wsl.exe':'python3',process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','/usr/bin/python3','-B',mounted,vendorMounted]:['-B',fixture,vendor],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(proc.status,0,proc.stderr||proc.stdout||String(proc.error));
  const report=JSON.parse(proc.stdout.trim());
  assert.ok(Object.values(report).every(value=>value===true));
});

// 跨平台等价夹具：SFTP 是主仓的兄弟仓库；固定 ../../../ 层级只在主 checkout 成立，
// 独立 worktree lane 中层级更深。按祖先链发现含 agent-lifecycle.py 的兄弟仓库，
// 主 checkout 解析结果与原路径完全一致，可用 SIMPLE_SFTP_REPO 显式覆盖。
// Mac 适配：Mac 侧兄弟发行目录名为 SimpleSFTP-Mac（Windows 为 simple-sftp），按各自身份发现。
function vendorRepoRoot(){
  const env=process.env.SIMPLE_SFTP_REPO;
  if(env) return env;
  // Mac 适配：Mac 侧同级仓库目录名是 SimpleSFTP-Mac，两种布局都要能解析到 vendor 文件，不降低校验强度。
const siblingNames=['SimpleSFTP-Mac','simple-sftp','SimpleSFTP'];
  let dir=__dirname;
  for(let depth=0;depth<10;depth+=1){
    for(const name of siblingNames){
      const candidate=path.join(dir,name,'agent-lifecycle.py');
      if(fs.existsSync(candidate)) return path.dirname(candidate);
    }
    const parent=path.dirname(dir);
    if(parent===dir) break;
    dir=parent;
  }
  throw new Error('sibling simple-sftp repository with agent-lifecycle.py not found');
}
test('Agent and transport share the exact lifecycle protocol and serve claims ownership before state writers',()=>{
  const {AGENT_LIFECYCLE_PYTHON}=require('../../dist/runtime/AgentLifecycle');
  const vendorRoot=vendorRepoRoot();
  const vendor=fs.readFileSync(path.join(vendorRoot,'agent-lifecycle.py'),'utf8').replace(/\r\n/g,'\n');
  assert.equal(AGENT_LIFECYCLE_PYTHON,vendor.slice(0,vendor.indexOf('\nif __name__ == "__main__":')).trimEnd()+'\n');
  assert.doesNotMatch(vendor,/pidfd_open|pidfd_send_signal|os\.kill\(|kill-session|kill-server/);
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/clusterAgentRuntime.legacy.ts'),'utf8');
  const serve=source.slice(source.indexOf('def serve_http(args):'),source.indexOf('class BoundedThreadingHTTPServer'));
  assert.ok(serve.indexOf('lifecycle_service_guard')<serve.indexOf('atomic_write'));
  assert.doesNotMatch(serve,/prune_agent_state\(|reconcile_worker_tasks_after_restart\(/);
  const transport=require(path.join(vendorRoot,'agent-lifecycle'));
  assert.throws(()=>transport.agentPayload({action:'kill',projectDir:'/srv/p',installDir:'/srv/a'}),/AGENT_ACTION_INVALID/);
  assert.throws(()=>transport.agentPayload({action:'inspect',projectDir:'/srv/../p',installDir:'/srv/a'}),/AGENT_PATH_INVALID/);
});
