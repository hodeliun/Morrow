'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { TextDecoder } = require('node:util');

const ASAR_PACKAGE = '@electron/asar';
const ASAR_VERSION = '3.4.1';
const MAIN_ENTRY = 'dist-electron/main.cjs';
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAIN_GUARD_MARKERS = [
  '--smoke-test',
  'packaged smoke mode requires',
  'MORROW_HIDDEN',
  'MORROW_USER_DATA',
];

function reject(reason) {
  throw new Error(`Packaged smoke preflight refused the candidate: ${reason}`);
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isWithinPath(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function inspectPath(candidate, label, kind) {
  const absolutePath = path.resolve(candidate);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    reject(`${label} is missing or unreadable.`);
  }
  if (stat.isSymbolicLink()) reject(`${label} may not be a symbolic link or junction.`);
  if (kind === 'file' && !stat.isFile()) reject(`${label} must be a regular file.`);
  if (kind === 'directory' && !stat.isDirectory()) reject(`${label} must be a regular directory.`);

  let realPath;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    reject(`${label} could not be resolved safely.`);
  }
  if (!samePath(absolutePath, realPath)) reject(`${label} resolves through a link or junction.`);
  return { absolutePath, realPath, stat };
}

function readRegularFile(candidate, label) {
  const inspected = inspectPath(candidate, label, 'file');
  try {
    return fs.readFileSync(inspected.realPath);
  } catch {
    reject(`${label} could not be read.`);
  }
}

function parseJson(buffer, label) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject(`${label} must be a JSON object.`);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Packaged smoke preflight refused')) throw error;
    reject(`${label} is malformed.`);
  }
}

function findPackageRoot(modulePath) {
  let current = path.dirname(modulePath);
  while (true) {
    const packagePath = path.join(current, 'package.json');
    if (fs.existsSync(packagePath)) {
      const metadata = parseJson(readRegularFile(packagePath, 'The ASAR reader package metadata'), 'ASAR reader metadata');
      if (metadata.name === ASAR_PACKAGE) return { packageRoot: current, metadata };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  reject('the ASAR reader package metadata is unavailable.');
}

function loadAsarReader(projectRoot) {
  const root = inspectPath(projectRoot, 'The trusted project root', 'directory');
  const nodeModules = inspectPath(path.join(root.realPath, 'node_modules'), 'The project dependency directory', 'directory');
  const projectRequire = createRequire(path.join(root.realPath, '__packaged-smoke-preflight__.cjs'));

  let modulePath;
  try {
    modulePath = projectRequire.resolve(ASAR_PACKAGE);
  } catch {
    reject('the pinned ASAR reader module is unavailable.');
  }
  const resolvedModule = inspectPath(modulePath, 'The ASAR reader module entry', 'file');
  if (!isWithinPath(nodeModules.realPath, resolvedModule.realPath))
    reject('the ASAR reader module resolves outside this project’s dependencies.');

  const { packageRoot, metadata } = findPackageRoot(resolvedModule.realPath);
  const resolvedPackageRoot = inspectPath(packageRoot, 'The ASAR reader package directory', 'directory');
  if (!isWithinPath(nodeModules.realPath, resolvedPackageRoot.realPath))
    reject('the ASAR reader package resolves outside this project’s dependencies.');
  if (metadata.version !== ASAR_VERSION) reject(`the ASAR reader version must be ${ASAR_VERSION}.`);

  let api;
  try {
    api = projectRequire(ASAR_PACKAGE);
  } catch {
    reject('the pinned ASAR reader module could not be loaded.');
  }
  const reader = { version: metadata.version, statFile: api?.statFile, extractFile: api?.extractFile };
  validateAsarReader(reader);
  return reader;
}

function validateAsarReader(reader) {
  if (!reader || typeof reader !== 'object') reject('the ASAR reader module is missing.');
  if (reader.version !== ASAR_VERSION) reject(`the ASAR reader version must be ${ASAR_VERSION}.`);
  if (typeof reader.statFile !== 'function' || typeof reader.extractFile !== 'function')
    reject('the ASAR reader does not expose the required safe inspection functions.');
}

function readAsarFile(reader, archivePath, entryPath, label, maxBytes) {
  let metadata;
  try {
    metadata = reader.statFile(archivePath, entryPath, false);
  } catch {
    reject(`${label} is missing or malformed in app.asar.`);
  }
  if (!metadata || typeof metadata !== 'object' || 'link' in metadata)
    reject(`${label} must be a regular ASAR entry, not a link.`);
  if (metadata.unpacked === true) reject(`${label} must be stored inside app.asar.`);
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes)
    reject(`${label} has invalid or oversized ASAR metadata.`);

  let contents;
  try {
    contents = reader.extractFile(archivePath, entryPath, false);
  } catch {
    reject(`${label} could not be extracted safely from app.asar.`);
  }
  if (!Buffer.isBuffer(contents) || contents.length !== metadata.size)
    reject(`${label} has inconsistent ASAR contents.`);
  return contents;
}

function normalizeAsarEntry(entry, label) {
  if (typeof entry !== 'string' || !entry || entry.includes('\\') || entry.includes('\0'))
    reject(`${label} must be a relative ASAR path.`);
  if (path.posix.isAbsolute(entry) || entry.includes(':')) reject(`${label} may not be absolute or drive-qualified.`);
  const segments = entry.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'))
    reject(`${label} contains a redirected ASAR path.`);
  if (path.posix.normalize(entry) !== entry) reject(`${label} is not a normalized ASAR path.`);
  return entry;
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function assertSmokeGuard(contents, label) {
  const source = contents.toString('utf8');
  const missing = MAIN_GUARD_MARKERS.filter((marker) => !source.includes(marker));
  if (missing.length > 0) reject(`${label} is missing the packaged smoke isolation guard.`);
}

function preflightPackagedArtifact({ executablePath, expectedVersion, projectRoot }, dependencies = {}) {
  if (typeof expectedVersion !== 'string' || !expectedVersion)
    reject('an expected application version is required.');
  const trustedRoot = inspectPath(projectRoot, 'The trusted project root', 'directory');
  const trustedPackagePath = path.join(trustedRoot.realPath, 'package.json');
  const trustedPackage = parseJson(readRegularFile(trustedPackagePath, 'The trusted project package metadata'), 'Trusted project metadata');
  if (trustedPackage.version !== expectedVersion)
    reject('the expected version does not match the trusted project version.');
  if (trustedPackage.main !== MAIN_ENTRY) reject('the trusted project main entry is not the configured smoke main.');

  const executable = inspectPath(executablePath, 'The packaged executable', 'file');
  if (path.basename(executable.absolutePath).toLowerCase() !== 'morrow.exe')
    reject('the executable must be named Morrow.exe.');
  const winUnpacked = inspectPath(path.dirname(executable.absolutePath), 'The win-unpacked directory', 'directory');
  if (path.basename(winUnpacked.absolutePath).toLowerCase() !== 'win-unpacked')
    reject('Morrow.exe must be directly inside win-unpacked.');
  if (!isWithinPath(winUnpacked.realPath, executable.realPath))
    reject('the executable resolves outside win-unpacked.');

  const resources = inspectPath(path.join(winUnpacked.realPath, 'resources'), 'The packaged resources directory', 'directory');
  if (!isWithinPath(winUnpacked.realPath, resources.realPath))
    reject('the resources directory resolves outside win-unpacked.');
  const archive = inspectPath(path.join(resources.realPath, 'app.asar'), 'The packaged app.asar archive', 'file');
  if (!isWithinPath(resources.realPath, archive.realPath))
    reject('app.asar resolves outside the packaged resources directory.');

  const trustedBuild = inspectPath(path.join(trustedRoot.realPath, 'dist-electron'), 'The trusted build directory', 'directory');
  const trustedMain = inspectPath(path.join(trustedBuild.realPath, MAIN_ENTRY.slice('dist-electron/'.length)), 'The trusted main entry', 'file');
  if (!isWithinPath(trustedRoot.realPath, trustedBuild.realPath) || !isWithinPath(trustedBuild.realPath, trustedMain.realPath))
    reject('the trusted main entry resolves outside the repository build.');

  const trustedMainBytes = readRegularFile(trustedMain.realPath, 'The trusted main entry');
  assertSmokeGuard(trustedMainBytes, 'The trusted main entry');
  const trustedMainSha256 = sha256(trustedMainBytes);

  const reader = dependencies.asarReader === undefined ? loadAsarReader(trustedRoot.realPath) : dependencies.asarReader;
  validateAsarReader(reader);
  const archivePackageBytes = readAsarFile(
    reader,
    archive.realPath,
    'package.json',
    'The packaged package.json',
    MAX_PACKAGE_JSON_BYTES,
  );
  const archivePackage = parseJson(archivePackageBytes, 'Packaged application metadata');
  if (archivePackage.version !== expectedVersion) reject('the app.asar version does not match the expected version.');
  const mainEntry = normalizeAsarEntry(archivePackage.main, 'The packaged main entry');
  if (mainEntry !== MAIN_ENTRY) reject('the app.asar main entry does not match the trusted project main.');

  const packagedMainBytes = readAsarFile(
    reader,
    archive.realPath,
    mainEntry,
    'The packaged main entry',
    trustedMainBytes.length,
  );
  assertSmokeGuard(packagedMainBytes, 'The packaged main entry');
  const packagedMainSha256 = sha256(packagedMainBytes);
  if (packagedMainSha256 !== trustedMainSha256)
    reject('the packaged main entry does not match the trusted dist-electron/main.cjs.');

  return {
    expectedVersion,
    packagedVersion: archivePackage.version,
    mainEntry,
    asarReaderVersion: reader.version,
    sha256: {
      executable: sha256(readRegularFile(executable.realPath, 'The packaged executable')),
      appAsar: sha256(readRegularFile(archive.realPath, 'The packaged app.asar archive')),
      main: packagedMainSha256,
      trustedMain: trustedMainSha256,
    },
  };
}

module.exports = { loadAsarReader, preflightPackagedArtifact };
