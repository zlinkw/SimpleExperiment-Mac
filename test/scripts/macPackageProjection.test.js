const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {createPackageProjection,assertPackageProjection}=require('../../scripts/mac-package-projection');
function fixture(){
 const root=path.resolve(__dirname,'../../release-artifacts','打包快照测试 '+crypto.randomUUID());fs.mkdirSync(root,{recursive:true});
 const write=(relative,bytes)=>{const file=path.join(root,...relative.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});};
 const trackedFiles=['package.json','.vscodeignore','README.md','docs/中文 guide.md','src/unpackaged.js'];
 write('package.json',JSON.stringify({name:'fixture',publisher:'simple-local',version:'0.1.0',engines:{vscode:'^1.100.0'},main:'./dist/extension.js',activationEvents:['onStartupFinished']}));
 write('.vscodeignore','src/**\nrelease-artifacts/**\n');write('README.md','Mac 使用说明\n');write('docs/中文 guide.md','中文与空格\n');write('src/unpackaged.js','source');write('dist/extension.js','module.exports={}');
 write('release-artifacts/retained/old.log','evidence');return {root,write,options:{trackedFiles}};
}
test('real pinned VSCE selects snapshot files using the unchanged source ignore policy',()=>{
 const f=fixture(),p=createPackageProjection(f.root,f.options),r=spawnSync(process.execPath,[require.resolve('@vscode/vsce/vsce'),'ls','--no-dependencies'],{cwd:p.directory,encoding:'utf8',timeout:8000,windowsHide:true});
 assert.equal(r.status,0,r.stderr||r.error?.message);const files=r.stdout.split(/\r?\n/).filter(Boolean);
 for(const file of ['package.json','README.md','docs/中文 guide.md','dist/extension.js'])assert.ok(files.includes(file),file);
 assert.ok(!files.some(file=>file.startsWith('src/')||file.startsWith('release-artifacts/')));
 assert.equal(assertPackageProjection(p),true);assert.equal(fs.readFileSync(path.join(f.root,'release-artifacts/retained/old.log'),'utf8'),'evidence');
});
test('snapshot binds every source and compiled byte and rejects changes without repairing them',()=>{
 const f=fixture(),p=createPackageProjection(f.root,f.options);
 fs.appendFileSync(path.join(f.root,'dist/extension.js'),'changed','utf8');assert.throws(()=>assertPackageProjection(p),/changed/);
 assert.equal(fs.readFileSync(path.join(p.directory,'dist/extension.js'),'utf8'),'module.exports={}');
});
test('snapshot mutation and new runtime files invalidate the package source binding',()=>{
 const f=fixture(),p=createPackageProjection(f.root,f.options);fs.appendFileSync(path.join(p.directory,'README.md'),'changed','utf8');
 assert.throws(()=>assertPackageProjection(p),/changed/);
 const g=fixture(),q=createPackageProjection(g.root,g.options);g.write('dist/new.js','new');assert.throws(()=>assertPackageProjection(q),/file set changed/);
});
test('an extra snapshot file cannot enter the package without a source binding',()=>{
 const f=fixture(),p=createPackageProjection(f.root,f.options);
 fs.writeFileSync(path.join(p.directory,'unexpected.js'),'extra',{flag:'wx'});
 assert.throws(()=>assertPackageProjection(p),/snapshot identity or file set changed/);
});
test('tracked paths cannot escape, refer to machine evidence, or stringify invalid types',()=>{
 for(const value of ['../escape','a/../escape','/absolute','a\\b','C:/drive','release-artifacts/old','node_modules/a',null,{},[]]){
  const f=fixture();assert.throws(()=>createPackageProjection(f.root,{trackedFiles:[...f.options.trackedFiles,value]}),/Unsafe/);
 }
});
test('directory links are rejected before a package source can be borrowed',()=>{
 const f=fixture(),outside=path.join(f.root,'other');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'data.js'),'source',{flag:'wx'});
 fs.symlinkSync(outside,path.join(f.root,'linked'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>createPackageProjection(f.root,{trackedFiles:[...f.options.trackedFiles,'linked/data.js']}),/directory identity/);
 assert.equal(fs.readFileSync(path.join(outside,'data.js'),'utf8'),'source');
});
test('source manifest and ignore policy are mandatory and tracked budgets remain bounded',()=>{
 const f=fixture();assert.throws(()=>createPackageProjection(f.root,{trackedFiles:['README.md']}),/manifest or ignore/);
 assert.throws(()=>createPackageProjection(f.root,{trackedFiles:Array.from({length:8193},(_,i)=>'files/'+i)}),/budget/);
});
