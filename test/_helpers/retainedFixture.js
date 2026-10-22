const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
// Real, retained filesystem inputs. Linux uses its native filesystem instead of
// the Windows 9p mount; Windows keeps the native project volume. No cleanup and
// no platform emulation. Each fixture remains discoverable from its receipt.
module.exports = function retainedFixture(root, label) {
  const parent = process.platform === 'linux'
    ? path.join(os.homedir(), '.codex', 'fixture-artifacts', 'simple-experiment')
    : path.join(root, 'release-artifacts');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, label + ' '));
  const receipts = path.join(root, 'release-artifacts', 'fixture-locations');
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(receipts, path.basename(directory) + '.json'),
    JSON.stringify({ directory, platform: process.platform }) + '\n', { flag: 'wx' });
  return directory;
};
