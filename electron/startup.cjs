const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'Morrow';
const SMOKE_SWITCH = '--smoke-test';
const SMOKE_ROOT_PATTERN = /^morrow-smoke-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function refusal(reason) {
  return new Error(`Morrow startup refused: ${reason}`);
}

function isSamePath(left, right) {
  let normalizedLeft = path.resolve(left);
  let normalizedRight = path.resolve(right);
  if (process.platform === 'win32') {
    normalizedLeft = normalizedLeft.toLowerCase();
    normalizedRight = normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function resolveSmokeProfilePaths(userDataPath, tempDir) {
  if (typeof tempDir !== 'string' || !path.isAbsolute(tempDir))
    throw refusal('the operating-system temporary directory must be absolute');
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath))
    throw refusal('MORROW_USER_DATA must be an absolute path');
  if (
    process.platform === 'win32' &&
    (userDataPath.startsWith('\\\\?\\') || userDataPath.startsWith('\\\\.\\'))
  ) {
    throw refusal('device namespace paths are not accepted for the smoke profile');
  }

  const root = path.parse(userDataPath).root;
  const rawSegments = userDataPath.slice(root.length).split(/[\\/]+/).filter(Boolean);
  if (rawSegments.some((segment) => segment === '.' || segment === '..'))
    throw refusal('dot segments are not accepted in the smoke profile path');

  const absoluteTempDir = path.resolve(tempDir);
  const absoluteUserDataPath = path.resolve(userDataPath);
  const relativePath = path.relative(absoluteTempDir, absoluteUserDataPath);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw refusal('MORROW_USER_DATA must be inside its dedicated temporary root');
  }

  const segments = relativePath.split(path.sep);
  const [rootName, profileName] = segments;
  if (
    segments.length !== 2 ||
    !SMOKE_ROOT_PATTERN.test(rootName ?? '') ||
    profileName !== 'profile'
  ) {
    throw refusal('MORROW_USER_DATA must be <tmp>/morrow-smoke-<id>/profile');
  }

  return {
    tempDir: absoluteTempDir,
    rootPath: path.join(absoluteTempDir, rootName),
    profilePath: path.join(absoluteTempDir, rootName, 'profile'),
  };
}

function resolveStartupConfig({ isPackaged, argv, env, appDataPath, tempDir }) {
  if (!isPackaged) {
    const userDataPath = env.MORROW_USER_DATA
      ? path.resolve(env.MORROW_USER_DATA)
      : path.join(appDataPath, APP_NAME);
    return {
      mode: 'development',
      userDataPath,
      sessionDataPath: path.join(userDataPath, 'Session'),
      hidden: env.MORROW_HIDDEN === '1',
    };
  }

  const smokeArguments = argv.filter((argument) => argument.startsWith(SMOKE_SWITCH));
  const smokeEnvironmentPresent =
    env.MORROW_HIDDEN !== undefined || env.MORROW_USER_DATA !== undefined;
  const smokeRequested = smokeArguments.length > 0 || smokeEnvironmentPresent;

  if (!smokeRequested) {
    const userDataPath = path.join(appDataPath, APP_NAME);
    return {
      mode: 'installed',
      userDataPath,
      sessionDataPath: path.join(userDataPath, 'Session'),
      hidden: false,
    };
  }

  if (
    smokeArguments.length !== 1 ||
    smokeArguments[0] !== SMOKE_SWITCH ||
    env.MORROW_HIDDEN !== '1' ||
    !env.MORROW_USER_DATA
  ) {
    throw refusal('packaged smoke mode requires --smoke-test, MORROW_HIDDEN=1, and MORROW_USER_DATA');
  }

  const paths = resolveSmokeProfilePaths(env.MORROW_USER_DATA, tempDir);
  return {
    mode: 'packaged-smoke',
    userDataPath: paths.profilePath,
    sessionDataPath: path.join(paths.profilePath, 'Session'),
    hidden: true,
  };
}

function readDirectory(fileSystem, directory, expectedPath, label, required) {
  let stats;
  try {
    stats = fileSystem.lstatSync(directory);
  } catch (error) {
    if (!required && error && error.code === 'ENOENT') return null;
    throw refusal(`${label} is missing or cannot be inspected`);
  }

  if (stats.isSymbolicLink()) throw refusal(`${label} cannot be a symlink or junction`);
  if (!stats.isDirectory()) throw refusal(`${label} must be a directory`);

  let realPath;
  try {
    realPath = fileSystem.realpathSync(directory);
  } catch {
    throw refusal(`${label} cannot be resolved on the filesystem`);
  }
  if (!isSamePath(realPath, expectedPath)) throw refusal(`${label} resolves outside its expected path`);
  return realPath;
}

function assertPackagedSmokeFilesystem(userDataPath, tempDir, fileSystem = fs) {
  const paths = resolveSmokeProfilePaths(userDataPath, tempDir);
  const tempRealPath = readDirectory(fileSystem, paths.tempDir, paths.tempDir, 'temporary directory', true);
  const rootName = path.basename(paths.rootPath);
  const expectedRoot = path.join(tempRealPath, rootName);
  const rootRealPath = readDirectory(fileSystem, paths.rootPath, expectedRoot, 'smoke root', true);
  const expectedProfile = path.join(rootRealPath, 'profile');
  const profileRealPath = readDirectory(
    fileSystem,
    paths.profilePath,
    expectedProfile,
    'smoke profile',
    true,
  );
  const sessionDataPath = path.join(paths.profilePath, 'Session');
  readDirectory(
    fileSystem,
    sessionDataPath,
    path.join(profileRealPath, 'Session'),
    'session profile',
    false,
  );
}

function initializeStartup(input, { app, fileSystem = fs }) {
  const startup = resolveStartupConfig(input);
  if (startup.mode === 'packaged-smoke')
    assertPackagedSmokeFilesystem(startup.userDataPath, input.tempDir, fileSystem);

  fileSystem.mkdirSync(startup.userDataPath, { recursive: true });
  fileSystem.mkdirSync(startup.sessionDataPath, { recursive: true });
  app.setName(APP_NAME);
  app.setPath('userData', startup.userDataPath);
  app.setPath('sessionData', startup.sessionDataPath);
  return startup;
}

module.exports = {
  assertPackagedSmokeFilesystem,
  initializeStartup,
  resolveStartupConfig,
};
