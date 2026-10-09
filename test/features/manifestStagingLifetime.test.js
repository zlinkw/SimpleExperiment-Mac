const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

function makeAtomicWriteText(io) {
  return async (file, text) => {
    await io.mkdir(path.dirname(file), { recursive: true });
    const staging = file + ".writing";
    const existing = await io.lstat(staging).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("staging path is not a regular file");
    await io.writeFile(staging, text);
    await io.rename(staging, file);
  };
}

function cacheWriter(io) {
  const text=fs.readFileSync(require.resolve('../../src/features/LocalCodeManifestCache.ts'),'utf8');
  const ast=ts.createSourceFile('cache.ts',text,ts.ScriptTarget.Latest,true);
  const functions=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&['writeCache','writeCacheOwned'].includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');
  const c=vm.createContext({fs:io,path,process,atomicWriteText:makeAtomicWriteText(io),HostOperationLeaseManager:class{run(_args,fn){return fn();}}});
  vm.runInContext(ts.transpileModule('const cacheWrites = new Map();'+functions,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';this.queues=cacheWrites;',c);
  return c;
}

test('repeated failed cache publication leaves at most one reusable staging file, consumed on success',async()=>{
  const files=new Map([['cache.json','old']]);let fail=true;
  const io={mkdir:async()=>{},lstat:async file=>files.has(file)?{isFile:()=>true,isSymbolicLink:()=>false}:Promise.reject({code:'ENOENT'}),
    writeFile:async(file,text)=>files.set(file,text),rename:async(from,to)=>{if(fail)throw new Error('locked');files.set(to,files.get(from));files.delete(from);}};
  const c=cacheWriter(io);
  for(let i=0;i<50;i++)await assert.rejects(c.writeCache('cache.json',{files:{i}}),/locked/);
  assert.equal(files.size,2);assert.equal(files.get('cache.json'),'old');assert.equal(c.queues.size,0);
  fail=false;await c.writeCache('cache.json',{files:{latest:true}});
  assert.equal(files.size,1);assert.equal(JSON.parse(files.get('cache.json')).files.latest,true);assert.equal(c.queues.size,0);
});

test('nested cache writers serialize the staging slot and never follow a staged symlink',async()=>{
  let writing=0,max=0;
  const c=cacheWriter({mkdir:async()=>{},lstat:async()=>{throw {code:'ENOENT'};},
    writeFile:async()=>{max=Math.max(max,++writing);await new Promise(r=>setImmediate(r));},rename:async()=>{writing--;}});
  await Promise.all(Array.from({length:20},(_,i)=>c.writeCache('cache.json',{i})));
  assert.equal(max,1);assert.equal(c.queues.size,0);
  const guarded=cacheWriter({mkdir:async()=>{},lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>true}),writeFile:async()=>assert.fail('symlink followed')});
  await assert.rejects(guarded.writeCache('cache.json',{}),/regular file/);
});

test('scope hash memory cache evicts old identities without changing retained hashes',()=>{
  const text=fs.readFileSync(require.resolve('../../src/features/SyncScopeStatus.ts'),'utf8');
  const ast=ts.createSourceFile('scope.ts',text,ts.ScriptTarget.Latest,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='rememberLocalScopeHash').getText(ast);
  const limit=Number(text.match(/LOCAL_HASH_CACHE_LIMIT = (\d+)/)[1]);
  const cache=new Map();const c=vm.createContext({localHashCache:cache,LOCAL_HASH_CACHE_LIMIT:limit});
  vm.runInContext(ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
  for(let i=0;i<limit+1000;i++)c.rememberLocalScopeHash('file-'+i,'identity-'+i,{sha256:'hash-'+i,size:i});
  assert.equal(cache.size,limit);assert.equal(cache.has('file-0'),false);
  const recent=cache.get('file-1000');c.rememberLocalScopeHash('file-1000',recent.identity,recent.file);
  c.rememberLocalScopeHash('next','new',{sha256:'latest',size:1});
  assert.equal(cache.get('file-1000').file.sha256,'hash-1000');assert.equal(cache.has('file-1001'),false);
});

test('resource registry failures reuse one staging slot and keep prior ownership evidence',async()=>{
  const text=fs.readFileSync(require.resolve('../../src/core/ResourceOperationLease.ts'),'utf8');
  const ast=ts.createSourceFile('lease.ts',text,ts.ScriptTarget.Latest,true);
  const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='ResourceOperationLeaseManager');
  const method=cls.members.filter(n=>['write','reuseIdleRegistry'].includes(n.name?.getText(ast))).map(n=>n.getText(ast)).join('\n');
  const files=new Map([['registry.json','trusted']]);let fail=true;
  const io={mkdir:async()=>{},lstat:async file=>files.has(file)?{isFile:()=>true,isSymbolicLink:()=>false}:Promise.reject({code:'ENOENT'}),
    writeFile:async(file,value)=>files.set(file,value),rename:async(from,to)=>{if(fail)throw Object.assign(new Error('disk failure'),{code:'EIO'});files.set(to,files.get(from));files.delete(from);}};
  const Lease=vm.runInNewContext(ts.transpileModule(`class Lease {${method}};Lease`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{fs:io,Buffer,atomicWriteText:makeAtomicWriteText(io)});
  const lease=new Lease();lease.directory='registry';lease.file='registry.json';lease.state={registry:{leases:[]}};
  for(let i=0;i<50;i++)await assert.rejects(lease.write(),/disk failure/);
  assert.equal(files.size,2);assert.equal(files.get('registry.json'),'trusted');
  fail=false;await lease.write();assert.equal(files.size,2);
  assert.equal(files.has('registry.json.writing'),false);
  assert.equal(files.has('registry.json.ownership.writing'),false);
  assert.equal(files.get('registry.json.ownership'),files.get('registry.json'));
});
