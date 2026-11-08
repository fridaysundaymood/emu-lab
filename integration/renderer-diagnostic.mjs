import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.AK_INTEGRATION !== '1') {
  console.log('Set AK_INTEGRATION=1 to run the emulator renderer diagnostic.');
  process.exit(0);
}
const mode = process.argv[2] ?? 'visible';
if (!['visible', 'headless', 'compare'].includes(mode))
  throw new Error('Usage: renderer-diagnostic.mjs [visible|headless|compare]');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { Scheduler, defaultProfiles } = await import(
  '../dist/core/scheduler.js'
);
const { runArtifactDir, writeArtifactIndex } = await import(
  '@budaknyenyel/kit-schema'
);
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
if (!sdk) throw new Error('Set ANDROID_SDK_ROOT or ANDROID_HOME');
const adb = join(
  sdk,
  'platform-tools',
  process.platform === 'win32' ? 'adb.exe' : 'adb',
);
const runId = randomUUID();
const output = runArtifactDir(root, runId, 'emu-lab');
await mkdir(output, { recursive: true });
const files = [];
const save = async (name, text) => {
  const path = join(output, name);
  await writeFile(path, text);
  files.push(relative(root, path));
};
const execute = (scheduler, lease, args) =>
  scheduler.withLease(lease.leaseId, lease.serial, (serial, signal) => {
    const { promise, resolve: finish, reject } = Promise.withResolvers();
    const child = spawn(adb, ['-s', serial, ...args], {
      windowsHide: true,
      signal,
    });
    const stdout = [],
      stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      finish({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    return promise;
  });
const failures = [];
try {
  for (const current of mode === 'compare' ? ['visible', 'headless'] : [mode]) {
    const scratch = await mkdtemp(join(tmpdir(), `emu-renderer-${current}-`));
    const events = [],
      diagnostics = [];
    const scheduler = new Scheduler({
      databasePath: join(scratch, 'lab.sqlite'),
      sdkRoot: sdk,
      budget: 1,
      bootTimeoutMs: 480_000,
      headless: current === 'headless',
      profiles: { diagnostic: { ...defaultProfiles.default, gpu: 'host' } },
      onHealth: (event) => events.push(event),
      onDiagnostics: (event) => diagnostics.push(event),
    });
    let lease;
    try {
      lease = await scheduler.lease({
        profile: 'diagnostic',
        ttlMs: 60 * 60_000,
        heartbeatMs: 10 * 60_000,
      });
      const log = await execute(scheduler, lease, [
        'logcat',
        '-d',
        '-v',
        'threadtime',
      ]);
      await save(`${current}-logcat.txt`, log.stdout + log.stderr);
      await save(
        `${current}-renderer.txt`,
        log.stdout
          .split(/\r?\n/)
          .filter((line) =>
            /renderer|gles|swiftshader|opengl|vulkan/i.test(line),
          )
          .join('\n'),
      );
      const uptime = await execute(scheduler, lease, ['shell', 'uptime']);
      await save(`${current}-uptime.txt`, JSON.stringify(uptime, null, 2));
      const top = await execute(scheduler, lease, [
        'shell',
        'top',
        '-b',
        '-n',
        '1',
      ]);
      await save(`${current}-top.txt`, JSON.stringify(top, null, 2));
      for (const [name, result] of [
        ['logcat', log],
        ['uptime', uptime],
        ['top', top],
      ]) {
        if (result.code !== 0)
          throw new Error(`${name} exited ${result.code}: ${result.stderr}`);
      }
    } catch (error) {
      failures.push(
        `${current}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        if (lease) await scheduler.release(lease.leaseId);
      } finally {
        scheduler.close();
        await save(`${current}-health.json`, JSON.stringify(events, null, 2));
        await save(
          `${current}-emulator-output.json`,
          JSON.stringify(diagnostics, null, 2),
        );
        await rm(scratch, { recursive: true, force: true });
      }
    }
  }
} finally {
  await writeArtifactIndex(root, runId, 'emu-lab', files);
}
console.log(`Renderer diagnostics: ${output}`);
if (failures.length) throw new Error(failures.join('\n'));
