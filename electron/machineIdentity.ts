import { execFile as nodeExecFile } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';

const MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const;
const QUERY_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const UUID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const ALL_ZERO_UUID = /^0+$/;

export interface MachineIdentityExecOptions {
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
  shell: false;
}

export type MachineIdentityExecFile = (
  file: string,
  args: string[],
  options: MachineIdentityExecOptions,
) => Promise<string>;

export type MachineIdentityReadFile = (file: string) => Promise<string>;

export interface MachineIdentityDependencies {
  platform?: string;
  systemRoot?: string;
  execFile?: MachineIdentityExecFile;
  readFile?: MachineIdentityReadFile;
}

const EXEC_OPTIONS: MachineIdentityExecOptions = {
  encoding: 'utf8',
  timeout: QUERY_TIMEOUT_MS,
  maxBuffer: MAX_OUTPUT_BYTES,
  windowsHide: true,
  shell: false,
};

function executeFile(file: string, args: string[], options: MachineIdentityExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, options as ExecFileOptionsWithStringEncoding, (error, stdout) => {
      if (error) {
        reject(new Error('The operating system machine identifier could not be read.'));
        return;
      }
      resolve(stdout);
    });
  });
}

function normalizeUuid(value: string): string | null {
  const trimmed = value.trim();
  if (!UUID.test(trimmed)) return null;
  const compact = trimmed.replaceAll('-', '').toLowerCase();
  if (ALL_ZERO_UUID.test(compact)) return null;
  return compact;
}

function parseWindowsMachineGuid(output: string): string | null {
  const matches = [...output.matchAll(/^\s*MachineGuid\s+REG_SZ\s+([^\r\n]+?)\s*$/gim)];
  if (matches.length !== 1) return null;
  const value = matches[0]?.[1];
  return value ? normalizeUuid(value) : null;
}

function parseMacPlatformUuid(output: string): string | null {
  const matches = [...output.matchAll(/^\s*"IOPlatformUUID"\s*=\s*"([^"]+)"\s*$/gm)];
  if (matches.length !== 1) return null;
  const value = matches[0]?.[1];
  return value ? normalizeUuid(value) : null;
}

async function readLinuxMachineId(readFile: MachineIdentityReadFile): Promise<string | null> {
  for (const file of MACHINE_ID_FILES) {
    try {
      const value = normalizeUuid(await readFile(file));
      if (value) return value;
    } catch {
      // Try the other fixed OS machine-id location without exposing the error or file contents.
    }
  }
  return null;
}

/** Reads an OS-managed machine anchor without writing it or returning it outside main. */
export async function readMachineIdentityAnchor(
  dependencies: MachineIdentityDependencies = {},
): Promise<string | null> {
  const osPlatform = dependencies.platform ?? process.platform;
  const execFile = dependencies.execFile ?? executeFile;
  const readFile = dependencies.readFile ?? ((file) => nodeReadFile(file, 'utf8'));

  if (osPlatform === 'linux') return readLinuxMachineId(readFile);

  if (osPlatform === 'win32') {
    const systemRoot = dependencies.systemRoot ?? process.env.SystemRoot;
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return null;
    const executable = path.win32.join(systemRoot, 'System32', 'reg.exe');
    try {
      const output = await execFile(
        executable,
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        EXEC_OPTIONS,
      );
      return parseWindowsMachineGuid(output);
    } catch {
      return null;
    }
  }

  if (osPlatform === 'darwin') {
    try {
      const output = await execFile(
        '/usr/sbin/ioreg',
        ['-rd1', '-c', 'IOPlatformExpertDevice'],
        EXEC_OPTIONS,
      );
      return parseMacPlatformUuid(output);
    } catch {
      return null;
    }
  }

  return null;
}
