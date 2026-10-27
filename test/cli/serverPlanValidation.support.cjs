const {assert,fs,http,os,path,runCli}=require("./simpleCli.support.cjs");
module.exports=async function assertServerPlanValidation(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"server-plan-validation-"));const calls=[];
 const server=http.createServer((req,res)=>{
  if(req.url==="/api/v1/capabilities"){res.end(JSON.stringify({schemaVersion:1,name:"SimpleExperiment",version:"1",instanceId:"12:2026-01-01T00:00:00Z",rpc:"json-rpc-2.0",methods:["plan.validate"]}));return;}
  let text="";req.on("data",b=>text+=b);req.on("end",()=>{const r=JSON.parse(text);calls.push(r);const ok=r.params.planFile==="experiments/plans/valid.yaml";res.end(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{ok,missing:ok?[]:[{step:"validate_plan",reason:"invalid server plan"}],validation:{ok},source:"extension-host"}}));});
 });await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const file=path.join(dir,"api.json");fs.writeFileSync(file,JSON.stringify({schemaVersion:1,name:"SimpleExperiment",version:"1",pid:12,startedAt:"2026-01-01T00:00:00Z",token:"fixture-token",baseUrl:"http://127.0.0.1:"+server.address().port}),"utf8");
 try{
  for(const [plan,code,ok] of [["valid",0,true],["invalid",3,false]]){
   const r=await runCli(["plan","validate","experiments/plans/"+plan+".yaml","--json"],{cwd:dir,env:{SIMPLE_EXPERIMENT_MAC_API_FILE:file}});assert.equal(r.code,code,r.stdout+r.stderr);const body=JSON.parse(r.stdout);assert.equal(body.ok,ok);assert.equal(body.validation.ok,ok);assert.equal(body.source,"extension-host");assert.ok(Array.isArray(body.missing));if(!ok)assert.ok(body.missing.length>0);
  }assert.deepEqual(calls.map(r=>r.method),["plan.validate","plan.validate"]);assert.deepEqual(calls.map(r=>r.params),[{planFile:"experiments/plans/valid.yaml"},{planFile:"experiments/plans/invalid.yaml"}]);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 console.log("retained validation fixture: "+dir);
};
