import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFileHandlerModule,
  createSpawnLauncher,
  type FileHandlerNativePort,
  type SpawnStart,
} from './fileHandlers.js';

const trustedSender = { kind: 'trusted-renderer' };
const untrustedSender = { kind: 'remote-renderer' };
const temporaryRoots: string[] = [];

async function makeHarness(internalExtensions: string[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'morrow-file-handler-'));
  temporaryRoots.push(root);
  const vaultRoot = path.join(root, 'vault');
  const userDataPath = path.join(root, 'profile');
  const filePath = path.join(vaultRoot, 'Work files', "Budget & forecast (Q4)'26.xlsx");
  const executablePath = path.join(root, 'Synthetic spreadsheet viewer.exe');
  await mkdir(path.dirname(filePath), { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(filePath, 'synthetic workbook');
  await writeFile(executablePath, 'synthetic executable');
  await chmod(executablePath, 0o700);
  const realVaultRoot = await realpath(vaultRoot);

  let vaultContext: { root: string; realRoot: string; generation: string | number } | null = {
    root: vaultRoot,
    realRoot: realVaultRoot,
    generation: 1,
  };
  const native: FileHandlerNativePort = {
    getCurrentVaultContext: vi.fn(() => vaultContext),
    isTrustedSender: vi.fn((sender) => sender === trustedSender),
    getInternalExtensions: vi.fn(() => internalExtensions),
    chooseApplication: vi.fn(async () => executablePath),
    isExecutableApplication: vi.fn(async () => true),
    openDefaultFile: vi.fn(async () => ''),
    openDefaultUrl: vi.fn(async () => undefined),
    revealInFolder: vi.fn(),
  };
  const startProcess = vi.fn<SpawnStart>(async () => undefined);
  const deviceIdA = 'a'.repeat(64);
  const createHandlers = (
    overrides: { userDataPath?: string; deviceId?: string; startProcess?: SpawnStart } = {},
  ) =>
    createFileHandlerModule({
      userDataPath: overrides.userDataPath ?? userDataPath,
      getDeviceIdentity: async () => overrides.deviceId ?? deviceIdA,
      native,
      launchApplication: createSpawnLauncher(overrides.startProcess ?? startProcess),
    });

  return {
    root,
    vaultRoot,
    realVaultRoot,
    userDataPath,
    filePath,
    executablePath,
    native,
    startProcess,
    createHandlers,
    setVaultContext(value: { root: string; realRoot: string; generation: string | number } | null) {
      vaultContext = value;
    },
  };
}

describe('file-handler launcher contract', () => {
  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('launches a chosen application with the validated file path as one argument', async () => {
    const harness = await makeHarness();
    const handlers = harness.createHandlers();

    await expect(handlers.setFileHandler(trustedSender, '.XLSX', 'application')).resolves.toMatchObject({
      ok: true,
    });
    expect(harness.native.chooseApplication).toHaveBeenCalledWith('file', '.xlsx', 'en');
    await expect(
      handlers.openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toMatchObject({ ok: true, destination: 'application' });

    expect(harness.startProcess).toHaveBeenCalledWith(harness.executablePath, [harness.filePath], {
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
  });

  it('rejects an untrusted sender before opening or launching a resource', async () => {
    const harness = await makeHarness();
    const handlers = harness.createHandlers();

    await expect(
      handlers.openFile(untrustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toMatchObject({
      ok: false,
      code: 'not-allowed',
    });

    expect(harness.native.getCurrentVaultContext).not.toHaveBeenCalled();
    expect(harness.native.chooseApplication).not.toHaveBeenCalled();
    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();
    expect(harness.startProcess).not.toHaveBeenCalled();
  });

  it('rejects traversal and symbolic links that leave the vault', async () => {
    const harness = await makeHarness();
    const outsidePath = path.join(harness.root, 'outside.xlsx');
    const linkPath = path.join(harness.vaultRoot, 'Work files', 'outside.xlsx');
    await writeFile(outsidePath, 'outside workbook');
    await symlink(outsidePath, linkPath);
    const handlers = harness.createHandlers();

    const traversal = await handlers.openFile(trustedSender, '../outside.xlsx');
    expect(traversal).toMatchObject({ ok: false, code: 'invalid-resource' });
    expect(traversal).not.toHaveProperty('recovery');
    const symlinkResult = await handlers.openFile(trustedSender, 'Work files/outside.xlsx');
    expect(symlinkResult).toMatchObject({ ok: false, code: 'invalid-resource' });
    expect(symlinkResult).not.toHaveProperty('recovery');

    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();
    expect(harness.startProcess).not.toHaveBeenCalled();
  });

  it('stores application choices in the local profile and exposes no executable path', async () => {
    const harness = await makeHarness();
    const first = harness.createHandlers();
    await expect(first.setFileHandler(trustedSender, '.xlsx', 'application')).resolves.toMatchObject({
      ok: true,
    });

    const restored = await harness.createHandlers().getPreferences(trustedSender);
    expect(restored).toEqual({
      ok: true,
      preferences: {
        files: { '.xlsx': { mode: 'application', applicationName: path.basename(harness.executablePath) } },
        browser: { mode: 'system' },
        internalExtensions: [],
      },
    });
    expect(await readdir(harness.vaultRoot)).toEqual(['Work files']);
    expect(await readdir(harness.userDataPath)).toContain('file-handlers.json');
  });

  it('requires application reselection when a profile is copied to a different device', async () => {
    const harness = await makeHarness();
    await harness.createHandlers().setFileHandler(trustedSender, '.xlsx', 'application');
    const copiedProfile = path.join(harness.root, 'profile-copy');
    await cp(harness.userDataPath, copiedProfile, { recursive: true });
    const startProcessOnDeviceB = vi.fn<SpawnStart>(async () => undefined);
    const handlersOnDeviceB = harness.createHandlers({
      userDataPath: copiedProfile,
      deviceId: 'b'.repeat(64),
      startProcess: startProcessOnDeviceB,
    });

    await expect(handlersOnDeviceB.getPreferences(trustedSender)).resolves.toMatchObject({
      ok: true,
      preferences: {
        files: { '.xlsx': { mode: 'application', needsReselection: true } },
      },
    });
    await expect(
      handlersOnDeviceB.openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toMatchObject({ ok: false, code: 'device-mismatch' });
    expect(startProcessOnDeviceB).not.toHaveBeenCalled();

    await handlersOnDeviceB.setFileHandler(trustedSender, '.xlsx', 'application');
    await expect(
      handlersOnDeviceB.openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toMatchObject({ ok: true, destination: 'application' });
    expect(startProcessOnDeviceB).toHaveBeenCalledWith(harness.executablePath, [harness.filePath], {
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
  });

  it('leaves preferences unchanged when native application selection is cancelled', async () => {
    const harness = await makeHarness();
    vi.mocked(harness.native.chooseApplication).mockResolvedValue(null);
    const handlers = harness.createHandlers();

    await expect(handlers.setFileHandler(trustedSender, '.xlsx', 'application')).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
    });
    await expect(handlers.getPreferences(trustedSender)).resolves.toMatchObject({
      ok: true,
      preferences: { files: {}, browser: { mode: 'system' }, internalExtensions: [] },
    });
    expect(await readdir(harness.userDataPath)).toEqual([]);
  });

  it('rejects an unsupported chooser locale before opening the native dialog', async () => {
    const harness = await makeHarness();
    const handlers = harness.createHandlers();

    await expect(handlers.setFileHandler(trustedSender, '.xlsx', 'application', 'fr')).resolves.toMatchObject(
      {
        ok: false,
        code: 'invalid-request',
      },
    );
    await expect(
      handlers.openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx", {
        chooseOnce: true,
        locale: 'fr',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-request' });
    expect(harness.native.chooseApplication).not.toHaveBeenCalled();
  });

  it('passes only the validated locale to the native chooser', async () => {
    const harness = await makeHarness();
    const handlers = harness.createHandlers();

    await expect(handlers.setFileHandler(trustedSender, '.xlsx', 'application', 'pt')).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    expect(harness.native.chooseApplication).toHaveBeenCalledWith('file', '.xlsx', 'pt');
  });

  it('reports a removed application with recovery actions without pretending it opened the file', async () => {
    const harness = await makeHarness();
    const handlers = harness.createHandlers();
    await handlers.setFileHandler(trustedSender, '.xlsx', 'application');
    await rm(harness.executablePath);

    await expect(
      handlers.openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toEqual({
      ok: false,
      code: 'application-missing',
      message: 'The selected application is no longer available.',
      recovery: ['choose-application', 'open-folder'],
    });
    expect(harness.startProcess).not.toHaveBeenCalled();
    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();
  });

  it('offers recovery when the system has no file association', async () => {
    const harness = await makeHarness();
    vi.mocked(harness.native.openDefaultFile).mockResolvedValue('No application associated');

    await expect(
      harness.createHandlers().openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toEqual({
      ok: false,
      code: 'no-association',
      message: 'No system application is available for this file type.',
      recovery: ['choose-application', 'open-folder'],
    });
    expect(harness.startProcess).not.toHaveBeenCalled();
  });

  it('delegates a valid file to the system and can restore that mode later', async () => {
    const harness = await makeHarness();
    const handlers = harness.createHandlers();

    await expect(
      handlers.openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toEqual({ ok: true, destination: 'system' });
    expect(harness.native.openDefaultFile).toHaveBeenCalledWith(harness.filePath);

    await handlers.setFileHandler(trustedSender, '.xlsx', 'application');
    await handlers.setFileHandler(trustedSender, '.XLSX', 'system');
    await expect(
      handlers.openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toEqual({ ok: true, destination: 'system' });
    expect(harness.native.openDefaultFile).toHaveBeenCalledTimes(2);
    expect(harness.startProcess).not.toHaveBeenCalled();
  });

  it('reports a process-start error and opens the folder only after a separate request', async () => {
    const harness = await makeHarness();
    harness.startProcess.mockRejectedValue(new Error('synthetic launch failure'));
    const handlers = harness.createHandlers();
    await handlers.setFileHandler(trustedSender, '.xlsx', 'application');

    await expect(
      handlers.openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toEqual({
      ok: false,
      code: 'launch-failed',
      message: 'The selected application could not open this file.',
      recovery: ['choose-application', 'open-folder'],
    });
    expect(harness.native.revealInFolder).not.toHaveBeenCalled();
    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();

    await expect(
      handlers.openContainingFolder(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toEqual({ ok: true });
    expect(harness.native.revealInFolder).toHaveBeenCalledWith(harness.filePath);
  });

  it('blocks active files and shortcuts from implicit system execution', async () => {
    const harness = await makeHarness();
    const executableResource = path.join(harness.vaultRoot, 'Work files', 'untrusted payload.exe');
    const shortcutResource = path.join(harness.vaultRoot, 'Work files', 'untrusted shortcut.lnk');
    await writeFile(executableResource, 'synthetic executable resource');
    await writeFile(shortcutResource, 'synthetic shortcut resource');
    const handlers = harness.createHandlers();

    await expect(handlers.openFile(trustedSender, 'Work files/untrusted payload.exe')).resolves.toMatchObject(
      {
        ok: false,
        code: 'active-content-blocked',
      },
    );
    await expect(
      handlers.openFile(trustedSender, 'Work files/untrusted shortcut.lnk'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'active-content-blocked',
    });
    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();
    expect(harness.startProcess).not.toHaveBeenCalled();

    await expect(
      handlers.openFile(trustedSender, 'Work files/untrusted payload.exe', { chooseOnce: true }),
    ).resolves.toMatchObject({ ok: true, destination: 'application' });
    expect(harness.startProcess).toHaveBeenCalledWith(harness.executablePath, [executableResource], {
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
  });

  it('allows internal opening only when a viewer capability is declared', async () => {
    const harness = await makeHarness(['.png']);
    const imagePath = path.join(harness.vaultRoot, 'Work files', 'synthetic image.png');
    await writeFile(imagePath, 'synthetic image');
    const handlers = harness.createHandlers();

    await expect(handlers.setFileHandler(trustedSender, '.PNG', 'internal')).resolves.toMatchObject({
      ok: true,
    });
    await expect(handlers.openFile(trustedSender, 'Work files/synthetic image.png')).resolves.toEqual({
      ok: true,
      destination: 'internal',
    });
    await expect(handlers.setFileHandler(trustedSender, '.xlsx', 'internal')).resolves.toMatchObject({
      ok: false,
      code: 'internal-viewer-unavailable',
    });
    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();
    expect(harness.startProcess).not.toHaveBeenCalled();
  });

  it('validates external URLs and sends a chosen browser only the URL argument', async () => {
    const harness = await makeHarness();
    const handlers = harness.createHandlers();

    for (const url of ['file:///private/data', 'javascript:alert(1)', 'https://user:pass@example.test/']) {
      await expect(handlers.openUrl(trustedSender, url)).resolves.toMatchObject({
        ok: false,
        code: 'invalid-url',
      });
    }
    expect(harness.native.openDefaultUrl).not.toHaveBeenCalled();

    await expect(handlers.openUrl(trustedSender, 'https://example.test/default-browser')).resolves.toEqual({
      ok: true,
      destination: 'system',
    });
    expect(harness.native.openDefaultUrl).toHaveBeenCalledWith('https://example.test/default-browser');

    await expect(handlers.setBrowserHandler(trustedSender, 'application')).resolves.toMatchObject({
      ok: true,
    });
    await expect(handlers.openUrl(trustedSender, 'https://example.test/search?q=one%20two')).resolves.toEqual(
      {
        ok: true,
        destination: 'application',
      },
    );
    expect(harness.startProcess).toHaveBeenCalledWith(
      harness.executablePath,
      ['https://example.test/search?q=one%20two'],
      { shell: false, detached: true, windowsHide: true, stdio: 'ignore' },
    );
  });

  it('does not persist a one-time browser choice', async () => {
    const harness = await makeHarness();
    const handlers = harness.createHandlers();

    await expect(
      handlers.openUrl(trustedSender, 'https://example.test/', { chooseOnce: true }),
    ).resolves.toMatchObject({
      ok: true,
      destination: 'application',
    });
    expect(harness.native.chooseApplication).toHaveBeenCalledWith('browser', null, 'en');
    await expect(handlers.getPreferences(trustedSender)).resolves.toMatchObject({
      ok: true,
      preferences: { browser: { mode: 'system' } },
    });
  });

  it('rechecks vault generation after the native chooser returns before launch', async () => {
    const harness = await makeHarness();
    vi.mocked(harness.native.chooseApplication).mockImplementation(async () => {
      harness.setVaultContext({ root: harness.vaultRoot, realRoot: harness.realVaultRoot, generation: 2 });
      return harness.executablePath;
    });

    await expect(
      harness.createHandlers().openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx", {
        chooseOnce: true,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'vault-changed' });
    expect(harness.startProcess).not.toHaveBeenCalled();
    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();
  });

  it('rechecks vault generation after resource validation before dispatch', async () => {
    const harness = await makeHarness();
    vi.mocked(harness.native.getCurrentVaultContext)
      .mockReturnValueOnce({ root: harness.vaultRoot, realRoot: harness.realVaultRoot, generation: 1 })
      .mockReturnValueOnce({ root: harness.vaultRoot, realRoot: harness.realVaultRoot, generation: 2 });

    await expect(
      harness.createHandlers().openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toMatchObject({ ok: false, code: 'vault-changed' });
    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();
    expect(harness.startProcess).not.toHaveBeenCalled();
  });

  it('rejects a root junction that changes the real vault without changing its generation', async () => {
    const harness = await makeHarness();
    const oldRootPath = path.join(harness.root, 'original-vault');
    const replacementRoot = path.join(harness.root, 'replacement-vault');
    await rename(harness.vaultRoot, oldRootPath);
    await mkdir(path.join(replacementRoot, 'Work files'), { recursive: true });
    await writeFile(
      path.join(replacementRoot, 'Work files', "Budget & forecast (Q4)'26.xlsx"),
      'replacement workbook',
    );
    await symlink(replacementRoot, harness.vaultRoot, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      harness.createHandlers().openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-resource' });
    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();
    expect(harness.startProcess).not.toHaveBeenCalled();
  });

  it('revalidates the vault file after the OS executable check before launching', async () => {
    const harness = await makeHarness();
    const outsidePath = path.join(harness.root, 'app-validation swap.xlsx');
    await writeFile(outsidePath, 'outside workbook');
    const handlers = harness.createHandlers();
    await handlers.setFileHandler(trustedSender, '.xlsx', 'application');
    vi.mocked(harness.native.isExecutableApplication).mockImplementationOnce(async () => {
      await rm(harness.filePath);
      await symlink(outsidePath, harness.filePath);
      return true;
    });

    await expect(
      handlers.openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx"),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-resource' });
    expect(harness.startProcess).not.toHaveBeenCalled();
    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();
  });

  it('revalidates the file after the native chooser in case its path became a link', async () => {
    const harness = await makeHarness();
    const outsidePath = path.join(harness.root, 'swapped outside.xlsx');
    await writeFile(outsidePath, 'outside workbook');
    vi.mocked(harness.native.chooseApplication).mockImplementation(async () => {
      await rm(harness.filePath);
      await symlink(outsidePath, harness.filePath);
      return harness.executablePath;
    });

    await expect(
      harness.createHandlers().openFile(trustedSender, "Work files/Budget & forecast (Q4)'26.xlsx", {
        chooseOnce: true,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-resource' });
    expect(harness.startProcess).not.toHaveBeenCalled();
    expect(harness.native.openDefaultFile).not.toHaveBeenCalled();
  });
});
