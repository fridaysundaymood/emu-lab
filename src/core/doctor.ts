import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LabConfig } from './config.js';

const exec = promisify(execFile);

export async function doctor(config: LabConfig): Promise<{
  checks: { tool: string; available: boolean; version: string; fix: string }[];
  status: 'pass' | 'blocked';
}> {
  const sdk =
    config.sdkRoot ?? process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const bin = (dir: string, name: string) =>
    sdk
      ? join(sdk, dir, process.platform === 'win32' ? `${name}.exe` : name)
      : name;
  const tools = [
    {
      tool: 'adb',
      command: config.adbPath ?? bin('platform-tools', 'adb'),
      args: ['version'],
      fix: 'Install Android SDK platform-tools and set ANDROID_HOME.',
    },
    {
      tool: 'emulator',
      command: bin('emulator', 'emulator'),
      args: ['-version'],
      fix: 'Install the Android emulator SDK package.',
    },
    {
      tool: 'java',
      command: 'java',
      args: ['-version'],
      fix: 'Install JDK 21 and make java available on PATH.',
    },
    {
      tool: 'maestro',
      command: config.maestroPath ?? 'maestro',
      args: ['--version'],
      fix: 'Install Maestro 2.12.x and make it available on PATH.',
    },
  ];
  const checks = await Promise.all(
    tools.map(async ({ tool, command, args, fix }) => {
      try {
        const { stdout, stderr } = await exec(command, args, {
          timeout: 15000,
          windowsHide: true,
        });
        const version = `${stdout}\n${stderr}`.trim().split(/\r?\n/)[0] ?? '';
        const available = tool !== 'maestro' || /\b2\.12\./.test(version);
        return { tool, available, version, fix: available ? '' : fix };
      } catch {
        return { tool, available: false, version: '', fix };
      }
    }),
  );
  return {
    checks,
    status: checks.every((check) => check.available) ? 'pass' : 'blocked',
  };
}
