import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import startup from './startup.cjs';

const temporaryRoots: string[] = [];
const appDataPath = path.join(os.tmpdir(), 'morrow-startup-appdata');
type StartupInput = Parameters<typeof startup.resolveStartupConfig>[0];

function packagedInput(overrides: Partial<StartupInput> = {}): StartupInput {
  return {
    isPackaged: true,
    argv: ['Morrow.exe'],
    env: {} as Record<string, string | undefined>,
    appDataPath,
    tempDir: os.tmpdir(),
    ...overrides,
  };
}

function makeSmokeProfile() {
  const rootPath = mkdtempSync(path.join(os.tmpdir(), 'morrow-smoke-issue50-'));
  temporaryRoots.push(rootPath);
  const userDataPath = path.join(rootPath, 'profile');
  mkdirSync(userDataPath);
  return { rootPath, userDataPath };
}

function directoryLink(target: string, linkPath: string) {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function startupEffects() {
  const effects: string[] = [];
  const fileSystem = {
    lstatSync: vi.fn((location: string) => lstatSync(location)),
    realpathSync: vi.fn((location: string) => realpathSync(location)),
    mkdirSync: vi.fn((location: string, options: { recursive: true }) => {
      effects.push(`mkdir:${location}`);
      return mkdirSync(location, options);
    }),
  };
  const app = {
    setName: vi.fn((name: string) => effects.push(`setName:${name}`)),
    setPath: vi.fn((name: string, location: string) => effects.push(`setPath:${name}:${location}`)),
  };
  return { app, effects, fileSystem };
}

afterEach(() => {
  for (const rootPath of temporaryRoots.splice(0))
    rmSync(rootPath, { recursive: true, force: true });
});

describe('packaged startup resolution', () => {
  it('keeps the normal packaged profile and visible mode unchanged', () => {
    expect(startup.resolveStartupConfig(packagedInput())).toEqual({
      mode: 'installed',
      userDataPath: path.join(appDataPath, 'Morrow'),
      sessionDataPath: path.join(appDataPath, 'Morrow', 'Session'),
      hidden: false,
    });
  });

  it('preserves the existing development profile and hidden flags', () => {
    const config = startup.resolveStartupConfig({
      ...packagedInput(),
      isPackaged: false,
      env: { MORROW_USER_DATA: 'relative-profile', MORROW_HIDDEN: '1' },
    });

    expect(config).toEqual({
      mode: 'development',
      userDataPath: path.resolve('relative-profile'),
      sessionDataPath: path.join(path.resolve('relative-profile'), 'Session'),
      hidden: true,
    });
  });

  it('accepts packaged smoke mode only with the explicit flag and both opt-ins', () => {
    const { userDataPath } = makeSmokeProfile();
    const config = startup.resolveStartupConfig(
      packagedInput({
        argv: ['Morrow.exe', '--smoke-test'],
        env: { MORROW_HIDDEN: '1', MORROW_USER_DATA: userDataPath },
      }),
    );

    expect(config).toEqual({
      mode: 'packaged-smoke',
      userDataPath,
      sessionDataPath: path.join(userDataPath, 'Session'),
      hidden: true,
    });
  });

  it.each([
    { name: 'flag without profile opt-in', argv: ['Morrow.exe', '--smoke-test'], env: { MORROW_HIDDEN: '1' } },
    {
      name: 'profile variables without flag',
      argv: ['Morrow.exe'],
      env: { MORROW_HIDDEN: '1', MORROW_USER_DATA: 'x' },
    },
    {
      name: 'profile without hidden opt-in',
      argv: ['Morrow.exe', '--smoke-test'],
      env: { MORROW_USER_DATA: 'x' },
    },
    {
      name: 'non-hidden mode',
      argv: ['Morrow.exe', '--smoke-test'],
      env: { MORROW_HIDDEN: '0', MORROW_USER_DATA: 'x' },
    },
    {
      name: 'malformed flag',
      argv: ['Morrow.exe', '--smoke-test=1'],
      env: { MORROW_HIDDEN: '1', MORROW_USER_DATA: 'x' },
    },
    {
      name: 'relative profile',
      argv: ['Morrow.exe', '--smoke-test'],
      env: { MORROW_HIDDEN: '1', MORROW_USER_DATA: 'relative/profile' },
    },
  ])('rejects incomplete or invalid configuration: $name', ({ argv, env }) => {
    expect(() => startup.resolveStartupConfig(packagedInput({ argv, env }))).toThrow(
      /Morrow startup refused/,
    );
  });

  it('rejects escapes and sibling-prefix paths by path segments', () => {
    const tempDir = path.join(os.tmpdir(), 'morrow-smoke-boundary');
    const sibling = `${tempDir}-sibling`;

    expect(() =>
      startup.resolveStartupConfig(
        packagedInput({
          tempDir,
          argv: ['Morrow.exe', '--smoke-test'],
          env: { MORROW_HIDDEN: '1', MORROW_USER_DATA: path.join(sibling, 'morrow-smoke-id', 'profile') },
        }),
      ),
    ).toThrow(/dedicated temporary root/);
  });

  it('rejects dot-segment paths even when they normalize back under the temporary directory', () => {
    const pathWithDotSegment = `${os.tmpdir()}${path.sep}morrow-smoke-first${path.sep}..${path.sep}morrow-smoke-second${path.sep}profile`;

    expect(() =>
      startup.resolveStartupConfig(
        packagedInput({
          argv: ['Morrow.exe', '--smoke-test'],
          env: { MORROW_HIDDEN: '1', MORROW_USER_DATA: pathWithDotSegment },
        }),
      ),
    ).toThrow(/dot segments/);
  });
});

describe('packaged smoke filesystem guard', () => {
  it('accepts a real dedicated root, profile and existing session directory', () => {
    const { userDataPath } = makeSmokeProfile();
    mkdirSync(path.join(userDataPath, 'Session'));

    expect(() =>
      startup.assertPackagedSmokeFilesystem(userDataPath, os.tmpdir()),
    ).not.toThrow();
  });

  it('rejects a symlinked profile before any write or app path configuration', () => {
    const { rootPath, userDataPath } = makeSmokeProfile();
    rmSync(userDataPath, { recursive: true, force: true });
    const target = path.join(rootPath, 'profile-target');
    mkdirSync(target);
    directoryLink(target, userDataPath);

    const calls = startupEffects();
    const input = packagedInput({
      argv: ['Morrow.exe', '--smoke-test'],
      env: { MORROW_HIDDEN: '1', MORROW_USER_DATA: userDataPath },
    });

    expect(() => startup.initializeStartup(input, calls)).toThrow(/symlink or junction/);
    expect(calls.effects).toEqual([]);
  });

  it('rejects a symlinked session directory before any write or app path configuration', () => {
    const { rootPath, userDataPath } = makeSmokeProfile();
    const target = path.join(rootPath, 'session-target');
    mkdirSync(target);
    directoryLink(target, path.join(userDataPath, 'Session'));

    const calls = startupEffects();
    const input = packagedInput({
      argv: ['Morrow.exe', '--smoke-test'],
      env: { MORROW_HIDDEN: '1', MORROW_USER_DATA: userDataPath },
    });

    expect(() => startup.initializeStartup(input, calls)).toThrow(/symlink or junction/);
    expect(calls.effects).toEqual([]);
  });

  it('rejects a symlinked temporary root', () => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rootPath = path.join(os.tmpdir(), `morrow-smoke-link-${id}`);
    const targetRoot = path.join(os.tmpdir(), `morrow-smoke-target-${id}`);
    temporaryRoots.push(rootPath, targetRoot);
    mkdirSync(targetRoot);
    mkdirSync(path.join(targetRoot, 'profile'));
    directoryLink(targetRoot, rootPath);

    expect(() =>
      startup.assertPackagedSmokeFilesystem(path.join(rootPath, 'profile'), os.tmpdir()),
    ).toThrow(/symlink or junction/);
  });

  it('fails invalid startup before filesystem writes, path setup, lock or window continuation', () => {
    const calls = startupEffects();
    const input = packagedInput({
      argv: ['Morrow.exe', '--smoke-test'],
      env: { MORROW_HIDDEN: '1', MORROW_USER_DATA: 'relative-profile' },
    });
    const reached: string[] = [];
    const start = () => {
      startup.initializeStartup(input, calls);
      reached.push('requestSingleInstanceLock');
      reached.push('createWindow');
    };

    expect(start).toThrow(/MORROW_USER_DATA must be an absolute path/);
    expect(calls.effects).toEqual([]);
    expect(reached).toEqual([]);
    expect(calls.fileSystem.lstatSync).not.toHaveBeenCalled();
    expect(calls.fileSystem.realpathSync).not.toHaveBeenCalled();
  });

  it('configures test paths before returning to the single-instance-lock caller', () => {
    const { userDataPath } = makeSmokeProfile();
    const calls = startupEffects();
    const input = packagedInput({
      argv: ['Morrow.exe', '--smoke-test'],
      env: { MORROW_HIDDEN: '1', MORROW_USER_DATA: userDataPath },
    });

    const config = startup.initializeStartup(input, calls);
    calls.effects.push('requestSingleInstanceLock');

    expect(config.mode).toBe('packaged-smoke');
    expect(calls.effects).toEqual([
      `mkdir:${userDataPath}`,
      `mkdir:${path.join(userDataPath, 'Session')}`,
      'setName:Morrow',
      `setPath:userData:${userDataPath}`,
      `setPath:sessionData:${path.join(userDataPath, 'Session')}`,
      'requestSingleInstanceLock',
    ]);
  });
});
