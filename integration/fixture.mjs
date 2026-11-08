import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.AK_INTEGRATION !== '1') {
  console.log('Set AK_INTEGRATION=1 to run the emulator fixture integration.');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = resolve(root, '../kit-fixture-app');
const { Scheduler, defaultProfiles } = await import(
  '../dist/core/scheduler.js'
);
const { install, logcat, runInstrumentation, runMaestro } = await import(
  '../dist/core/runners.js'
);
const { classifyFailure } = await import('../dist/core/classifier.js');
const { build } = await import('../dist/core/build.js');
const { runArtifactDir, writeArtifactIndex } = await import(
  '@budaknyenyel/kit-schema'
);
const runId = randomUUID();
const builds = {};
for (const flavor of ['clean', 'defects']) {
  const variant = `${flavor}Debug`;
  const first = await build({
    projectRoot: fixture,
    runId: `${runId}-${flavor}-first`,
    variant,
  });
  const second = await build({
    projectRoot: fixture,
    runId: `${runId}-${flavor}-cached`,
    variant,
  });
  assert.equal(second.cached, true, `${variant} second build must use cache`);
  assert.equal(second.cacheKey, first.cacheKey);
  const paths = second.artifacts.map((path) => resolve(fixture, path));
  const apk = paths.find(
    (path) => path.endsWith('.apk') && !/androidTest/i.test(path),
  );
  const testApk = paths.find(
    (path) => path.endsWith('.apk') && /androidTest/i.test(path),
  );
  assert.ok(apk && testApk, `${variant} must produce app and test APKs`);
  builds[flavor] = { apk, testApk };
}
const packageName = 'dev.androidkit.fixture';
const runner = `${packageName}.test/androidx.test.runner.AndroidJUnitRunner`;
const apk = (flavor) => builds[flavor].apk;
const testApk = (flavor) => builds[flavor].testApk;
const artifacts = runArtifactDir(fixture, runId, 'emu-lab');
const scratch = await mkdtemp(join(tmpdir(), 'emu-lab-integration-'));
const health = [],
  emulatorOutput = [];
const sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
const adb = sdkRoot
  ? join(
      sdkRoot,
      'platform-tools',
      process.platform === 'win32' ? 'adb.exe' : 'adb',
    )
  : 'adb';
const adbCommand = (lease, args) =>
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
const scheduler = new Scheduler({
  databasePath: join(scratch, 'lab.sqlite'),
  budget: 1,
  headless: true,
  bootTimeoutMs: 480_000,
  profiles: { diagnostic: { ...defaultProfiles.default, gpu: 'host' } },
  onHealth: (event) => health.push(event),
  onDiagnostics: (event) => emulatorOutput.push(event),
});
let lease;
let heartbeat;
try {
  lease = await scheduler.lease({
    profile: 'diagnostic',
    ttlMs: 60 * 60_000,
    heartbeatMs: 5 * 60_000,
  });
  heartbeat = setInterval(() => {
    void scheduler.heartbeat(lease.leaseId).catch(console.error);
  }, 60_000);
  const device = { leaseId: lease.leaseId, serial: lease.serial };
  const diagnosticDir = join(artifacts, 'diagnostics');
  await mkdir(diagnosticDir, { recursive: true });
  for (const [name, args] of [
    ['logcat', ['logcat', '-d', '-v', 'threadtime']],
    ['uptime', ['shell', 'uptime']],
    ['top', ['shell', 'top', '-b', '-n', '1']],
  ]) {
    const result = await adbCommand(lease, args);
    await writeFile(
      join(diagnosticDir, `${name}.txt`),
      result.stdout + result.stderr,
    );
    assert.equal(result.code, 0, `${name} failed: ${result.stderr}`);
    if (name === 'logcat')
      await writeFile(
        join(diagnosticDir, 'renderer.txt'),
        result.stdout
          .split(/\r?\n/)
          .filter((line) =>
            /renderer|gles|swiftshader|opengl|vulkan/i.test(line),
          )
          .join('\n'),
      );
  }
  const snapshotName = `integration-${runId}`;
  const snapshotResults = {};
  for (const action of ['save', 'list', 'load']) {
    snapshotResults[action] = await scheduler.snapshot(
      lease.leaseId,
      lease.serial,
      action,
      action === 'list' ? undefined : snapshotName,
    );
    await writeFile(
      join(diagnosticDir, 'snapshot.json'),
      JSON.stringify(snapshotResults, null, 2),
    );
    if (action === 'list')
      assert.ok(
        snapshotResults.list.includes(snapshotName),
        'Saved snapshot missing from snapshot list',
      );
  }
  const base = {
    ...device,
    packageName,
    artifactDir: join(artifacts, 'clean'),
    maestro: process.env.MAESTRO_PATH,
  };
  await install(scheduler, { ...device, packageName, apk: apk('clean') });
  const clean = await runInstrumentation(scheduler, {
    ...base,
    runner,
    testApk: testApk('clean'),
  });
  assert.equal(
    clean.status,
    'pass',
    `Clean instrumentation: ${JSON.stringify(clean)}`,
  );
  assert.ok(clean.count > 0, 'Clean instrumentation ran no tests');
  const launch = await runMaestro(scheduler, {
    ...base,
    flows: [join(fixture, 'e2e', 'maestro', '01-launch.yaml')],
  });
  assert.equal(
    launch.status,
    'pass',
    `Clean Maestro: ${JSON.stringify(launch)}`,
  );

  await install(scheduler, { ...device, packageName, apk: apk('defects') });
  const leak = await runInstrumentation(scheduler, {
    ...base,
    artifactDir: join(artifacts, 'state-leak'),
    runner,
    testApk: testApk('defects'),
    filter: 'dev.androidkit.fixture.StateLeakTest#testB_requiresPreviousTest',
  });
  assert.equal(
    leak.status,
    'fail',
    `State leak must fail in isolation: ${JSON.stringify(leak)}`,
  );
  const leakVerdict = classifyFailure({
    log: leak.output,
    resetExpected: true,
    artifacts: leak.artifacts,
    appPackage: packageName,
  });
  assert.equal(
    leakVerdict.classification,
    'test',
    `State leak classification: ${JSON.stringify(leakVerdict)}`,
  );

  const crashDir = join(artifacts, 'crash');
  await mkdir(crashDir, { recursive: true });
  const crashFlow = join(crashDir, 'crash.yaml');
  await writeFile(
    crashFlow,
    `appId: ${packageName}\n---\n- launchApp\n- assertVisible: "General"\n- tapOn:\n    point: "93%,8%"\n- assertVisible: "Language"\n- tapOn: "Crash test"\n- assertVisible: "Crash test"\n`,
  );
  const crash = await runMaestro(scheduler, {
    ...base,
    artifactDir: crashDir,
    flows: [crashFlow],
  });
  assert.equal(
    crash.status,
    'fail',
    `Crash flow must fail: ${JSON.stringify(crash)}`,
  );
  const logs = await logcat(scheduler, {
    ...device,
    path: join(crashDir, 'logcat.txt'),
  });
  assert.match(
    logs.output,
    /Synthetic crash/,
    'Expected fixture crash in logcat',
  );
  const crashVerdict = classifyFailure({
    log: logs.output,
    artifacts: [logs.path],
    appPackage: packageName,
  });
  assert.equal(
    crashVerdict.classification,
    'app',
    `Crash classification: ${JSON.stringify(crashVerdict)}`,
  );
  console.log('Fixture integration passed.');
} finally {
  clearInterval(heartbeat);
  try {
    if (lease) await scheduler.release(lease.leaseId);
  } finally {
    scheduler.close();
    const collect = async (directory) => {
      const files = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await collect(path)));
        else if (entry.isFile() && entry.name !== 'index.json')
          files.push(relative(fixture, path));
      }
      return files;
    };
    await mkdir(artifacts, { recursive: true });
    await mkdir(join(artifacts, 'diagnostics'), { recursive: true });
    await writeFile(
      join(artifacts, 'diagnostics', 'boot-health.json'),
      JSON.stringify(health, null, 2),
    );
    await writeFile(
      join(artifacts, 'diagnostics', 'emulator-output.json'),
      JSON.stringify(emulatorOutput, null, 2),
    );
    await writeArtifactIndex(
      fixture,
      runId,
      'emu-lab',
      await collect(artifacts),
    );
    await rm(scratch, { recursive: true, force: true });
  }
}
