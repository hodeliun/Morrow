declare namespace startup {
  type StartupMode = 'development' | 'installed' | 'packaged-smoke';

  interface StartupInput {
    isPackaged: boolean;
    argv: readonly string[];
    env: Record<string, string | undefined>;
    appDataPath: string;
    tempDir: string;
  }

  interface StartupConfig {
    mode: StartupMode;
    userDataPath: string;
    sessionDataPath: string;
    hidden: boolean;
  }

  interface StatsLike {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }

  interface FileSystemApi {
    lstatSync(path: string): StatsLike;
    realpathSync(path: string): string;
    mkdirSync(path: string, options: { recursive: true }): unknown;
  }

  interface AppApi {
    setName(name: string): void;
    setPath(name: 'userData' | 'sessionData', path: string): void;
  }

  interface StartupDependencies {
    app: AppApi;
    fileSystem?: FileSystemApi;
  }

  function resolveStartupConfig(input: StartupInput): StartupConfig;

  function assertPackagedSmokeFilesystem(
    userDataPath: string,
    tempDir: string,
    fileSystem?: FileSystemApi,
  ): void;

  function initializeStartup(input: StartupInput, dependencies: StartupDependencies): StartupConfig;
}

export = startup;
