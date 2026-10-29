// 本机映射指标发布的“发布前身份校验”覆盖（缺陷现场：v0.5.416 及之前，legacy.ts 把目标文件的父目录 checkedParent
// 当成暂存槽所在目录比对，而 mappedResultTemporaryRelativePath 把临时文件固定写在
// <项目根>/simple_cluster/tmp/mapped-staging/.simple-mapped-<token>.tmp，两者在任何平台都必然不相等，
// 于是每次正常本机发布都会抛「本机映射暂存文件身份在发布前变化」并留下暂存残留，功能整体不可用）。
// 权威仓此前对该路径零覆盖：test 目录里既没有 mapped-staging 相关断言，也没有正常发布用例。
// 本文件全部经 __distributeMappedDownloadsForTest（legacy.ts 的真实测试缝）在 dist 产物上跑真实实现。
// 暂存槽路径用测试内手写 oracle（独立于被测函数），避免用被测输出反推期望自证。
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'),
  fs = require('node:fs'), Module = require('node:module'), os = require('node:os'), path = require('node:path');

const vscodeStub = {
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, setStatusBarMessage() {} },
  commands: { executeCommand: async () => ({ ok: true }) },
  Uri: { file: value => ({ fsPath: value }) },
};
const originalLoad = Module._load;
Module._load = function (request, ...args) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, ...args); };
const { __distributeMappedDownloadsForTest: distributeMappedDownloads } = require('../../dist/extension/legacy.js');
Module._load = originalLoad;

const REMOTE = 'simple_cluster/results/worker-a/seed_metrics.csv';
const STAGING_SEGMENT = path.join('simple_cluster', 'tmp', 'mapped-staging');
const IDENTITY_GUARD = '本机映射暂存文件身份在发布前变化，暂存保留：';
const PARENT_GUARD = '本机映射父目录在写入后发生变化，暂存保留：';
const FIXTURE_PREFIX = 'se-mapped-publish-';

// 手写上线格式 oracle：槽名 = sha256(目标相对路径，win32 先折叠大小写) 前 24 位；暂存槽目录不应由目标父目录代替，
// 它固定在项目根 tmp 暂存区——被修错的正是这个比对对象。
function slotOf(root, destinationRelative) {
  const folded = process.platform === 'win32' ? String(destinationRelative).toLowerCase() : String(destinationRelative);
  const token = crypto.createHash('sha256').update(folded).digest('hex').slice(0, 24);
  assert.equal(token.length, 24, '槽名 token 必须是 24 位 sha256 前缀');
  return path.join(root, STAGING_SEGMENT, `.simple-mapped-${token}.tmp`);
}
const sha256Of = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const entry = localRelative => ({ remotePath: REMOTE, localRelative });
const abs = (root, relative) => path.join(root, ...String(relative).split('/'));

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), FIXTURE_PREFIX)));
  fs.mkdirSync(path.join(root, 'stage'), { recursive: true });
  return {
    root,
    stagingDir: path.join(root, STAGING_SEGMENT),
    slot: destinationRelative => slotOf(root, destinationRelative),
    put(relative, text) { const file = abs(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; },
    read(relative) { return fs.readFileSync(abs(root, relative), 'utf8'); },
    exists(relative) { return fs.existsSync(abs(root, relative)); },
    run(entries, transfers, overwrite = true, hooks) { return distributeMappedDownloads(root, entries, transfers, overwrite, hooks); },
  };
}

// 测试内独立实现的精确清单（不读被测函数的内部 residues 数组，也不为此改生产接口）：
// 递归列出目录内条目，目录以 / 结尾，符号链接带 @symlink 后缀，排序后逐条比对。
function listingUnder(dir) {
  if (!fs.existsSync(dir)) return ['<目录本身不存在>'];
  const walk = (base, rel) => {
    const out = [];
    for (const info of fs.readdirSync(base, { withFileTypes: true })) {
      const child = path.join(base, info.name);
      const relChild = rel ? `${rel}/${info.name}` : info.name;
      const isLink = info.isSymbolicLink();
      if (!isLink && info.isDirectory()) {
        out.push(`${relChild}/`);
        out.push(...walk(child, relChild));
      } else {
        out.push(isLink ? `${relChild}@symlink` : relChild);
      }
    }
    return out;
  };
  return walk(dir, '').sort();
}

// 删除安全（本仓 P0）：本文件只允许删除自己刚在系统临时目录下创建的夹具根，且必须走完整核验：
// 1) 安全根与目标的直接父目录都解析为规范路径；2) 父目录必须确实落在安全根内；3) 目标不得在项目仓库内；
// 4) cd 进该直接父目录并核实当前物理目录就是它；5) 删除参数只能是 ./<直接子项> 的最短相对路径。
// 任一检查或 cd 失败：立即停止删除、把夹具原样保留、把路径记入清单（由最后一个用例统一报出），绝不退回绝对路径删除。
const TEMP_ROOT = fs.realpathSync(os.tmpdir());
const REPO_ROOT = fs.realpathSync(path.join(__dirname, '..', '..'));
const retainedFixtures = [];
function removeOwnFixture(dir, expectedPrefix) {
  let target;
  try {
    target = fs.realpathSync(dir);
  } catch (error) {
    retainedFixtures.push(`规范路径解析失败，夹具保留：${dir}（${error?.code || error?.message}）`);
    return;
  }
  const name = path.basename(target);
  const parentReal = path.dirname(target);
  const within = path.relative(TEMP_ROOT, parentReal);
  // 夹具可能直接建在安全根下（此时 parentReal 恰好等于 TEMP_ROOT），也允许；但绝不允许越出安全根。
  if ((parentReal !== TEMP_ROOT && !parentReal.startsWith(TEMP_ROOT + path.sep)) || within.startsWith('..') || path.isAbsolute(within)) {
    retainedFixtures.push(`直接父目录不在已验证安全根内，夹具保留：${target}`);
    return;
  }
  if (target.startsWith(REPO_ROOT + path.sep)) {
    retainedFixtures.push(`目标疑似位于项目仓库内，夹具保留：${target}`);
    return;
  }
  if (!name.startsWith(expectedPrefix)) {
    retainedFixtures.push(`目标不是本用例创建的夹具（名称前缀只是附加校验，不是唯一依据），夹具保留：${target}`);
    return;
  }
  const previousCwd = process.cwd();
  try {
    process.chdir(parentReal);
    if (fs.realpathSync(process.cwd()) !== parentReal) {
      retainedFixtures.push(`cd 后当前物理目录与目标父目录不一致，夹具保留：${target}`);
      return;
    }
    fs.rmSync(`./${name}`, { recursive: true, force: true }); // 只删当前目录下的直接子项
  } catch (error) {
    retainedFixtures.push(`删除未执行/失败，夹具保留：${target}（${error?.code || error?.message}）`);
  } finally {
    try { process.chdir(previousCwd); } catch { /* cwd 归还失败不掩盖已记录的保留清单 */ }
  }
}

// 让位而非删除：把原对象在同一目录里改名挪开，保留其句柄/身份（dev/ino）供断言，再在原位置放置替换对象。
function vacate(originalPath, suffix) {
  const vacated = `${originalPath}${suffix}`;
  fs.renameSync(originalPath, vacated);
  return vacated;
}

// 身份变化取证：必须拿到两侧有效 dev/ino 并证明确实换了对象，否则该用例只是空转通过。
function assertIdentityChanged(before, after, what) {
  assert.ok(before && before.ino > 0 && after && after.ino > 0,
    `${what}：平台必须给出有效 ino 才能证明身份变化（before=${JSON.stringify(before)} after=${JSON.stringify(after)}）`);
  assert.notEqual(`${before.dev}:${before.ino}`, `${after.dev}:${after.ino}`,
    `${what}：dev/ino 未变化，本用例等于空转通过（before=${JSON.stringify(before)} after=${JSON.stringify(after)}）`);
}

async function captureFailure(run) {
  try { await run(); } catch (error) { return error; }
  return undefined;
}

// 1) 正常发布：内容逐字节相同、发布前身份校验不再误判、暂存槽不留下残留。
test('normal local publication delivers exact source bytes and leaves the staging slot clean', async () => {
  const f = fixture();
  try {
    const source = f.put('stage/one.csv', 'case,seed,AUC\nalpha,42,0.92\n');
    const delivered = await f.run([entry('out/one.csv')], [{ remotePath: REMOTE, localRelativePath: 'stage/one.csv' }]);
    assert.equal(delivered, 1, '单个目标正常发布必须计为 1 次交付');
    assert.equal(f.read('out/one.csv'), 'case,seed,AUC\nalpha,42,0.92\n', '目标内容必须逐字节等于来源');
    assert.equal(sha256Of(abs(f.root, 'out/one.csv')), sha256Of(source), '目标与来源 SHA256 必须相同');
    assert.equal(f.slot('out/one.csv').startsWith(f.stagingDir + path.sep), true, '槽位必须落在项目根 tmp 暂存区内，而不是目标父目录');
    assert.deepEqual(listingUnder(f.stagingDir), [], '发布成功后暂存槽目录必须为空（槽位已改名走，不留残留）');
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'out')), ['one.csv'], '目标目录里只允许出现目标文件本身');
  } finally { removeOwnFixture(f.root, FIXTURE_PREFIX); }
});

// 2) 一次多个目标：同一来源派到两个目标，各自独立通过校验，各自内容正确、槽位互不共用。
test('multiple destinations in one call are each validated and delivered with their own slot identity', async () => {
  const f = fixture();
  try {
    f.put('stage/one.csv', 'UPPER');
    const delivered = await f.run([entry('out/one.csv'), entry('nested/dir/two.csv')],
      [{ remotePath: REMOTE, localRelativePath: 'stage/one.csv' }]);
    assert.equal(delivered, 2, '两条 entry 必须各计一次交付');
    assert.equal(f.read('out/one.csv'), 'UPPER');
    assert.equal(f.read('nested/dir/two.csv'), 'UPPER', '同一 remote 的多个目标共享同一来源字节');
    assert.notEqual(f.slot('out/one.csv'), f.slot('nested/dir/two.csv'), '每个目标必须使用各自的暂存槽');
    assert.deepEqual(listingUnder(f.stagingDir), [], '全部成功后暂存目录必须为空');
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'nested', 'dir')), ['two.csv'], '第二目标所在的新建目录只含目标文件');
    if (process.platform === 'win32') {
      assert.equal(f.slot('out/ONE.CSV'), f.slot('out/one.csv'), 'win32 相对路径大小写折叠后必须映射到同一槽位');
    }
  } finally { removeOwnFixture(f.root, FIXTURE_PREFIX); }
});

// 3) inode 替换：写入完成后让原暂存文件改名让位（不删，保留原对象身份），在同名位置新建文件 → dev/ino 必须确实已变化，
// 然后必须抛错并保留现场，目标不得产生。
test('recreated staging slot with a new inode is rejected before publish and the scene is preserved', async () => {
  const f = fixture();
  try {
    f.put('stage/one.csv', 'downloaded-payload');
    const slot = f.slot('out/one.csv');
    let evidence = null;
    const failure = await captureFailure(() => f.run([entry('out/one.csv')],
      [{ remotePath: REMOTE, localRelativePath: 'stage/one.csv' }], true, {
        beforeRename: ({ temporary }) => {
          assert.equal(temporary, slot, '钩子收到的必须是被校验的那个暂存槽');
          const before = fs.statSync(temporary);
          const vacated = vacate(temporary, '.original-object');
          fs.writeFileSync(temporary, 'tampered-by-attacker');
          const after = fs.statSync(temporary);
          assertIdentityChanged(before, after, '暂存槽被同名新文件替换');
          assert.equal(fs.statSync(vacated).ino, before.ino, '原暂存对象必须原样保留（未被删除），身份不变');
          evidence = { before, after, vacated };
        },
      }));
    assert.ok(evidence, '钩子必须真实执行过替换');
    assert.ok(failure, '替换后的暂存文件必须抛错，不能静默发布');
    assert.equal(failure.message, `${IDENTITY_GUARD}${slot}`, '错误必须是身份变化文案并逐字带上被保留的暂存槽路径');
    assert.equal(f.exists('out/one.csv'), false, '目标文件不得产生');
    assert.equal(fs.existsSync(slot), true, '被替换的暂存文件必须原样保留（现场不被清理）');
    assert.equal(fs.readFileSync(slot, 'utf8'), 'tampered-by-attacker', '保留的必须是替换后的内容，不得被截断或覆盖');
    assert.deepEqual(listingUnder(f.stagingDir), [path.basename(slot), `${path.basename(slot)}.original-object`].sort(),
      '暂存目录的精确列表必须只剩「替换后的槽位 + 让位的原对象」两项');
  } finally { removeOwnFixture(f.root, FIXTURE_PREFIX); }
});

// 4) 暂存槽被换成目录（无需符号链接权限的真实替换）：!isFile 分支必须抛同一守护并保留现场。
test('staging slot replaced by a directory is rejected before publish and the scene is preserved', async () => {
  const f = fixture();
  try {
    f.put('stage/one.csv', 'downloaded-payload');
    const slot = f.slot('out/one.csv');
    let evidence = null;
    const failure = await captureFailure(() => f.run([entry('out/one.csv')],
      [{ remotePath: REMOTE, localRelativePath: 'stage/one.csv' }], true, {
        beforeRename: ({ temporary }) => {
          const before = fs.statSync(temporary);
          const vacated = vacate(temporary, '.original-object');
          fs.mkdirSync(temporary);
          fs.writeFileSync(path.join(temporary, 'inside'), 'x');
          const after = fs.statSync(temporary);
          assert.ok(after.isDirectory(), '该用例必须真的把槽位变成目录');
          assertIdentityChanged(before, after, '暂存槽被换成目录');
          assert.equal(fs.statSync(vacated).ino, before.ino, '原暂存对象必须原样保留（未被删除）');
          evidence = { before, after, vacated };
        },
      }));
    assert.ok(evidence, '钩子必须真实执行过替换');
    assert.ok(failure, '暂存槽变成目录必须抛错');
    assert.equal(failure.message, `${IDENTITY_GUARD}${slot}`, '错误必须是身份变化文案并逐字带上暂存槽路径');
    assert.equal(f.exists('out/one.csv'), false, '目标文件不得产生');
    assert.equal(fs.lstatSync(slot).isDirectory(), true, '替换成的目录必须原样保留');
    assert.equal(fs.readFileSync(path.join(slot, 'inside'), 'utf8'), 'x', '槽内内容不得被回收或覆盖');
    assert.deepEqual(listingUnder(f.stagingDir),
      [`${path.basename(slot)}/`, `${path.basename(slot)}/inside`, `${path.basename(slot)}.original-object`].sort(),
      '暂存目录的精确列表必须是「槽位目录 + 目录内文件 + 让位的原对象」三项');
  } finally { removeOwnFixture(f.root, FIXTURE_PREFIX); }
});

// 5) 符号链接替换：写入完成后把暂存文件换成指向别处的 symlink → 必须抛错、目标不得产生、该槽位计入残留。
// 仅当本机明确无创建符号链接的权限/支持（EPERM、ENOSYS）时，才用只针对该精确路径的 lstat 替身覆盖同一 isSymbolicLink 分支，
// ENOTDIR 与无明确依据的 UNKNOWN 一律原样失败，不当作「无权限」；其余断言（错误文案逐字相等、目标不产生、残留路径点名、
// 链接目标不被改写）两种模式完全一致；替身必在 finally 归还，并打印本次实际执行模式。
test('staging slot swapped for a symlink during publish is refused and the link target stays untouched', async () => {
  const f = fixture();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(TEMP_ROOT, `${FIXTURE_PREFIX}outside-`)));
  let restore = null;
  try {
    const victim = path.join(outside, 'victim.csv');
    fs.writeFileSync(victim, 'do-not-touch');
    f.put('stage/one.csv', 'downloaded-payload');
    const slot = f.slot('out/one.csv');
    let mode = 'real-symlink';
    let evidence = null;
    const tamper = async ({ temporary }) => {
      assert.equal(temporary, slot);
      const before = fs.statSync(temporary);
      const vacated = vacate(temporary, '.original-object');
      try {
        fs.symlinkSync(victim, temporary);
        const after = fs.lstatSync(temporary);
        assertIdentityChanged(before, after, '暂存槽被换成符号链接');
        evidence = { before, after, vacated };
      } catch (error) {
        if (!['EPERM', 'ENOSYS'].includes(error?.code)) throw error; // 只有明确的无权限/不支持才允许走替身
        mode = 'lstat-substitute';
        console.log(`[mapped-staging] symlink 创建被系统拒绝（${error.code}），改用精确路径 lstat 替身`);
        fs.writeFileSync(temporary, 'downloaded-payload');
        const after = fs.statSync(temporary);
        assertIdentityChanged(before, after, '暂存槽被同名新文件替换后套 lstat 替身');
        const originalLstat = fs.promises.lstat;
        fs.promises.lstat = async (...args) => {
          const info = await originalLstat(...args);
          if (path.resolve(String(args[0])) !== path.resolve(temporary)) return info;
          return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { isSymbolicLink: () => true });
        };
        restore = () => { fs.promises.lstat = originalLstat; };
        evidence = { before, after, vacated };
      }
    };
    let failure;
    try {
      failure = await captureFailure(() => f.run([entry('out/one.csv')],
        [{ remotePath: REMOTE, localRelativePath: 'stage/one.csv' }], true, { beforeRename: tamper }));
    } finally { restore?.(); }
    console.log('[mapped-staging] symlink 用例实际执行方式: ' + mode);
    assert.ok(evidence, '钩子必须真实执行过替换');
    assert.ok(failure, '暂存文件被换成符号链接后必须抛错');
    assert.equal(failure.message, `${IDENTITY_GUARD}${slot}`, '错误必须是身份变化文案并逐字带上该暂存槽（即残留清单内容）');
    assert.equal(f.exists('out/one.csv'), false, '目标文件不得产生');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'do-not-touch', '链接目标内容不得被写入或截断');
    if (mode === 'real-symlink') {
      assert.equal(fs.lstatSync(slot).isSymbolicLink(), true, '保留下来的残留必须仍是那个符号链接本体');
      assert.deepEqual(listingUnder(f.stagingDir), [`${path.basename(slot)}@symlink`, `${path.basename(slot)}.original-object`].sort(),
        '暂存目录的精确列表必须是「符号链接槽位 + 让位的原对象」两项');
    } else {
      assert.equal(fs.existsSync(slot), true, '保留下来的残留槽位必须仍在');
      assert.deepEqual(listingUnder(f.stagingDir), [path.basename(slot), `${path.basename(slot)}.original-object`].sort(),
        '替身模式下暂存目录的精确列表必须是「槽位文件 + 让位的原对象」两项');
    }
  } finally {
    removeOwnFixture(f.root, FIXTURE_PREFIX);
    removeOwnFixture(outside, `${FIXTURE_PREFIX}outside-`);
  }
});

// 6) 一次多个目标里有一个失败：已交付目标不得被静默丢掉，失败目标的槽位必须留在暂存区并在错误里点名。
test('one failing destination does not silently lose the already delivered sibling and names its residue', async () => {
  const f = fixture();
  try {
    f.put('stage/one.csv', 'first-payload');
    const deliveredSlot = f.slot('out/one.csv');
    const failingSlot = f.slot('nested/two.csv');
    let evidence = null;
    const failure = await captureFailure(() => f.run([entry('out/one.csv'), entry('nested/two.csv')],
      [{ remotePath: REMOTE, localRelativePath: 'stage/one.csv' }], true, {
        beforeRename: ({ destination, temporary }) => {
          if (path.basename(destination) !== 'two.csv') return;
          const before = fs.statSync(temporary);
          const vacated = vacate(temporary, '.original-object');
          fs.writeFileSync(temporary, 'swapped');
          const after = fs.statSync(temporary);
          assertIdentityChanged(before, after, '第二个目标的暂存槽被同名新文件替换');
          assert.equal(fs.statSync(vacated).ino, before.ino, '原暂存对象必须原样保留（未被删除）');
          evidence = { before, after, vacated };
        },
      }));
    assert.ok(evidence, '钩子必须真实执行过第二个目标的替换');
    assert.ok(failure, '第二个目标被替换后必须抛错');
    assert.equal(failure.message, `${IDENTITY_GUARD}${failingSlot}`, '错误必须点名第二个目标的暂存槽，而不是第一个');
    assert.notEqual(failingSlot, deliveredSlot);
    assert.equal(f.read('out/one.csv'), 'first-payload', '已交付的第一个目标必须仍在且内容不变');
    assert.equal(f.exists('nested/two.csv'), false, '失败目标不得产生');
    assert.equal(fs.readFileSync(failingSlot, 'utf8'), 'swapped', '失败目标的残留槽位必须原样保留');
    assert.deepEqual(listingUnder(f.stagingDir), [path.basename(failingSlot), `${path.basename(failingSlot)}.original-object`].sort(),
      '暂存目录的精确列表必须只剩失败目标的「替换后槽位 + 让位的原对象」两项，已交付目标的槽位不得留下');
  } finally { removeOwnFixture(f.root, FIXTURE_PREFIX); }
});

// 7) 目标父目录被改名让位后同名新建（路径字符串完全一致，只有目录 dev/ino 变化）：必须拒绝发布并保留暂存，
// 否则发布结果会静默落进一个「同名但不同」的目录里。
test('renamed-away then recreated destination parent is rejected before publish and the scene is preserved', async () => {
  const f = fixture();
  try {
    f.put('stage/one.csv', 'downloaded-payload');
    const slot = f.slot('out/one.csv');
    const parentDir = path.join(f.root, 'out');
    const vacatedParent = path.join(f.root, 'out.vacated-parent');
    let evidence = null;
    const failure = await captureFailure(() => f.run([entry('out/one.csv')],
      [{ remotePath: REMOTE, localRelativePath: 'stage/one.csv' }], true, {
        beforeRename: ({ destination, temporary, root }) => {
          assert.equal(temporary, slot, '钩子收到的暂存槽必须是被校验的那个');
          assert.equal(destination, path.join(f.root, 'out', 'one.csv'), '钩子收到的目标必须与 entry 一致');
          assert.equal(root, f.root, '钩子收到的项目根必须与夹具根一致');
          const before = fs.statSync(parentDir);
          // 让位而非删除：原父目录整体改名挪开，其 dev/ino 与内容完整保留，随后在同名位置新建空目录。
          const vacated = vacate(parentDir, '.vacated-parent');
          fs.mkdirSync(parentDir);
          const after = fs.statSync(parentDir);
          assertIdentityChanged(before, after, '目标父目录被改名后同名重建');
          assert.equal(vacated, vacatedParent, '让位后的原父目录路径必须可预期');
          assert.equal(fs.statSync(vacated).ino, before.ino, '原父目录对象必须原样保留（未被删除）');
          assert.equal(fs.existsSync(slot), true, '暂存槽在父目录之外，父目录改名不得影响槽位本体');
          evidence = { before, after, vacated };
        },
      }));
    assert.ok(evidence, '钩子必须真实执行过父目录改名让位与同名重建');
    assert.ok(failure, '父目录被改名让位并同名重建后必须拒绝发布，不得静默落进新目录');
    assert.equal(failure.message, `${PARENT_GUARD}${slot}`, '错误必须逐字是父目录变化文案并带上暂存槽路径');
    assert.equal(f.exists('out/one.csv'), false, '同名新建目录里不得出现发布结果');
    assert.equal(fs.existsSync(slot), true, '暂存槽文件必须保留');
    assert.equal(fs.readFileSync(slot, 'utf8'), 'downloaded-payload', '保留的暂存内容必须完整等于已写入的字节');
    assert.deepEqual(listingUnder(f.stagingDir), [path.basename(slot)], '暂存目录的精确列表必须只有该槽位（未被回收也未被复制走）');
    assert.deepEqual(listingUnder(evidence.vacated), [], '让位的原父目录必须保持原样且不含发布结果');
  } finally { removeOwnFixture(f.root, FIXTURE_PREFIX); }
});

// 8) 清理合规自检：前面任何用例的夹具若没能按上述安全删除路径删掉，必须在这里显式失败并列出保留下来的路径。
test('every fixture created by this file was removed through the compliant cleanup path', () => {
  assert.deepEqual(retainedFixtures, [], `以下夹具未按安全删除路径清理，已原样保留：${retainedFixtures.join(' | ')}`);
});
