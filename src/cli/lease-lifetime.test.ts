import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('built lease CLI exits while the synthetic emulator remains alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emu-lease-lifetime-'));
  const image = join(
    root,
    'sdk',
    'system-images',
    'android-36',
    'google_apis_playstore',
    'x86_64',
  );
  const pidFile = join(root, 'child.pid');
  const preload = join(root, 'preload.mjs');
  let pid = 0;
  try {
    await mkdir(image, { recursive: true });
    await writeFile(join(image, 'source.properties'), 'Pkg.Revision=7\n');
    await writeFile(
      join(root, 'android-kit.yaml'),
      `emuLab:\n  budget: 1\n  sdkRoot: ${JSON.stringify(join(root, 'sdk'))}\n`,
    );
    await writeFile(
      preload,
      `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
const spawn = childProcess.spawn;
childProcess.spawn = (file, args, options) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
  return child;
};
syncBuiltinESMExports();
const { Scheduler } = await import(${JSON.stringify(new URL('../core/scheduler.js', new URL(`file:///${resolve('dist/cli/index.js').replaceAll('\\', '/')}`)).href)});
Scheduler.prototype.checkCpuLoad = async () => {};
Scheduler.prototype.portFree = async () => true;
Scheduler.prototype.verified = async () => true;
Scheduler.prototype.emulatorChild = async (_row, launcher) => launcher;
Scheduler.prototype.command = async (_file, args) => args.includes('echo') ? 'ok' : args.includes('sys.boot_completed') ? '1' : args.includes('persist.sys.locale') ? 'en-US' : '';
`,
    );
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        'dist/cli/index.js',
        'lease-device',
        '--project-root',
        root,
        '--json',
      ],
      { encoding: 'utf8', timeout: 20000 },
    );
    expect(JSON.parse(output).status).toBe('pass');
    pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
  } finally {
    if (pid)
      try {
        process.kill(pid);
      } catch {}
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
