import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMachineIdentityAnchor } from './machineIdentity.js';
import type { MachineIdentityExecFile, MachineIdentityExecOptions } from './machineIdentity.js';

describe('readMachineIdentityAnchor', () => {
  it('reads only the Windows MachineGuid using fixed hidden read-only command arguments', async () => {
    let invocation: { file: string; args: string[]; options: MachineIdentityExecOptions } | null = null;
    const execFile: MachineIdentityExecFile = async (file, args, options) => {
      invocation = { file, args, options };
      return [
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography',
        '    MachineGuid    REG_SZ    01234567-89AB-CDEF-0123-456789ABCDEF',
      ].join('\r\n');
    };

    await expect(
      readMachineIdentityAnchor({ platform: 'win32', systemRoot: 'C:\\Windows', execFile }),
    ).resolves.toBe('0123456789abcdef0123456789abcdef');
    expect(invocation).toEqual({
      file: path.win32.join('C:\\Windows', 'System32', 'reg.exe'),
      args: ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      options: {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
        shell: false,
      },
    });
  });

  it('rejects ambiguous, malformed, and all-zero Windows identifiers', async () => {
    const outputs = [
      'MachineGuid REG_SZ 01234567-89AB-CDEF-0123-456789ABCDEF\nMachineGuid REG_SZ 11234567-89AB-CDEF-0123-456789ABCDEF',
      'MachineGuid REG_SZ not-a-uuid',
      'MachineGuid REG_SZ 00000000-0000-0000-0000-000000000000',
      'OtherValue REG_SZ 01234567-89AB-CDEF-0123-456789ABCDEF',
    ];
    for (const output of outputs) {
      await expect(
        readMachineIdentityAnchor({
          platform: 'win32',
          systemRoot: 'C:\\Windows',
          execFile: async () => output,
        }),
      ).resolves.toBeNull();
    }
  });

  it('reads the macOS IOPlatformUUID from a fixed bounded command', async () => {
    let invocation: { file: string; args: string[]; options: MachineIdentityExecOptions } | null = null;
    const execFile: MachineIdentityExecFile = async (file, args, options) => {
      invocation = { file, args, options };
      return '    "IOPlatformUUID" = "01234567-89ab-cdef-0123-456789abcdef"\n';
    };

    await expect(readMachineIdentityAnchor({ platform: 'darwin', execFile })).resolves.toBe(
      '0123456789abcdef0123456789abcdef',
    );
    expect(invocation).toEqual({
      file: '/usr/sbin/ioreg',
      args: ['-rd1', '-c', 'IOPlatformExpertDevice'],
      options: {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
        shell: false,
      },
    });
  });

  it('rejects ambiguous macOS identifiers and command failures without exposing output', async () => {
    await expect(
      readMachineIdentityAnchor({
        platform: 'darwin',
        execFile: async () =>
          '"IOPlatformUUID" = "01234567-89ab-cdef-0123-456789abcdef"\n"IOPlatformUUID" = "11234567-89ab-cdef-0123-456789abcdef"',
      }),
    ).resolves.toBeNull();
    await expect(
      readMachineIdentityAnchor({
        platform: 'darwin',
        execFile: async () => {
          throw new Error('private command output');
        },
      }),
    ).resolves.toBeNull();
  });

  it('reads a valid Linux machine-id from fixed paths and rejects invalid values', async () => {
    const visited: string[] = [];
    await expect(
      readMachineIdentityAnchor({
        platform: 'linux',
        readFile: async (file) => {
          visited.push(file);
          if (file === '/etc/machine-id') throw new Error('missing');
          return `${'A'.repeat(32)}\n`;
        },
      }),
    ).resolves.toBe('a'.repeat(32));
    expect(visited).toEqual(['/etc/machine-id', '/var/lib/dbus/machine-id']);

    await expect(
      readMachineIdentityAnchor({
        platform: 'linux',
        readFile: async () => '00000000000000000000000000000000',
      }),
    ).resolves.toBeNull();
  });

  it('fails closed for unsupported platforms and missing Windows system root', async () => {
    let calls = 0;
    const execFile: MachineIdentityExecFile = async () => {
      calls += 1;
      return '';
    };
    await expect(readMachineIdentityAnchor({ platform: 'freebsd', execFile })).resolves.toBeNull();
    await expect(
      readMachineIdentityAnchor({ platform: 'win32', systemRoot: 'relative', execFile }),
    ).resolves.toBeNull();
    expect(calls).toBe(0);
  });
});
