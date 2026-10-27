const { test, assert, fs, path, vm, world, read, intact } = require("./planIsolatedReview.support.cjs");
// r17-A：操作记录随被消费项目锚定；旧 globalStorage 位置只是只读迁移源，新记录永不回写旧位置。
const { cleanupDigest } = require("../../dist/features/PlanCleanup.js");
if(!process.env.LOCALAPPDATA)process.env.LOCALAPPDATA=require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(),'r17-lease-')); // 与 r3 isolatedTestEnv 同约定：租约注册表落隔离目录（沙箱 homedir/AppData 只读，产品路径不变）
const projectOpRoot = w => path.join(w.root, "simple_cluster", "state", "simple-experiment", "plan-cleanup", cleanupDigest(w.root));

test('完整初选 PLAN 未到原生启动边界时零预览零删除',async()=>{const w=await world({ready:false});await assert.rejects(w.preview(),/NOT_READY/);assert.equal(w.calls.length,0);assert.equal(w.stats.executions,0);});

test('独立预览只解析注册隔离目标，单次确认不能执行',async()=>{const w=await world(),before=JSON.stringify(w.queue),p=await w.preview();assert.equal(p.rows.length,1);assert.equal(p.rows[0].relativePath,w.destination);assert.equal(p.registeredIsolationOperationId,w.originalId);await w.host.service.confirm({token:p.token,digest:p.digest,phase:1,confirm:true,exactTargets:p.rows.map(r=>r.node.id+':'+r.absolutePath)});await assert.rejects(w.host.execute(p.token),e=>e.apiData?.code==='CONFIRM_REQUIRED');assert.equal(w.stats.executions,0);intact(w,before);});

test('真实双确认删除隔离旧文件，原目录新文件和兄弟及队列不变',async()=>{const w=await world(),before=JSON.stringify(w.queue),p=await w.preview();await w.approve(p);const result=await w.host.execute(p.token);assert.equal(result.state,'completed');assert.equal(fs.existsSync(path.join(w.root,w.destination)),false);assert.equal(w.stats.executions,1);intact(w,before);assert.ok((await w.audit()).some(e=>e.kind==='completed'));const stored=JSON.parse(fs.readFileSync(path.join(projectOpRoot(w),p.token+'.json'),'utf8'));
assert.equal(fs.existsSync(path.join(w.opRoot,p.token+'.json')),false,'新操作记录不得写回旧 globalStorage 位置');assert.deepEqual(stored.preview.rows,[]);assert.deepEqual(stored.targets,{});await w.host.openIsolatedBatchReviews();assert.equal(w.infos.length,1);});

test('确认的 digest 和精确目标不能替换，第二次确认不可跳过',async()=>{const w=await world(),p=await w.preview();await assert.rejects(w.host.service.confirm({token:p.token,digest:'wrong',phase:1,confirm:true,exactTargets:[]}),/DIGEST|SCOPE|CONFIRM/);await assert.rejects(w.host.service.confirm({token:p.token,digest:p.digest,phase:2,confirm:true,exactTargets:p.rows.map(r=>r.node.id+':'+r.absolutePath)}),/CONFIRM/);assert.equal(w.stats.executions,0);});

test('新 command 换代撤销旧启动证明和删除准入',async()=>{const w=await world(),p=await w.preview();await w.approve(p);w.queue.plans[0].jobs[0].commandId='another';await assert.rejects(w.host.execute(p.token),/IDENTITY_CHANGED/);assert.equal(w.stats.executions,0);assert.equal(read(w,w.destination),'OLD');});
