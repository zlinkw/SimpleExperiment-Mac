const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
require('../_helpers/registerTsRequire');
const P=require('../../dist/features/ProjectStatePaths.js');
const {syncHoldsStoragePath,legacySyncHoldsStoragePath,loadSyncHolds,saveSyncHolds}=require('../../dist/features/SyncResolution.js');
const {distributedQueuePath,legacyDistributedQueuePath}=require('../../dist/features/DistributedPlanQueue.js');
const {collectLocalScopeInventory}=require('../../dist/features/SyncScopeStatus.js');
const {resolveProjectRootMap,machineStateGuard}=require('../../dist/features/ProjectRootMap.js');
const {cleanupDigest}=require('../../dist/features/PlanCleanup.js');
const {PlanRunHost}=require('../../src/extension/PlanRunHost.ts');
if(!process.env.LOCALAPPDATA)process.env.LOCALAPPDATA=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'r17-lease-')); // 与 r3 isolatedTestEnv 同约定：租约注册表落隔离目录（沙箱 homedir/AppData 只读，产品路径不变）

// r17-A 目标回归：每个实际消费 projectRoot 派生自己的 simple_cluster 子树（互不包含、cwd 不参与、
// 空 root 拒绝推导）；已知旧精确位置只读一次性迁移——新值永不被旧值覆盖、旧文件字节永不改动、
// 坏 legacy 保留原错误语义、坏新状态不回退；目录级白名单字节复制幂等；受管目录经真实
// machine-state 映射从代码同步清单排除。不启动 VSCode/服务器，全部在独立 mkdtemp 项目根内。

function mkRoot(tag){return fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'r17-'+tag+' 项目 ')));}
function w(file,text){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}

test('每项目各自派生 simple_cluster 子树；空/相对 root 一律拒绝；cwd 永不参与',()=>{
  const a=mkRoot('a'),b=mkRoot('b');
  assert.equal(P.projectStateDir(a,'simple-experiment'),path.join(a,'simple_cluster','state','simple-experiment'));
  assert.equal(P.projectLocksDir(b,'simple-sftp'),path.join(b,'simple_cluster','locks','simple-sftp'));
  assert.ok(!P.projectStateDir(b,'simple-experiment').startsWith(P.projectStateDir(a,'simple-experiment')+path.sep),'清理 A 触不到 B：两 root 派生的目录互不包含');
  const dirs=P.projectManagedDirs(a);
  assert.equal(dirs.length,10,'两插件 × state/cache/logs/tmp/locks');
  assert.ok(dirs.every(d=>d.startsWith(path.join(a,'simple_cluster')+path.sep)));
  const cwd=process.cwd(),base=path.join(a,'simple_cluster');
  fs.mkdirSync(base,{recursive:true});
  try{
    process.chdir(base);
    assert.equal(P.projectStateDir(a,'simple-experiment'),path.join(base,'state','simple-experiment'),'同一绝对 root 在任何 cwd 下推导一致');
    // 返修#1：相对 root 在任何 cwd 都拒绝——同一逻辑项目绝不允许随 cwd 派生不同树（跨项目隔离）。
    assert.throws(()=>P.projectStateDir('nested 项目','simple-experiment'),/绝对路径/);
    assert.deepEqual(P.projectManagedDirs('nested 项目'),[],'machine-state 归属同样拒绝相对 root');
  }finally{process.chdir(cwd);}
  for(const bad of ['','   ','relative/路径','..\里']){
    assert.throws(()=>P.projectManagedRoot(bad),/缺少有效项目根|绝对路径/,'空/相对 root 绝不回落到 cwd 或共享目录');
    assert.deepEqual(P.projectManagedDirs(bad),[]);
  }
});

test('项目身份 = sha256(解析后 root)，跨 cwd 稳定、异 root 相异',()=>{
  const a=mkRoot('id'),cwd=process.cwd();
  if(process.platform!=='win32')assert.equal(P.projectStateId(a),crypto.createHash('sha256').update(path.resolve(a)).digest('hex'));
  try{process.chdir(os.tmpdir());assert.equal(P.projectStateId(a),P.projectStateId(a));}finally{process.chdir(cwd);}
  assert.notEqual(P.projectStateId(a),P.projectStateId(mkRoot('id2')));
});

test('队列与同步暂停锚定项目内；旧精确路径保持原形状且文件名同身份',()=>{
  const a=mkRoot('paths'),storage=path.join(mkRoot('pathstore'),'g');
  assert.equal(distributedQueuePath(storage,a),path.join(a,'simple_cluster','state','simple-experiment','distributed-plan-queues',P.projectStateId(a)+'.json'));
  assert.equal(path.basename(distributedQueuePath(storage,a)),path.basename(legacyDistributedQueuePath(storage,a)),'迁移按同一身份文件名对上旧文件');
  assert.equal(legacyDistributedQueuePath(storage,a),path.join(storage,'distributed-plan-queues',P.projectStateId(a)+'.json'),'旧推导一字不改');
  assert.equal(syncHoldsStoragePath(storage,a),path.join(a,'simple_cluster','state','simple-experiment','sync-holds',P.projectStateId(a)+'.json'));
  assert.equal(path.basename(syncHoldsStoragePath(storage,a)),path.basename(legacySyncHoldsStoragePath(storage,a)));
});

test('holds 读写落在项目内（含中文空格 root），不再写旧 globalStorage 位置',async()=>{
  const a=mkRoot('holds'),storage=path.join(mkRoot('holdsstore'),'g');
  const holds={'plans/a.yaml':{endpointId:'w1',deletedAt:'2026-10-24T00:00:00.000Z',directory:false}};
  await saveSyncHolds(storage,a,holds);
  const file=syncHoldsStoragePath(storage,a);
  assert.ok(file.startsWith(path.join(a,'simple_cluster','state','simple-experiment','sync-holds')+path.sep));
  assert.ok(!fs.existsSync(path.join(storage,'sync-holds')),'新写入绝不回旧位置');
  assert.deepEqual(await loadSyncHolds(storage,a),holds);
});

test('holds 一次性迁移：有效旧值字节复制、已有新值获胜、坏旧值原错透出、坏新值不回退',async()=>{
  const mk=()=>{const a=mkRoot('mig'),storage=path.join(mkRoot('migstore'),'g');return{a,storage,legacy:legacySyncHoldsStoragePath(storage,a),file:syncHoldsStoragePath(storage,a)};};
  const legacyValue={'x.py':{endpointId:'w1',deletedAt:'2026-01-01T00:00:00.000Z',directory:false}};
  const t1=mk();
  w(t1.legacy,JSON.stringify(legacyValue));
  assert.deepEqual(await loadSyncHolds(t1.storage,t1.a),legacyValue);
  assert.equal(fs.readFileSync(t1.file,'utf8'),fs.readFileSync(t1.legacy,'utf8'),'迁移是字节复制');
  const legacyBytes=fs.readFileSync(t1.legacy,'utf8');
  assert.deepEqual(await loadSyncHolds(t1.storage,t1.a),legacyValue);
  assert.equal(fs.readFileSync(t1.legacy,'utf8'),legacyBytes,'旧文件永不改动或删除');
  const t2=mk();
  w(t2.legacy,JSON.stringify({'old.py':{endpointId:'w1',deletedAt:'2026-01-01T00:00:00.000Z',directory:false}}));
  const newValue={'new.py':{endpointId:'w2',deletedAt:'2026-02-01T00:00:00.000Z',directory:false}};
  await saveSyncHolds(t2.storage,t2.a,newValue);
  assert.deepEqual(await loadSyncHolds(t2.storage,t2.a),newValue,'新位置已有值时旧值永不复活');
  const t3=mk();w(t3.legacy,'{ not json');
  await assert.rejects(()=>loadSyncHolds(t3.storage,t3.a),/格式无效/,'坏 legacy 不被静默当成空态');
  assert.ok(!fs.existsSync(t3.file),'坏 legacy 不复制进新位置');
  const t4=mk();
  w(t4.legacy,JSON.stringify(legacyValue));
  w(t4.file,'corrupted new state');
  await assert.rejects(()=>loadSyncHolds(t4.storage,t4.a),SyntaxError);
  assert.equal(fs.readFileSync(t4.file,'utf8'),'corrupted new state','坏新状态绝不被旧数据悄悄改写');
});

test('双窗口并发迁移同一旧快照互不覆盖，恰好一方发布',async()=>{
  const a=mkRoot('race'),storage=path.join(mkRoot('racestore'),'g');
  const legacy=path.join(storage,'sync-holds',P.projectStateId(a)+'.json'),file=syncHoldsStoragePath(storage,a);
  w(legacy,'{"r":1}');
  const statuses=await Promise.all([P.ensureProjectSnapshotMigrated(a,legacy,file),P.ensureProjectSnapshotMigrated(a,legacy,file)]);
  assert.deepEqual([...statuses].sort(),['migrated','present'],'link 原子发布：后到者 EEXIST 让位，不覆盖');
  assert.equal(fs.readFileSync(file,'utf8'),'{"r":1}');
  assert.deepEqual((await fsp.readdir(path.dirname(file))).filter(n=>n.startsWith('.migrating-')),[],'迁移临时文件用后即删');
});

test('目录级快照迁移：目标已有值获胜、仅白名单字节复制（不解析）、旧目录不动、marker 持久防重导（释放后不复活）',async()=>{
  const base=mkRoot('dir'),projectRoot=path.join(base,'proj');
  const legacyDir=path.join(base,'legacy'),target=path.join(projectRoot,'simple_cluster','state','simple-experiment','plan-cleanup','d');
  const marker=path.join(projectRoot,'simple_cluster','state','simple-experiment','migrations','d.done.json');
  const good='a'.repeat(48)+'.json',broken='f'.repeat(48)+'.json',notW='note.json',long64='b'.repeat(64)+'.json';
  w(path.join(legacyDir,good),'{"v":1}');w(path.join(legacyDir,broken),'broken{');w(path.join(legacyDir,notW),'{"v":2}');w(path.join(legacyDir,long64),'{"v":3}');
  w(path.join(target,good),'{"v":9}');
  await P.ensureProjectDirectorySnapshotsMigrated(projectRoot,legacyDir,target,/^[a-f0-9]{48}\.json$/,marker);
  assert.deepEqual((await fsp.readdir(target)).sort(),[good,broken],'非白名单文件名不迁移');
  assert.equal(fs.readFileSync(path.join(target,good),'utf8'),'{"v":9}','新位置已有文件不被旧值覆盖');
  assert.equal(fs.readFileSync(path.join(target,broken),'utf8'),'broken{','损坏记录字节照搬，读侧错误语义保留；迁移不解析');
  assert.equal(fs.readFileSync(path.join(legacyDir,good),'utf8'),'{"v":1}');
  assert.ok(fs.existsSync(path.join(legacyDir,notW))&&fs.existsSync(path.join(legacyDir,long64)),'旧目录只读，不移动不删除');
  await P.ensureProjectDirectorySnapshotsMigrated(projectRoot,legacyDir,target,/^[a-f0-9]{48}\.json$/,marker);
  assert.deepEqual((await fsp.readdir(target)).filter(n=>n.startsWith('.migrating-')),[],'无临时残留');
  assert.ok(fs.existsSync(marker),'完成后持久 marker 即已落定事实（租约协议，journal 已移除）');
  assert.ok(!fs.existsSync(marker+'.importing'),'不再有 journal 残留协议');
  // 返修#3：终态释放（新位置文件被删）后，全新 host/第二窗口凭持久 marker 绝不重导旧值。
  require("../_helpers/retainFixtureTarget.cjs")(projectRoot,path.join(target,good),"file");require("../_helpers/retainFixtureTarget.cjs")(projectRoot,path.join(target,broken),"file");
  await P.ensureProjectDirectorySnapshotsMigrated(projectRoot,legacyDir,target,/^[a-f0-9]{48}\.json$/,marker);
  assert.deepEqual((await fsp.readdir(target)).sort(),[],'已释放记录不会被重新导入（复活）');
  assert.equal(fs.readFileSync(path.join(legacyDir,good),'utf8'),'{"v":1}','旧 legacy 字节全程不动');
  const absent=path.join(projectRoot,'simple_cluster','state','simple-experiment','never');
  await P.ensureProjectDirectorySnapshotsMigrated(projectRoot,path.join(base,'no-legacy'),absent,/^[a-f0-9]{48}\.json$/,path.join(projectRoot,'simple_cluster','state','simple-experiment','migrations','never.done.json'));
  assert.ok(!fs.existsSync(absent),'旧目录不存在时不建空目标');
});

test('受管子树拒绝链接与跨 root：simple_cluster 指向项目 B 时拒绝写入 A 事实；写位规则按平台语义（Windows st_mode 不承载 ACL）',async()=>{
  assert.equal(P.managedWriteBitsAllowed(0o770,'win32'),true,'Windows 位规则豁免——真实 ACL 是平台原生必验');
  assert.equal(P.managedWriteBitsAllowed(0o770,'darwin'),false);assert.equal(P.managedWriteBitsAllowed(0o755,'linux'),true);
  const other=mkRoot('B'),root=mkRoot('C');
  const mkLink=(dir,target)=>{try{fs.symlinkSync(dir,target,process.platform==='win32'?'junction':'dir');return true;}catch(error){if(error.code==='EPERM'||error.code==='ENOSYS')return false;throw error;}};
  if(mkLink(other,path.join(root,'simple_cluster')))
    try{await assert.rejects(()=>P.ensureProjectDirectorySnapshotsMigrated(root,path.join(root,'legacy'),path.join(root,'simple_cluster','state','simple-experiment','x'),/^[a-f0-9]{48}\.json$/,path.join(root,'simple_cluster','state','simple-experiment','migrations','x.done.json')),/链接|非目录|不在项目受管子树/);}
    finally{assert.ok(fs.readdirSync(other).length===0||process.platform==='win32','拒绝前未向 B 写入任何字节');}
  if(process.platform==='win32')return; // POSIX 组可写真实效果属原生必验（与 B 锁目录同一规则表）
  const root2=mkRoot('D');fs.mkdirSync(path.join(root2,'simple_cluster'));fs.chmodSync(path.join(root2,'simple_cluster'),0o770);
  await assert.rejects(()=>P.ensureProjectDirectorySnapshotsMigrated(root2,path.join(root2,'legacy'),path.join(root2,'simple_cluster','state','x'),/^[a-f0-9]{48}\.json$/,path.join(root2,'simple_cluster','state','migrations','x.done.json')),/组\/其他用户写入/);
});

// r18 marker 竞态返修：check→整批导入→仅全成功发布 marker 与 检查→释放 串行在同一 markerFile 资源租约
//（HostOperationLease，同 withPluginStateFileLease scope）。测试用可控 barrier 排程 B 导入中 A/C 排队。
const MIG=/^f\d\.json$/;
function migFixture(tag){const base=mkRoot(tag),projectRoot=path.join(base,'proj');fs.mkdirSync(projectRoot); // 项目根恒存在（真实运行时 root 是已解析存在目录）
  return{projectRoot,legacy:path.join(base,'legacy'),target:path.join(projectRoot,'simple_cluster','state','simple-experiment','grp'),
    marker:path.join(projectRoot,'simple_cluster','state','simple-experiment','migrations','g.done.json')};}
test('竞态：B 导入中 A/C 一律排队于同一租约；marker 仅在全部成功后发布；释放后绝不复活',async()=>{
  const fx=migFixture('race2');
  w(path.join(fx.legacy,'f1.json'),'{"v":1}');w(path.join(fx.legacy,'f2.json'),'{"v":2}');
  let sawFirst,gateOpen;const firstPublished=new Promise(r=>sawFirst=r),gate=new Promise(r=>gateOpen=r);const order=[];
  const pB=P.ensureProjectDirectorySnapshotsMigrated(fx.projectRoot,fx.legacy,fx.target,MIG,fx.marker,async name=>{order.push('B:'+name);if(name==='f1.json'){sawFirst();await gate;}});
  await firstPublished;
  const pA=P.ensureProjectDirectorySnapshotsMigrated(fx.projectRoot,fx.legacy,fx.target,MIG,fx.marker,async name=>{order.push('A:'+name);});
  const pC=P.releaseMigratedProjectSnapshotRecord(fx.projectRoot,fx.marker,path.join(fx.target,'f1.json'));
  await new Promise(r=>setTimeout(r,200));
  gateOpen();
  const outcome=await pC;await pB;await pA;
  assert.equal(outcome,'released','C 必须等迁移整批落定+marker 发布后才删');
  assert.deepEqual(order,['B:f1.json','B:f2.json'],'A 在租约后 recheck 见 marker，一个文件都不再搬——不复活');
  assert.ok(fs.existsSync(path.join(fx.target,'f2.json')),'非释放目标的迁移文件正常保留');
  assert.ok(!fs.existsSync(path.join(fx.target,'f1.json')),'释放后无复活');
  await P.ensureProjectDirectorySnapshotsMigrated(fx.projectRoot,fx.legacy,fx.target,MIG,fx.marker,async name=>{order.push('late:'+name);});
  assert.ok(!fs.existsSync(path.join(fx.target,'f1.json')),'全新 host/第二窗口重跑也不重导已释放记录');
  assert.equal(fs.readFileSync(path.join(fx.legacy,'f1.json'),'utf8'),'{"v":1}','旧 legacy 字节全程不动');
});
test('迁移第N文件故障：marker 绝不发布；重启补完且已有新值不被覆盖',async()=>{
  const fx=migFixture('failN');
  w(path.join(fx.legacy,'f1.json'),'{"v":1}');w(path.join(fx.legacy,'f2.json'),'{"v":2}');
  await assert.rejects(()=>P.ensureProjectDirectorySnapshotsMigrated(fx.projectRoot,fx.legacy,fx.target,MIG,fx.marker,
    async name=>{if(name==='f1.json')throw Error('注入故障：copy/link 失败');}));
  assert.ok(!fs.existsSync(fx.marker),'中途失败绝不发布完成事实（不再错误标 done）');
  assert.ok(fs.existsSync(path.join(fx.target,'f1.json')),'已完成文件保留，重启可续');
  const newValue='{"v":9}';w(path.join(fx.target,'f2.json'),newValue);
  await P.ensureProjectDirectorySnapshotsMigrated(fx.projectRoot,fx.legacy,fx.target,MIG,fx.marker);
  assert.ok(fs.existsSync(fx.marker));
  assert.equal(fs.readFileSync(path.join(fx.target,'f2.json'),'utf8'),newValue,'重启补完时新值获胜');
});
test('释放合同：marker 未落定时 await 释放确定保留不删；落定后精确释放；ENOENT 幂等',async()=>{
  const fx=migFixture('relContract');
  w(path.join(fx.legacy,'f1.json'),'{"v":1}');w(path.join(fx.target,'f9.json'),'fresh');
  // r24-Win 返修：先启动 release 再并发启动 import 不能保证谁先拿到租约——Windows 上 import 先落定 marker 后
  // release 返回 released 是正确语义，原并发编排只是调度运气。改为 marker 落定前单独 await 释放：
  // 确定性地 pending-migration；真实并行覆盖由 r24 两条真跨进程 barrier 用例保留，不在此依赖进程内编排。
  assert.equal(await P.releaseMigratedProjectSnapshotRecord(fx.projectRoot,fx.marker,path.join(fx.target,'f1.json')),'pending-migration','marker 未落定一律拒绝释放，绝不抢先删除');
  assert.ok(fs.existsSync(path.join(fx.legacy,'f1.json')),'被拒绝的释放没有删任何东西（导入前 legacy 源字节原样保留）');
  await P.ensureProjectDirectorySnapshotsMigrated(fx.projectRoot,fx.legacy,fx.target,MIG,fx.marker);
  assert.ok(fs.existsSync(path.join(fx.target,'f1.json')),'导入落定后目标存在待释放记录');
  const first=await P.releaseMigratedProjectSnapshotRecord(fx.projectRoot,fx.marker,path.join(fx.target,'f1.json'));
  assert.equal(first,'released');
  assert.equal(await P.releaseMigratedProjectSnapshotRecord(fx.projectRoot,fx.marker,path.join(fx.target,'f1.json')),'not-found');
  assert.ok(fs.existsSync(path.join(fx.target,'f9.json')),'只删精确目标，不扫目录');
  const noLegacy=migFixture('relNoLegacy');
  await P.ensureProjectDirectorySnapshotsMigrated(noLegacy.projectRoot,noLegacy.legacy,noLegacy.target,MIG,noLegacy.marker);
  assert.ok(fs.existsSync(noLegacy.marker),'旧目录不存在也持久落定，不再重探');
});
test('回执释放归属与成功事实门禁：缺成功事实/root 不符一律保留；running job 非回执消费者；冻结 root 释放只动本项目',async()=>{
  const rootA=mkRoot('frzA'),rootB=mkRoot('frzB'),storage=path.join(mkRoot('frzstore'),'g');
  const hostStub={context:{globalStorageUri:{fsPath:storage}},loadDistributedQueue:()=>assert.fail('r20：远端队列 job 状态不再是本地回执消费者的判据，释放不得读队列')};
  const saveStore=new PlanRunHost(hostStub,rootA);
  await saveStore.save({submissionOperationIdLocal:'op-1',planFile:'plans/a.yaml',submissionWorkflowId:'wf-1'});
  const receipt=path.join(rootA,'simple_cluster','state','simple-experiment','run-submissions',
    require('../../dist/features/PlanCleanup.js').cleanupDigest(rootA),require('../../dist/features/PlanCleanup.js').cleanupDigest('op-1')+'.json');
  assert.ok(fs.existsSync(receipt));
  assert.equal(await new PlanRunHost(hostStub,rootA).releaseSettled('op-1'),'no-success-fact','缺成功提交业务事实=明确保留，不默认无引用');
  assert.ok(fs.existsSync(receipt),'拒绝删除路径零改动');
  assert.equal(await new PlanRunHost(hostStub,rootB).releaseSettled('op-1','submission-succeeded'),'not-found','切换项目后的 root 找不到 A 的回执，也绝不写 B');
  assert.ok(fs.existsSync(receipt),'A 回执仍在原项目');
  assert.ok(!fs.existsSync(path.join(rootB,'simple_cluster','state','simple-experiment','run-submissions')),'B 的树根本没被创建');
  assert.equal(await new PlanRunHost(hostStub,rootA).releaseSettled('op-1','submission-succeeded'),'released','成功提交事实+durable 关联即可按冻结 root 释放，不等 job 终态');
  assert.ok(!fs.existsSync(receipt));
  assert.ok(!fs.existsSync(path.join(rootB,'simple_cluster','state','simple-experiment','run-submissions')),'B 文件全程不变');
});
test('受管目录进入真实 machine-state 映射：五桶全为已验证前缀、unknown=false，清单与白名单原语义一致',async()=>{
  const root=mkRoot('guard');
  w(path.join(root,'src','main.py'),'print(1)\n');
  w(path.join(root,'simple_cluster','state','simple-experiment','sync-holds','x.json'),'{}');
  w(path.join(root,'simple_cluster','cache','simple-sftp','h.bin'),'x');
  w(path.join(root,'simple_cluster','locks','simple-sftp','y.lock'),'x');
  w(path.join(root,'simple_cluster','logs','simple-experiment','z.log'),'x');
  w(path.join(root,'simple_cluster','tmp','simple-experiment','in-flight'),'x');
  // 名单级 allowlist 原语义的既有保留项：results 与 tmp/tmux_logs 不是插件受管桶。
  w(path.join(root,'simple_cluster','results','latest.json'),'{}');
  w(path.join(root,'simple_cluster','tmp','tmux_logs','a.log'),'x');
  const guard=machineStateGuard(resolveProjectRootMap({projectId:'p',projectDir:root,machineStateDirs:P.projectManagedDirs(root)}));
  assert.equal(guard.unknown,false,'本地项目根映射必须可判定，不得让清理防护静默失效');
  for(const plugin of ['simple-experiment','simple-sftp'])for(const bucket of ['state','cache','logs','tmp','locks'])
    assert.ok(guard.prefixes.includes(`simple_cluster/${bucket}/${plugin}`),'清理/归属判定必须把五桶视为机器状态');
  const withMap=Object.keys(await collectLocalScopeInventory(root,'.',true,undefined,undefined,guard.prefixes)).sort();
  assert.deepEqual(withMap,['simple_cluster/results/latest.json','simple_cluster/tmp/tmux_logs/a.log','src/main.py'],
    '五桶按前缀排除；results 与 tmux_logs 属用户可见 allowlist，映射排除不吞掉它们，代码文件不受影响');
  const withoutMap=Object.keys(await collectLocalScopeInventory(root,'.',true)).sort();
  assert.deepEqual(withoutMap,withMap,'名单级排除与映射排除对同一棵树结果一致，添加映射不改变清单语义');
});

test('运行提交回执迁移进项目：字节复制、已有回执不回退旧值、缺失显式报错、旧目录不动',async()=>{
  const root=mkRoot('receipt'),storage=path.join(mkRoot('receiptstore'),'g');
  const host=new PlanRunHost({context:{globalStorageUri:{fsPath:storage}}},root);
  const legacyDir=path.join(storage,'run-submissions',cleanupDigest(root));
  const newDir=path.join(root,'simple_cluster','state','simple-experiment','run-submissions',cleanupDigest(root));
  const oldBytes=JSON.stringify({root,operationId:'op-old',input:{marker:'legacy'},recovery:{},replacement:{}});
  w(path.join(legacyDir,cleanupDigest('op-old')+'.json'),oldBytes);
  w(path.join(legacyDir,cleanupDigest('op-win')+'.json'),JSON.stringify({root,operationId:'op-win',input:{marker:'legacy'},recovery:{},replacement:{}}));
  w(path.join(newDir,cleanupDigest('op-win')+'.json'),JSON.stringify({root,operationId:'op-win',input:{marker:'new'},recovery:{},replacement:{}}));
  const old=await host.load('op-old');
  assert.equal(old.input.marker,'legacy');
  assert.equal(fs.readFileSync(path.join(newDir,cleanupDigest('op-old')+'.json'),'utf8'),oldBytes,'回执迁移字节一致');
  const win=await host.load('op-win');
  assert.equal(win.input.marker,'new','新位置已有回执永不回退旧值');
  await assert.rejects(()=>host.load('op-none'),error=>error.code==='ENOENT');
  assert.ok(!fs.readFileSync(path.join(legacyDir,cleanupDigest('op-win')+'.json'),'utf8').includes('"new"'),'旧回执目录一字未改');
});

// ---- r24/r21：真实跨进程竞态与释放终态。子进程只走 dist 生产 API（与 UI/同进程桩无关）。----
const cp=require('node:child_process');
function spawnWorker(...args){const child=cp.spawn(process.execPath,[path.join(__dirname,'..','_helpers','projectStateMigrationWorker.js'),...args],{stdio:['ignore','pipe','pipe']});
  child.out='';child.err='';child.stdout.on('data',d=>{child.out+=d});child.stderr.on('data',d=>{child.err+=d});
  child.done=new Promise(resolve=>child.on('exit',resolve));return child;}
async function workerResult(child,label){const code=await child.done;assert.equal(code,0,label+' worker exit='+code+' stdout='+child.out+' stderr='+child.err);return JSON.parse(child.out);}
async function waitFile(file,label){for(let i=0;i<800&&!fs.existsSync(file);i++)await new Promise(r=>setTimeout(r,25));assert.ok(fs.existsSync(file),label);}

test('r24 目录级真跨进程：B 导入持租时第三进程释放与 A 并行导入都排队，落定后释放精确删除一次',{timeout:90000},async()=>{
  const fx=migFixture('xproc');
  w(path.join(fx.legacy,'f1.json'),'one');w(path.join(fx.legacy,'f2.json'),'two');w(path.join(fx.legacy,'f3.json'),'three');
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'r24-xproc-'));
  const sig=path.join(dir,'b.signal'),gate=path.join(dir,'b.gate');
  const b=spawnWorker('migrate',fx.projectRoot,fx.legacy,fx.target,fx.marker,sig,gate,'hold');
  await waitFile(sig,'B 已发布 f1 并持有租约');
  assert.ok(fs.existsSync(path.join(fx.target,'f1.json')),'f1 已发布进项目');
  assert.ok(!fs.existsSync(fx.marker),'完成事实尚未发布');
  const c=spawnWorker('release',fx.projectRoot,fx.legacy,fx.target,fx.marker,path.join(fx.target,'f1.json'));
  const a=spawnWorker('migrate',fx.projectRoot,fx.legacy,fx.target,fx.marker);
  await new Promise(r=>setTimeout(r,800));
  assert.equal(c.exitCode===null&&a.exitCode===null,true,'B 持有期间，第三进程释放与 A 并行导入都必须被同一租约挡住：c.out='+c.out+' c.err='+c.err+' a.out='+a.out+' a.err='+a.err);
  assert.ok(fs.existsSync(path.join(fx.target,'f1.json')),'未落定的记录绝不被释放方删除');
  fs.writeFileSync(gate,'1');
  const bo=await workerResult(b,'B'),ao=await workerResult(a,'A'),co=await workerResult(c,'C');
  assert.equal(bo.published,3);
  assert.equal(bo.assertHeldInside,'ok','持有上下文对磁盘租约注册表的跨进程验证通过（此刻 C/A 正被同一注册表挡在门外）');
  assert.equal(ao.published,0,'A 在租约内看到 marker：绝不重导');
  assert.equal(co.outcome,'released','租约落定、完成事实在：释放方进入后精确删除一次');
  assert.equal(fs.existsSync(path.join(fx.target,'f1.json')),false);
  assert.equal(fs.readFileSync(path.join(fx.target,'f2.json'),'utf8'),'two');
  assert.equal(fs.readFileSync(path.join(fx.target,'f3.json'),'utf8'),'three');
  assert.equal(JSON.parse(fs.readFileSync(fx.marker,'utf8')).schemaVersion,1);
  assert.equal(fs.readFileSync(path.join(fx.legacy,'f1.json'),'utf8'),'one','旧目录一字未改');
  assert.deepEqual(fs.readdirSync(fx.target).filter(name=>name.includes('migrating')),[],'无迁移中间物残留');
});

test('r24 回执级真跨进程：持有同 scope 租约内完成导入，第三进程 releaseSettled 排队，落定后只删一次',{timeout:90000},async()=>{
  const root=mkRoot('xreceipt'),storage=path.join(mkRoot('xreceiptstore'),'g');
  const legacyDir=path.join(storage,'run-submissions',cleanupDigest(root));
  const newDir=path.join(root,'simple_cluster','state','simple-experiment','run-submissions',cleanupDigest(root));
  const xBytes=JSON.stringify({root,operationId:'op-x',input:{marker:'legacy'},recovery:{},replacement:{}});
  const yBytes=JSON.stringify({root,operationId:'op-y',input:{marker:'legacy'},recovery:{},replacement:{}});
  w(path.join(legacyDir,cleanupDigest('op-x')+'.json'),xBytes);
  w(path.join(legacyDir,cleanupDigest('op-y')+'.json'),yBytes);
  const markerFile=path.join(root,'simple_cluster','state','simple-experiment','migrations','run-submissions-'+cleanupDigest(root)+'.done.json');
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'r24-xrec-'));
  const sig=path.join(dir,'a.signal'),gate=path.join(dir,'a.gate');
  const a=spawnWorker('receipt-hold',root,storage,'op-x',sig,gate);
  await waitFile(sig,'A 已持有回执 marker 同 scope 租约（导入未开始）');
  const c=spawnWorker('receipt-release',root,storage,'op-x');
  await new Promise(r=>setTimeout(r,800));
  assert.equal(c.exitCode===null,true,'第三进程释放必须被跨进程租约阻塞（未阻塞会立即以 pending-migration 退出）：c.out='+c.out+' c.err='+c.err);
  assert.ok(!fs.existsSync(markerFile)&&!fs.existsSync(path.join(newDir,cleanupDigest('op-x')+'.json')),'阻塞期间 C 不得删除或伪造未落定的回执');
  fs.writeFileSync(gate,'1');
  const ao=await workerResult(a,'A'),co=await workerResult(c,'C');
  assert.equal(ao.markerValue,'legacy','A 在持有上下文内完成字节导入');
  assert.equal(ao.assertHeld,'ok');
  assert.equal(co.outcome,'released');
  assert.equal(fs.existsSync(path.join(newDir,cleanupDigest('op-x')+'.json')),false,'落定后仅 C 这一次删除');
  assert.equal(fs.readFileSync(path.join(newDir,cleanupDigest('op-y')+'.json'),'utf8'),yBytes,'同批未终态回执 op-y 保留且字节一致');
  assert.equal(fs.readFileSync(path.join(legacyDir,cleanupDigest('op-x')+'.json'),'utf8'),xBytes,'旧回执目录一字未改');
  const host=new PlanRunHost({context:{globalStorageUri:{fsPath:storage}},loadDistributedQueue:async()=>({plans:[]})},root);
  assert.equal(await host.releaseSettled('op-x','submission-succeeded'),'not-found','释放幂等：已删除的回执不复活也不重复删');
});

test('r21 同一记录并发释放确定终态（恰好一方删除，其余 not-found）；目录伪装记录绝不被删',async()=>{
  const fx=migFixture('relpar');
  w(path.join(fx.legacy,'f1.json'),'a1');
  await P.ensureProjectDirectorySnapshotsMigrated(fx.projectRoot,fx.legacy,fx.target,MIG,fx.marker);
  const rec=path.join(fx.target,'f1.json');
  const results=await Promise.all([1,2,3].map(()=>P.releaseMigratedProjectSnapshotRecord(fx.projectRoot,fx.marker,rec)));
  assert.equal(results.filter(row=>row==='released').length,1,JSON.stringify(results));
  assert.ok(results.every(row=>row==='released'||row==='not-found'),'释放终态只有 released/not-found 两种，无假成功：'+JSON.stringify(results));
  assert.equal(fs.existsSync(rec),false);
  fs.mkdirSync(rec);w(path.join(rec,'inner.json'),'keep');
  await assert.rejects(()=>P.releaseMigratedProjectSnapshotRecord(fx.projectRoot,fx.marker,rec));
  assert.equal(fs.readFileSync(path.join(rec,'inner.json'),'utf8'),'keep','目录伪装记录：非 ENOENT 错误原样透出，内容保留');
});

test('r21 缓存守卫：POSIX 真实 chmod 写位拒绝/恢复 0700 通过/非项目路径不变；Windows 真实目录创建/项目归属/平台写位豁免',async()=>{
  const root=mkRoot('chmod');
  const cacheFile=path.join(P.projectCacheDir(root,'simple-experiment'),'manifest.json');
  const managedRoot=path.join(root,'simple_cluster');
  fs.mkdirSync(managedRoot,{recursive:true});
  if(process.platform==='win32'){
    // r24-Win 返修：Windows 分支不得空 return 冒充验证（0 断言=假绿）。st_mode 不承载 ACL 是已审平台语义
    // （谓词豁免，见 :131 用例）——这里用真实守卫走三件事：写位豁免下真实创建缓存目录、创建只落本项目
    // 受管子树（归属）、异项目路径早退绝不代建。Mac 原生 ACL 复验仍另列。
    fs.chmodSync(managedRoot,0o777); // 尽力置位（Windows 映射有限位）；无论 st_mode 呈何值，守卫都不得按 POSIX 位规则拒绝
    await P.ensureProjectManagedCacheFileDirectory(root,cacheFile);
    const created=P.projectCacheDir(root,'simple-experiment');
    assert.ok(fs.existsSync(created),'Windows 平台写位豁免：真实守卫创建缓存目录而非拒绝或空转');
    assert.ok(created.startsWith(managedRoot+path.sep),'创建的目录必须落在本项目受管子树内（归属）');
    const other=mkRoot('chmodOtherWin');
    await P.ensureProjectManagedCacheFileDirectory(root,path.join(P.projectCacheDir(other,'simple-experiment'),'manifest.json'));
    assert.equal(fs.existsSync(P.projectCacheDir(other,'simple-experiment')),false,'非本项目受管子树的缓存路径：早退保持原行为，绝不代 B 建目录或改写位置');
    return;
  }
  fs.chmodSync(managedRoot,0o777);
  await assert.rejects(()=>P.ensureProjectManagedCacheFileDirectory(root,cacheFile),/允许组\/其他用户写入/);
  assert.equal(fs.existsSync(P.projectCacheDir(root,'simple-experiment')),false,'拒绝发生在任何写入之前');
  fs.chmodSync(managedRoot,0o700);
  await P.ensureProjectManagedCacheFileDirectory(root,cacheFile);
  assert.ok(fs.existsSync(P.projectCacheDir(root,'simple-experiment')),'恢复 0700 后同一路径正常通过');
  const outside=path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'r21-out-')),'elsewhere','cache.json');
  fs.mkdirSync(path.dirname(outside),{recursive:true});fs.chmodSync(path.dirname(outside),0o777);
  await P.ensureProjectManagedCacheFileDirectory(root,outside);
  assert.ok(fs.existsSync(path.dirname(outside)),'非项目受管子树的缓存路径保持原行为：原样可用、不被改写位置');
});

// ── r20 producer 接线矩阵：驱动真实 RealtimeTunnelPanelProvider.finishPlanSubmissionProgress（vm 切片，
// 同 staleQueueRoundBehavior 先例）→ 真实 releaseSettledPlanSubmissionReceipt → 真实 PlanRunHost/租约/文件。
// 同步点用"已被接线捕获的返回 Promise"await 完成，不 sleep/轮询；三个真 succeeded 分支（正常 durable/
// 短恢复形态=带 workflowId 回执、keep_existing 形态=无 workflowId 回执）都释放；failed/cancelled/queued、
// 缺冻结 root、损坏回执、成功前已被取消的记录一律保留；释放只动冻结 root 下的精确回执。
function producerHost(warns){
  const vm=require('node:vm'),ts=require('typescript');
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/extension/legacy.ts'),'utf8');
  const ast=ts.createSourceFile('legacy.ts',source,ts.ScriptTarget.Latest,true);
  let cls;function visit(n){if(ts.isClassDeclaration(n)&&n.name&&n.name.getText(ast)==='RealtimeTunnelPanelProvider')cls=n;ts.forEachChild(n,visit);}visit(ast);
  const names=['finishPlanSubmissionProgress','releaseSettledPlanSubmissionReceipt'];
  const members=cls.members.filter(n=>n.name&&names.includes(n.name.getText(ast)));
  assert.equal(members.length,names.length,names.join(','));
  return vm.runInNewContext(ts.transpileModule('class Host{'+members.map(n=>n.getText(ast)).join('\n')+'};Host',
    {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
    {assert,console:{log(){},warn:(...a)=>warns.push(a.map(String).join(' '))},path,Date,JSON,String,Number,Map,Set,Promise,
     PlanRunHost,normalizePlanSelectionKey:s=>String(s||'').toLowerCase().trim(),errorMessage:e=>String(e&&e.message||e)});
}
test('r20 producer 接线：真 finish 的 succeeded/failed/cancelled/queued 矩阵只按成功事实释放，围栏与冻结 root 不动',async()=>{
  const root=mkRoot('wire'),storage=path.join(mkRoot('wireStore'),'g'),other=mkRoot('wireOther');
  const warns=[];const Host=producerHost(warns);const h=new Host();
  Object.assign(h,{context:{globalStorageUri:{fsPath:storage}}, // 真实 provider 形状：helper→PlanRunHost 迁移检查要读 legacy 目录锚点
    localOperations:{},distributedSubmissionAborts:new Map(),
    planSubmissionOperationId:m=>'plan-submit-'+m.clientActionId,markLocalOperationsDirty(){},postState(){},trimPlanSubmissionEpochs(){}});
  // 用既有返回 Promise 作同步点：包装（不替换语义）真实 helper，捕获接线发起的 Promise。
  const real=Object.getPrototypeOf(h).releaseSettledPlanSubmissionReceipt;
  const pending=[];h.releaseSettledPlanSubmissionReceipt=function(...a){const p=real.apply(this,a);pending.push(p);return p;};
  const store=new PlanRunHost({context:{globalStorageUri:{fsPath:storage}}},root);
  const recFile=op=>path.join(root,'simple_cluster','state','simple-experiment','run-submissions',cleanupDigest(root),cleanupDigest(op)+'.json');
  // durable 正常/短恢复形态（带 workflowId）与 keep_existing 形态（明确正常完成、可无 workflowId/新 plan）
  await store.save({submissionOperationIdLocal:'plan-submit-a',planFile:'plans/a.yaml',submissionWorkflowId:'wf-a'});
  await store.save({submissionOperationIdLocal:'plan-submit-k',planFile:'plans/k.yaml',existingOutputChoice:'keep_existing'});
  w(recFile('plan-submit-bad'),'not-json{{'); // 损坏事实：读不懂就保留
  w(path.join(path.dirname(recFile('plan-submit-a')),'user-keep.json'),'KEEP'); // 同目录用户/其它回执文件
  for(const op of ['a','k','bad','canc','f','q'])h.localOperations['plan-submit-'+op]={status:'running',planFile:'p.yaml',receiptRoot:root};
  h.localOperations['plan-submit-noot']={status:'running',planFile:'p.yaml'}; // 缺冻结 receiptRoot 的历史形状
  await store.save({submissionOperationIdLocal:'plan-submit-canc',planFile:'plans/c.yaml',submissionWorkflowId:'wf-c'});
  h.localOperations['plan-submit-canc'].status='cancelled'; // :6904 守卫：已取消记录不得被迟到 succeeded 覆写/删除
  await store.save({submissionOperationIdLocal:'plan-submit-f',planFile:'plans/f.yaml',submissionWorkflowId:'wf-f'});
  await store.save({submissionOperationIdLocal:'plan-submit-q',planFile:'plans/q.yaml',submissionWorkflowId:'wf-q'});
  // keep_existing 释放后不许新建其它项目路径；缺 root 的 noot 有回执（保留）
  await store.save({submissionOperationIdLocal:'plan-submit-noot',planFile:'plans/n.yaml'});
  const settle=async()=>{while(pending.length)await pending.shift();};
  h.finishPlanSubmissionProgress({clientActionId:'a'},'succeeded','调度队列已保存。'); // 正常 durable 形态
  h.finishPlanSubmissionProgress({clientActionId:'k'},'succeeded','用户选择保留已有产物，本次未创建新调度任务。'); // keep_existing
  h.finishPlanSubmissionProgress({clientActionId:'bad'},'succeeded','损坏记录的成功终态');
  h.finishPlanSubmissionProgress({clientActionId:'noot'},'succeeded','缺冻结 root 的成功终态');
  h.finishPlanSubmissionProgress({clientActionId:'canc'},'succeeded','迟到的成功显示不得改取消记录');
  h.finishPlanSubmissionProgress({clientActionId:'f'},'failed','校验未通过');
  h.finishPlanSubmissionProgress({clientActionId:'q'},'queued','等待前序');
  await settle();
  assert.equal(fs.existsSync(recFile('plan-submit-a')),false,'正常 durable：成功终态立即释放，不等 job 终态');
  assert.equal(fs.existsSync(recFile('plan-submit-k')),false,'keep_existing：无 workflowId 也是明确成功，释放且不虚构 plan');
  assert.equal(fs.readFileSync(path.join(path.dirname(recFile('plan-submit-a')),'user-keep.json'),'utf8'),'KEEP','只删精确回执，同目录其它文件不动');
  assert.equal(fs.readFileSync(recFile('plan-submit-bad'),'utf8'),'not-json{{','损坏回执保留原字节');
  assert.ok(fs.existsSync(recFile('plan-submit-noot')),'缺冻结 receiptRoot：明确保留并记日志，绝不猜当前 workspaceRoot');
  assert.ok(warns.some(row=>/缺少冻结归属/.test(row)),JSON.stringify(warns));
  assert.ok(fs.existsSync(recFile('plan-submit-canc')),'已取消记录+迟到 succeeded：:6904 守卫，保留不改写');
  assert.equal(h.localOperations['plan-submit-canc'].status,'cancelled');
  assert.ok(fs.existsSync(recFile('plan-submit-f')),'failed 保留（恢复入口依赖其明确错误语义）');
  assert.equal(h.localOperations['plan-submit-f'].retryableSubmission,undefined,'finish 不新增/篡改记录字段');
  assert.ok(fs.existsSync(recFile('plan-submit-q')),'queued 保留');
  assert.equal(h.localOperations['plan-submit-a'].status,'succeeded');
  // 幂等：重复 succeeded 终态只产生 not-found，不复活也不重复删；marker 持久→释放值不复活由 :104 用例钉住
  h.finishPlanSubmissionProgress({clientActionId:'a'},'succeeded','重复终态');await settle();
  assert.equal(fs.existsSync(recFile('plan-submit-a')),false);
  assert.ok(!fs.existsSync(path.join(other,'simple_cluster')),'其它项目树全程零创建');
  // 两项目交错：B 的回执只按 B 的冻结 root 释放，A 终态不触碰 B
  const storeB=new PlanRunHost({context:{globalStorageUri:{fsPath:storage}}},other);
  await storeB.save({submissionOperationIdLocal:'plan-submit-b1',planFile:'plans/b.yaml',submissionWorkflowId:'wf-b'});
  h.localOperations['plan-submit-b1']={status:'running',planFile:'p.yaml',receiptRoot:other};
  h.finishPlanSubmissionProgress({clientActionId:'b1'},'succeeded','B 成功终态（工作区已切走也不影响冻结归属）');await settle();
  assert.equal(fs.existsSync(path.join(other,'simple_cluster','state','simple-experiment','run-submissions',cleanupDigest(other),cleanupDigest('plan-submit-b1')+'.json')),false,'B 回执按 B 冻结 root 精确释放');
  assert.equal(fs.readFileSync(path.join(path.dirname(recFile('plan-submit-a')),'user-keep.json'),'utf8'),'KEEP','B 的释放零触碰 A 文件');
});
