const {assert,fs,http,os,path,test,runCli}=require("./simpleCli.support.cjs");
test("long host operations are not silently cut off while queries remain bounded",()=>{const {rpcTimeoutMs}=require("../../dist/cli/LocalApiClient");for(const method of ["plan.validate","workflow.plan","invoke","agents.lifecycle","project.prepare","server.testAll"])assert.equal(rpcTimeoutMs("experiment",method),0);assert.equal(rpcTimeoutMs("experiment","state.get"),15000);});
const base=fs.mkdtempSync(path.join(os.tmpdir(),"simple-cli-control-"));
console.log("retained fixtures: "+base);
async function fixture(){
 const state={calls:[],caps:0};const methods=["config.list","config.get","config.set","config.reset","state","state.list","state.get","state.set","state.reset","flow.get","flow.update","tmux.list","tmux.capture","gpu.history","panel.diagnostics","server.testAll","plans.filter","plan.validate"];
 const server=http.createServer((req,res)=>{
  if(req.url==="/api/v1/capabilities"){state.caps++;res.end(JSON.stringify({schemaVersion:1,name:"SimpleExperiment",version:"1.0.0",instanceId:"11:2026-01-01T00:00:00Z",rpc:"json-rpc-2.0",methods}));return;}
  let body="";req.on("data",b=>body+=b);req.on("end",()=>{const r=JSON.parse(body);state.calls.push(r);
   const mut=/^(config|state)\.(set|reset)$/.test(r.method);
   res.end(JSON.stringify({jsonrpc:"2.0",id:r.id,...(mut&&!r.params.confirm?{error:{code:2001,message:"CONFIRM_REQUIRED",data:{key:r.params.key,requires:["confirm"]}}}:{result:{ok:r.method!=="plan.validate",method:r.method,params:r.params,missing:r.method==="plan.validate"?[{reason:"Worker unavailable"}]:[]}})}));
  });
 });await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const file=path.join(base,"api-"+server.address().port+".json");fs.writeFileSync(file,JSON.stringify({schemaVersion:1,name:"SimpleExperiment",version:"1.0.0",pid:11,startedAt:"2026-01-01T00:00:00Z",token:"fixture-token",baseUrl:"http://127.0.0.1:"+server.address().port}),"utf8");
 return {state,env:{cwd:base,env:{SIMPLE_EXPERIMENT_MAC_API_FILE:file,SIMPLE_EXPERIMENT_PROJECT_ROOT:undefined}},close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);})};
}
test("named control methods preserve parameters, confirmation and in-band failure",async()=>{
 const f=await fixture();try{
  const cases=[
   [["config","get","simpleExperiment.test"],"config.get",{key:"simpleExperiment.test"},0],
   [["config","set","simpleExperiment.test","--value",'{"a":[1]}',"--scope","workspace","--confirm"],"config.set",{key:"simpleExperiment.test",value:{a:[1]},scope:"workspace",confirm:true},0],
   [["state","reset","selection","--confirm"],"state.reset",{key:"selection",confirm:true},0],
   [["state","snapshot"],"state",{},0],
   [["tmux","capture","window:3","--worker","worker-a"],"tmux.capture",{workerId:"worker-a",window:"window:3"},0],
   [["gpu","history"],"gpu.history",{},0],
   [["panel","diagnostics"],"panel.diagnostics",{},0],
   [["plan","validate","experiments/plans/a.yaml","--workspace",base],"plan.validate",{planFile:"experiments/plans/a.yaml",workspace:base},3],
  ];
  for(const [args,method,params,code] of cases){const r=await runCli([...args,"--json"],f.env);assert.equal(r.code,code,r.stdout+r.stderr);const p=JSON.parse(r.stdout);assert.equal(p.method,method);assert.deepEqual(p.params,params);}
  const refused=await runCli(["config","reset","simpleExperiment.test","--json"],f.env);assert.equal(refused.code,2);assert.deepEqual(JSON.parse(refused.stdout).error.detail.requires,["confirm"]);
 }finally{await f.close();}
});
test("invalid controls and unsupported pause are zero-API in an unrelated directory",async()=>{
 const f=await fixture();try{
  const flow=path.join(base,"flow.json");fs.writeFileSync(flow,JSON.stringify({step:"connect",completed:true,blocked:true}),"utf8");
  for(const args of [["experiment","pause","absent"],["tmux","capture","x"],["config","set","key"],["flow","update","--file",flow],["plan","validate"]]){
   const r=await runCli([...args,"--json"],f.env);assert.ok([1,3].includes(r.code),r.stdout+r.stderr);JSON.parse(r.stdout);
  }assert.equal(f.state.caps,0);assert.equal(f.state.calls.length,0);
 }finally{await f.close();}
});
