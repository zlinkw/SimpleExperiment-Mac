const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const moduleFile = path.resolve(__dirname, '../../dist/features/PlanIsolatedBatchLedger.js');
const ledger = require(moduleFile);
const fixture = path.join(__dirname, 'planIsolatedLedgerLock.fixture.cjs');

function seed() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'se-ledger-lock-gate-'));
  const file = path.join(directory, 'ledger.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, batches: [{ batchId: 'seed', projectRoot: '/fixture', frozenAt: '2026-10-22T00:00:00Z', plans: [] }] }));
  return file;
}
function spawn(t, file, mode, batchId = mode) {
  const child = fork(fixture, [moduleFile, file, mode, batchId], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const events = [], listeners = new Set();
  let output = '', exited = false;
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  child.on('message', message => { events.push(message); for (const listener of [...listeners]) listener(message); });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    exited = true; resolve({ code, signal }); for (const listener of [...listeners]) listener({ event: 'closed' });
  }));
  const send = message => { if (child.connected) child.send(message, () => {}); };
  function wait(event) {
    const found = events.find(message => message.event === event);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(Error('IPC timeout: ' + event + ' ' + output)), 2000);
      function finish(error, message) { clearTimeout(timer); listeners.delete(receive); error ? reject(error) : resolve(message); }
      function receive(message) {
        if (message.event === event) finish(undefined, message);
        else if (message.event === 'error' || message.event === 'closed') finish(Error(message.message || 'Child closed before ' + event + ': ' + output));
      }
      listeners.add(receive);
      const error = events.find(message => message.event === 'error');
      if (error || exited) receive(error || { event: 'closed' });
    });
  }
  t.after(async () => {
    if (exited) return;
    send('release'); send('crash'); send('write'); send('acquire');
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 800); })]);
    clearTimeout(timer);
    if (!exited) { child.kill('SIGTERM'); await closed; } // Only this fixture's own child.
  });
  return { child, events, closed, send, wait };
}

test('r17-7 migrated: a stale observer and a third real contender cannot remove the later owner or write its ledger', async t => {
  const file = seed(), first = spawn(t, file, 'holder', 'first');
  const old = await first.wait('entered');
  const stale = spawn(t, file, 'stale-contender', 'forbidden-stale');
  assert.equal((await stale.wait('observed')).raw, old.raw);
  first.send('release'); await first.wait('done');
  assert.deepEqual(await first.closed, { code: 0, signal: null });
  const owner = spawn(t, file, 'unknown-expired-holder', 'owner'), current = await owner.wait('entered');
  assert.notEqual(JSON.parse(current.raw).token, JSON.parse(old.raw).token);
  const before = fs.readFileSync(file, 'utf8');
  const third = spawn(t, file, 'contender', 'forbidden-third');
  stale.send('acquire');
  const [staleError, thirdError] = await Promise.all([stale.wait('error'), third.wait('error')]);
  assert.match(staleError.message, /ISOLATED_BATCH_LEDGER_LOCKED/);
  assert.match(thirdError.message, /ISOLATED_BATCH_LEDGER_LOCKED/);
  assert.equal(stale.events.some(event => event.event === 'entered'), false);
  assert.equal(third.events.some(event => event.event === 'entered'), false);
  assert.equal(new Set([stale.child.pid, owner.child.pid, third.child.pid]).size, 3);
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), current.raw, 'Live owner bytes must never be removed/replaced by contenders');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'Contenders must not publish ledger writes');
  owner.send('release'); await owner.wait('done'); await owner.closed;
  const writer = spawn(t, file, 'writer', 'after-release');
  await writer.wait('done'); assert.deepEqual(await writer.closed, { code: 0, signal: null });
  assert.deepEqual((await ledger.loadIsolatedBatchLedger(file)).map(row => row.batchId), ['seed', 'after-release']);
  assert.equal(fs.existsSync(file + '.lock'), false);
  t.diagnostic(JSON.stringify({ stalePid: stale.child.pid, ownerPid: owner.child.pid, thirdPid: third.child.pid, file }));
});

test('an owner crash leaves the exact orphan lock and ledger intact; a later real process fails closed', async t => {
  const file = seed(), owner = spawn(t, file, 'crash-holder');
  const current = await owner.wait('entered'), before = fs.readFileSync(file, 'utf8');
  owner.send('crash'); assert.deepEqual(await owner.closed, { code: 23, signal: null });
  const contender = spawn(t, file, 'contender', 'forbidden-after-crash');
  assert.match((await contender.wait('error')).message, /ISOLATED_BATCH_LEDGER_LOCKED/);
  assert.equal(contender.events.some(event => event.event === 'entered'), false);
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), current.raw);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('releasing a lost owner never removes foreign token bytes', async t => {
  const file = seed(), owner = spawn(t, file, 'holder');
  await owner.wait('entered'); const before = fs.readFileSync(file, 'utf8');
  const foreign = JSON.stringify({ token: 'foreign', expiresAt: new Date(0).toISOString() });
  fs.writeFileSync(file + '.lock', foreign); owner.send('release');
  assert.match((await owner.wait('error')).message, /ISOLATED_BATCH_LEDGER_LOCK_LOST/);
  await owner.closed;
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), foreign);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a lost writer cannot publish its staged bytes and cannot release the foreign lock', async t => {
  const file = seed(), owner = spawn(t, file, 'fenced-writer', 'forbidden-write');
  await owner.wait('entered'); const before = fs.readFileSync(file, 'utf8');
  const foreign = JSON.stringify({ token: 'foreign-writer' });
  fs.writeFileSync(file + '.lock', foreign); owner.send('write');
  assert.match((await owner.wait('error')).message, /ISOLATED_BATCH_LEDGER_LOCK_LOST/);
  await owner.closed;
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), foreign);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual((await ledger.loadIsolatedBatchLedger(file)).map(row => row.batchId), ['seed']);
});
