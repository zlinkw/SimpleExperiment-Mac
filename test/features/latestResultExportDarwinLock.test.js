const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const L=require('../../dist/results/LatestResultExport.js');

// r17-B 契约（Linux 可测部分）：macOS 结果写锁改为项目内 O_EXLOCK 空文件——数值位 0x20 只允许
// darwin 分支执行（Linux 上 0x20=O_APPEND，resultLockOpenFlags 直接拒绝）；等待/取消/透传沿用原
// 50ms/5s 语义；句柄与路径必须同一 inode、普通单硬链、属主 UID。本文件不冒充 macOS 原生内核验收：
// 0x20 位的真实互斥、崩溃释放与双进程竞争属 Mac 原生缺口（evidence §44/§47），留给宿主 Mac 验收。

function mkTmp(tag){const d=fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'r17-b-'+tag+' ')));return d;}
function stat(over){return Object.assign({isFile:()=>true,nlink:1,uid:typeof process.getuid==='function'?process.getuid():1000,ino:7,dev:3,mode:0o600},over);}

test('平台分流：win32=pipe、darwin=exlock、其余（含 Linux）=tcp，Linux 分支保持不变',()=>{
  assert.equal(L.resultCoordinationMode('win32'),'pipe');
  assert.equal(L.resultCoordinationMode('darwin'),'exlock');
  for(const p of ['linux','freebsd','openbsd','sunos','aix'])assert.equal(L.resultCoordinationMode(p),'tcp',p);
});

test('锁文件是被消费项目内的稳定空文件，随 root 隔离，无端口/管道',()=>{
  const a=mkTmp('rootA'),b=mkTmp('rootB');
  const f=L.resultLockFile(a,'ab12'), g=L.resultLockFile(b,'ab12');
  assert.equal(f,path.join(a,'simple_cluster','locks','simple-experiment','results','ab12.lock'));
  assert.notEqual(f,g,'两项目并发各锁各的，绝不共享');
  assert.ok(!/[0-9]{4,}/.test(path.basename(f))&&!f.includes('pipe'));
});

test('O_EXLOCK 数值位 0x20 只允许 darwin 使用；Linux 传入同一 constants 必须拒绝',()=>{
  const flags=L.resultLockOpenFlags(fs.constants,'darwin');
  assert.equal(flags&0x20,0x20,'macOS 位必须显式置位');
  assert.equal(flags,(fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|0x20)>>>0);
  assert.equal(flags&(fs.constants.O_TRUNC||0),0,'绝不截断已有内容');
  // 0x20 在非 darwin 平台不是 O_EXLOCK（含义完全不同；参考：Linux O_APPEND=1024，并非 0x20）——禁止复用该位。
  for(const p of ['linux','win32','freebsd'])assert.throws(()=>L.resultLockOpenFlags(fs.constants,p),/仅 macOS/,p+' 不得复用 0x20 位');
});

test('句柄校验：普通单硬链+属主 UID+路径-句柄同 inode 才放行，其他一律显式失败',()=>{
  assert.equal(L.assertResultLockStats(stat({}),stat({})),false);
  assert.equal(L.assertResultLockStats(stat({mode:0o644}),stat({})),true,'非 0600 要求收紧');
  assert.throws(()=>L.assertResultLockStats(stat({nlink:2}),stat({})),/RESULT_LOCK_PATH_UNSAFE/,'他人硬链不得借锁');
  assert.throws(()=>L.assertResultLockStats(stat({isFile:()=>false}),stat({})),/RESULT_LOCK_PATH_UNSAFE/);
  assert.throws(()=>L.assertResultLockStats(stat({ino:8}),stat({ino:7})),/RESULT_LOCK_PATH_UNSAFE/,'路径与句柄 inode 不一致=换脸');
  assert.throws(()=>L.assertResultLockStats(stat({uid:4242}),stat({}),()=>1000),/不属于当前用户/);
});

test('等待语义：EAGAIN/EWOULDBLOCK 50ms 有界等待、每轮可取消、其他错误原样透传不回落',async()=>{
  let calls=0;
  const ok={close:async()=>{}};
  const again=code=>{const e=Error(code);e.code=code;throw e;};
  assert.equal(await L.acquireResultExlock(Date.now()+5000,()=>true,async()=>{calls++;return ok;}),ok);
  calls=0;
  const got=await L.acquireResultExlock(Date.now()+5000,()=>true,async()=>{calls++;if(calls<3)again(calls===1?'EAGAIN':'EWOULDBLOCK');return ok;});
  assert.equal(got,ok);assert.equal(calls,3);
  calls=0;
  await assert.rejects(()=>L.acquireResultExlock(Date.now()+120,()=>true,async()=>{calls++;again('EAGAIN');}),/结果文件正在其他窗口更新/);
  assert.ok(calls>=2,'必须有界重试而非一次即弃');
  calls=0;
  await assert.rejects(()=>L.acquireResultExlock(Date.now()+5000,()=>true,async()=>{calls++;again('EACCES');}),/EACCES/);
  assert.equal(calls,1,'非 EAGAIN 错误绝不重试、绝不静默改走 TCP');
  calls=0;
  await assert.rejects(()=>L.acquireResultExlock(Date.now()+5000,()=>false,async()=>{calls++;return ok;}),/已取消/);
  assert.equal(calls,0,'取消在打开前生效');
});

// Windows 返修：POSIX 规则经可注入 stat/chmod/getuid seam 在【所有平台】跑同一决策路径——
// Windows 上规则断言一条不少；POSIX 真实 chmod/链接强制另列 Mac/Linux 原生必验，不以注入冒充。
test('锁目录属主/权限门禁规则表（注入 stat/chmod/getuid，全平台一致）：组/其他可写失败、自有收紧 0700、链接/非目录/他人 uid 拒绝',async()=>{
  const mkStat=o=>({isSymbolicLink:()=>!!o.link,isDirectory:()=>o.dir!==false,uid:o.uid===undefined?1000:o.uid,mode:o.mode===undefined?0o700:o.mode});
  const chmods=[];
  const deps=o=>({lstat:async()=>mkStat(o),chmod:async(p,m)=>{chmods.push([p,m]);},getuid:()=>1000,platform:'darwin'});
  await L.assertResultLockDirectory('/own',deps({mode:0o755}));
  assert.deepEqual(chmods,[['/own',0o700]],'0755 自有目录收紧为 0700');
  await assert.rejects(()=>L.assertResultLockDirectory('/g',deps({mode:0o770})),/组\/其他用户写入/);
  await assert.rejects(()=>L.assertResultLockDirectory('/o',deps({mode:0o720})),/组\/其他用户写入/);
  await assert.rejects(()=>L.assertResultLockDirectory('/l',deps({link:true})),/UNSAFE/,'链接目录冒充即拒');
  await assert.rejects(()=>L.assertResultLockDirectory('/f',deps({dir:false})),/UNSAFE/);
  await assert.rejects(()=>L.assertResultLockDirectory('/u',deps({uid:4242})),/不属于当前用户/);
  assert.equal(L.managedWriteBitsAllowed(0o770,'win32'),true,'Windows st_mode 不承载 NTFS ACL 语义——真实 ACL 强制是平台原生必验项');
  assert.equal(L.managedWriteBitsAllowed(0o770,'darwin'),false);assert.equal(L.managedWriteBitsAllowed(0o755,'linux'),true);
  assert.equal(chmods.length,1,'拒绝路径绝不写盘/绝不静默 chmod 他人目录');
});

test('POSIX 真实目录效果（macOS/Linux 原生；Windows 实跑同规则路径但不伪装 POSIX 收紧）',async()=>{
  const base=mkTmp('lockdir');
  const good=path.join(base,'simple_cluster','locks','simple-experiment','results');
  fs.mkdirSync(good,{recursive:true});fs.chmodSync(good,0o755);
  await L.assertResultLockDirectory(good);
  if(process.platform==='win32'){
    // Windows：同一门禁代码路径真实执行到（不因平台崩溃/跳过），POSIX 收紧与真实 ACL 效果
    // 属平台原生必验（evidence §47），此处不伪造 st_mode 断言。
    return;
  }
  assert.equal(fs.statSync(good).mode&0o777,0o700,'自有目录收紧');
  const bad=path.join(base,'bad');fs.mkdirSync(bad);fs.chmodSync(bad,0o720);
  await assert.rejects(()=>L.assertResultLockDirectory(bad),/组\/其他用户写入|UNSAFE/);
  const link=path.join(base,'link');
  try{fs.symlinkSync(good,link,'dir');await assert.rejects(()=>L.assertResultLockDirectory(link),/UNSAFE/);}catch(error){if(error.code!=='ENOSYS'&&error.code!=='EPERM')throw error;}
});
