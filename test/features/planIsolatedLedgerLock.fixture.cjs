// Real process fixture. No fs method interception or retired rename hook.
const fs = require('node:fs');
const [moduleFile, file, mode, batchId] = process.argv.slice(2);
const ledger = require(moduleFile);
const queued = new Set(), waiting = new Map();
const send = message => { if (process.connected) process.send({ ...message, pid: process.pid }); };
process.on('message', key => {
  const resolve = waiting.get(key);
  if (resolve) { waiting.delete(key); resolve(); } else queued.add(key);
});
const gate = key => queued.delete(key) ? Promise.resolve() : new Promise(resolve => waiting.set(key, resolve));
async function append(fence) {
  const batches = await ledger.loadIsolatedBatchLedger(file);
  batches.push({ batchId, projectRoot: '/fixture', frozenAt: new Date().toISOString(), plans: [] });
  await ledger.saveIsolatedBatchLedger(file, batches, fence);
}
(async () => {
  if (mode === 'stale-contender') {
    send({ event: 'observed', raw: fs.readFileSync(file + '.lock', 'utf8') });
    await gate('acquire');
  }
  await ledger.withIsolatedBatchLedger(file, async fence => {
    if (mode === 'unknown-expired-holder') {
      // The current owner keeps its token, but simulates an old/unknown expired
      // owner record. Missing PID/host and TTL must never authorize takeover.
      const owner = JSON.parse(fs.readFileSync(file + '.lock', 'utf8'));
      fs.writeFileSync(file + '.lock', JSON.stringify({ token: owner.token, expiresAt: new Date(0).toISOString() }));
    }
    send({ event: 'entered', raw: fs.readFileSync(file + '.lock', 'utf8') });
    if (['writer', 'stale-contender', 'contender'].includes(mode)) await append(fence);
    else if (mode === 'crash-holder') { await gate('crash'); process.exit(23); }
    else if (mode === 'fenced-writer') { await gate('write'); await append(fence); }
    else await gate('release');
  });
  send({ event: 'done' });
  process.disconnect();
})().catch(error => {
  send({ event: 'error', message: String(error.stack || error) });
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
