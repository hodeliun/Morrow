'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const runRoot = process.env.MORROW_STABILIZATION_RUN_DIR
  ? path.resolve(process.env.MORROW_STABILIZATION_RUN_DIR)
  : null;

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function runPath(relative, fallback) {
  if (!runRoot) return fallback;
  const target = path.resolve(runRoot, relative);
  if (!isWithin(runRoot, target)) throw new Error('Audit output must stay under the selected run directory.');
  return target;
}

function projectRelative(filePath) {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, '/');
}

function removeOwnedTempRoot(rootPath, prefix) {
  const absoluteRoot = path.resolve(rootPath);
  const stat = fs.lstatSync(absoluteRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Synthetic root is not a real directory.');
  if (!path.basename(absoluteRoot).startsWith(prefix)) throw new Error('Synthetic root name does not match its owner prefix.');

  const realRoot = fs.realpathSync(absoluteRoot);
  const realTemp = fs.realpathSync(os.tmpdir());
  const samePath = process.platform === 'win32'
    ? (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : (left, right) => path.resolve(left) === path.resolve(right);
  if (!samePath(path.dirname(realRoot), realTemp) || !samePath(realRoot, absoluteRoot))
    throw new Error('Synthetic root is not the exact direct child of the OS temp directory created by this run.');

  fs.rmSync(absoluteRoot, { recursive: true, force: false });
  return !fs.existsSync(absoluteRoot);
}

module.exports = { isWithin, projectRelative, removeOwnedTempRoot, runPath };
