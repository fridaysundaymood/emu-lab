import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { LabConfig } from './config.js';
import { defaultProfiles } from './scheduler.js';

const exec = promisify(execFile);
type Check = {
  tool: string;
  available: boolean;
  version: string;
  fix: string;
  path?: string;
};

async function command(file: string, args: string[]): Promise<string> {
  if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(file)) {
    if (/[%!"\r\n]/.test(file) || args.some((arg) => /[%!"\r\n]/.test(arg))) {
      throw new Error('Unsafe characters in batch command');
    }
    const line = `"${file}" ${args.map((arg) => `"${arg}"`).join(' ')}`;
    const result = await exec(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `"${line}"`],
      { timeout: 15000, windowsHide: true, windowsVerbatimArguments: true },
    );
    return `${result.stdout}\n${result.stderr}`.trim();
  }
  const result = await exec(file, args, { timeout: 15000, windowsHide: true });
  return `${result.stdout}\n${result.stderr}`.trim();
}
/** Supported Maestro CLI range (inclusive); matches the documented contract for device workflows. */
export function maestroVersionSupported(output: string): boolean {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(output);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major === 2 && minor >= 11 && minor <= 12;
}

export async function maestroExecutable(config: LabConfig): Promise<string> {
  if (config.maestroPath) return config.maestroPath;
  if (process.env.MAESTRO_BIN) return process.env.MAESTRO_BIN;
  const name = process.platform === 'win32' ? 'maestro.bat' : 'maestro';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return join(homedir(), '.maestro', 'maestro', 'bin', name);
}

async function checkCommand(
  tool: string,
  file: string,
  args: string[],
  fix: string,
  matches: (output: string) => boolean = () => true,
): Promise<Check> {
  try {
    const output = await command(file, args);
    const available = matches(output);
    return {
      tool,
      available,
      version: output.split(/\r?\n/)[0] ?? '',
      fix: available ? '' : fix,
    };
  } catch {
    return { tool, available: false, version: '', fix };
  }
}

async function checkPackage(
  sdk: string | undefined,
  name: string,
  components: string[],
): Promise<Check> {
  const fix = `Install Android SDK package ${name} with sdkmanager and set ANDROID_SDK_ROOT.`;
  if (!sdk) return { tool: name, available: false, version: '', fix };
  try {
    const properties = await readFile(
      join(sdk, ...components, 'source.properties'),
      'utf8',
    );
    const version = /^Pkg\.Revision\s*=\s*(\S+)/m.exec(properties)?.[1] ?? '';
    if (!version)
      return {
        tool: name,
        available: false,
        version,
        fix: `${fix} Package revision is missing from source.properties.`,
      };
    if (
      name === 'system-images;android-36;google_apis_playstore;x86_64' &&
      version !== '7'
    ) {
      return {
        tool: name,
        available: false,
        version,
        fix: `Install ${name} revision 7; detected ${version}.`,
      };
    }
    if (name === 'emulator-package') {
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
      const parts = match?.slice(1).map(Number);
      const minimum = [35, 4, 9];
      const compatible =
        (parts !== undefined &&
          parts.some(
            (part, index) =>
              part > minimum[index]! &&
              parts
                .slice(0, index)
                .every((previous, i) => previous === minimum[i]),
          )) ||
        parts?.every((part, index) => part === minimum[index]);
      if (!compatible)
        return {
          tool: name,
          available: false,
          version,
          fix: `Install Android emulator revision 35.4.9 or newer; detected ${version}.`,
        };
    }
    return { tool: name, available: true, version, fix: '' };
  } catch {
    return { tool: name, available: false, version: '', fix };
  }
}

export async function doctor(
  config: LabConfig,
): Promise<{ checks: Check[]; status: 'pass' | 'blocked' }> {
  const sdk =
    config.sdkRoot ?? process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
  const bin = (dir: string, name: string) =>
    sdk
      ? join(sdk, dir, process.platform === 'win32' ? `${name}.exe` : name)
      : name;
  const emulator = bin('emulator', 'emulator');
  const images = [
    ...new Set(
      Object.values({ ...defaultProfiles, ...config.profiles }).map(
        (profile) => profile.image,
      ),
    ),
  ];
  const accelerationFix =
    process.platform === 'linux'
      ? 'Enable virtualization and grant the current user access to /dev/kvm.'
      : process.platform === 'win32'
        ? 'Enable hardware virtualization and install or enable Windows Hypervisor Platform or Android Emulator hypervisor driver.'
        : 'Enable hardware virtualization and run on a macOS host supporting Hypervisor.framework.';
  const maestro = await maestroExecutable(config);
  const checks = await Promise.all([
    checkCommand(
      'adb',
      config.adbPath ?? bin('platform-tools', 'adb'),
      ['version'],
      'Install Android SDK platform-tools and set ANDROID_SDK_ROOT.',
    ),
    checkCommand(
      'emulator',
      emulator,
      ['-version'],
      'Install the Android emulator SDK package and set ANDROID_SDK_ROOT.',
    ),
    checkCommand(
      'emulator-acceleration',
      emulator,
      ['-accel-check'],
      accelerationFix,
    ),
    checkCommand(
      'java',
      'java',
      ['-version'],
      'Install JDK 21 and put its java executable on PATH.',
      (output) =>
        /(?:version\s+"|openjdk\s+)(?:21)(?:[.\s+"-]|$)/i.test(output),
    ),
    checkCommand(
      'maestro',
      maestro,
      ['--version'],
      'Install Maestro 2.11.x or 2.12.x and make it available on PATH or at ~/.maestro/maestro/bin.',
      maestroVersionSupported,
    ).then((check) => ({ ...check, path: maestro })),
    checkPackage(sdk, 'platform-tools', ['platform-tools']),
    checkPackage(sdk, 'emulator-package', ['emulator']),
    checkPackage(sdk, 'cmdline-tools;latest', ['cmdline-tools', 'latest']),
    ...images.map((image) => checkPackage(sdk, image, image.split(';'))),
  ]);
  return {
    checks,
    status: checks.every((check) => check.available) ? 'pass' : 'blocked',
  };
}
