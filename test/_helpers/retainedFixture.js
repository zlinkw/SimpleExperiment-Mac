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
  // Mac/Linux 适配：仓库内 release-artifacts/fixture-locations 在本沙箱由 root 持有不可写，
  // Linux 侧收据写入同一 home 工件树，保持“每个 fixture 可从收据发现”的契约；Windows 路径不变。
  const receipts = process.platform === 'linux'
    ? path.join(parent, 'fixture-locations')
    : path.join(root, 'release-artifacts', 'fixture-locations');
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(receipts, path.basename(directory) + '.json'),
    JSON.stringify({ directory, platform: process.platform }) + '\n', { flag: 'wx' });
  return directory;
};
