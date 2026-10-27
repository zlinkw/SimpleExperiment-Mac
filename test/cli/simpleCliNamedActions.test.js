const {assert,fs,http,os,path,test,runCli}=require("./simpleCli.support.cjs");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"named-cli-actions-"));console.log("retained: "+dir);
async function backend(){
 const calls=[];const actions=["refreshResults","checkPluginUpdates","deleteArtifacts","promoteDraft","startHub","syncGithub","newFeatureForFixture"].map(command=>({command,safe:true,confirm:false,action:""}));
 const server=http.createServer((req,res)=>{
  if(req.url==="/api/v1/capabilities"){res.end(JSON.stringify({schemaVersion:1,name:"SimpleExperiment",version:"1",instanceId:"1:2026-01-01T00:00:00Z",rpc:"json-rpc-2.0",methods:["actions.list","invoke"]}));return;}
  let body="";req.on("data",b=>body+=b);req.on("end",()=>{const r=JSON.parse(body);calls.push(r);res.end(JSON.stringify({jsonrpc:"2.0",id:r.id,result:r.method==="actions.list"?{actions,count:actions.length}:{ok:true,status:"started",params:r.params}}));});
 });await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const file=path.join(dir,"api-"+server.address().port+".json");fs.writeFileSync(file,JSON.stringify({schemaVersion:1,name:"SimpleExperiment",version:"1",pid:1,startedAt:"2026-01-01T00:00:00Z",token:"fixture-token",baseUrl:"http://127.0.0.1:"+server.address().port}),"utf8");
 return {calls,env:{cwd:dir,env:{SIMPLE_EXPERIMENT_MAC_API_FILE:file}},close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);})};
}
test("live named actions require explicit confirmation and preserve an uncompleted receipt",async()=>{
 const f=await backend();try{
  const file=path.join(dir,"params.json");fs.writeFileSync(file,JSON.stringify({planFile:"experiments/plans/a.yaml",options:{case:"all"}}),"utf8");
  const preview=await runCli(["actions","refresh-results","--file",file,"--json"],f.env);assert.equal(preview.code,2);assert.equal(f.calls.filter(c=>c.method==="invoke").length,0);
  const run=await runCli(["actions","refresh-results","--file",file,"--confirm","--json"],f.env);assert.equal(run.code,0,run.stdout+run.stderr);assert.equal(JSON.parse(run.stdout).status,"started");assert.deepEqual(f.calls.at(-1).params,{planFile:"experiments/plans/a.yaml",options:{case:"all"},confirm:true,command:"refreshResults"});
  const github=await runCli(["actions","sync-github","--confirm","--json"],f.env);assert.equal(github.code,0,github.stdout+github.stderr);assert.equal(f.calls.at(-1).params.command,"syncGithub","GitHub is not the retired Hub topology");
  const unknown=await runCli(["actions","not-in-the-catalog","--confirm","--json"],f.env);assert.equal(unknown.code,3);
  const dynamic=await runCli(["actions","new-feature-for-fixture","--confirm","--json"],f.env);assert.equal(dynamic.code,0);assert.equal(f.calls.at(-1).params.command,"newFeatureForFixture");
 }finally{await f.close();}
});
test("unsafe cleanup redirects, retirement and hidden confirmations cannot execute",async()=>{
 const f=await backend();try{
  const file=path.join(dir,"hidden.json");fs.writeFileSync(file,'{"confirm":true}',"utf8");
  const hidden=await runCli(["actions","refresh-results","--file",file,"--json"],f.env);assert.equal(hidden.code,1);assert.equal(f.calls.length,0);
  for(const name of ["delete-artifacts","promote-draft","start-hub"]){const r=await runCli(["actions",name,"--confirm","--path-confirmed","--second-confirmation","--json"],f.env);assert.equal(r.code,3,r.stdout);}
  assert.equal(f.calls.filter(c=>c.method==="invoke").length,0);
 }finally{await f.close();}
});
